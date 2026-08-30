/**
 * analyze.ts — static (read-only) SQL risk analyzer.
 *
 * Given a SQL string, parses it with regex-based heuristics, queries
 * information_schema for FK relationships, and returns a RiskReport without
 * executing anything.
 */

import type { DbConfig } from "./db.js";
import { poolFor } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskGrade = "A" | "B" | "C" | "D" | "F";

export interface StatementRisk {
  statement: string;
  /** Normalised statement type: SELECT, DELETE, UPDATE, DROP, TRUNCATE, INSERT, CREATE, ALTER, other */
  type: string;
  tablesReferenced: string[];
  hasWhereClause: boolean;
  /** True when the statement is a bare DELETE/UPDATE with no WHERE clause. */
  bareDestructive: boolean;
}

export interface FkRelationship {
  table: string;
  referencedTable: string;
  constraintName: string;
  columns: string;
  referencedColumns: string;
}

export interface RiskReport {
  sql: string;
  statements: StatementRisk[];
  fkRelationships: FkRelationship[];
  /** All unique table names touched by the SQL. */
  touchedTables: string[];
  riskFactors: string[];
  grade: RiskGrade;
}

// ---------------------------------------------------------------------------
// SQL statement parsing helpers
// ---------------------------------------------------------------------------

/** Split a multi-statement SQL string into individual statements. */
function splitStatements(sql: string): string[] {
  // Very simple split on semicolons outside of string literals.
  // Adequate for the DDL/DML patterns SafeRun accepts.
  const stmts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === ";" && !inSingle && !inDouble) {
      const trimmed = current.trim();
      if (trimmed) stmts.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) stmts.push(last);
  return stmts;
}

/** Extract the statement type keyword from a SQL statement. */
function statementType(stmt: string): string {
  const first = stmt.trimStart().split(/\s+/)[0].toUpperCase();
  return first || "other";
}

/**
 * Extract table names referenced in a SQL statement.
 * Handles FROM/JOIN/INTO/UPDATE/TABLE/TRUNCATE patterns.
 */
function extractTables(stmt: string): string[] {
  const normalized = stmt.replace(/\s+/g, " ");
  const tables = new Set<string>();

  // Patterns: FROM tbl, JOIN tbl, UPDATE tbl, INTO tbl, TRUNCATE tbl, TABLE tbl
  const patterns = [
    /(?:FROM|JOIN|UPDATE|INTO|TRUNCATE(?:\s+TABLE)?|TABLE)\s+("?[\w.]+"?)/gi,
    /(?:CREATE\s+(?:TABLE|DATABASE|INDEX|SEQUENCE)(?:\s+IF\s+NOT\s+EXISTS)?)\s+("?[\w.]+"?)/gi,
    /(?:DROP\s+(?:TABLE|DATABASE|INDEX|SEQUENCE)(?:\s+IF\s+EXISTS)?)\s+("?[\w.]+"?)/gi,
    /(?:ALTER\s+(?:TABLE|INDEX))\s+("?[\w.]+"?)/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized)) !== null) {
      const raw = m[1].replace(/"/g, "").trim();
      if (raw && raw.toLowerCase() !== "only") {
        tables.add(raw.toLowerCase());
      }
    }
  }

  return [...tables];
}

/** True if the statement appears to have a WHERE clause. */
function hasWhere(stmt: string): boolean {
  return /\bWHERE\b/i.test(stmt);
}

function analyzeStatement(stmt: string): StatementRisk {
  const type = statementType(stmt);
  const tablesReferenced = extractTables(stmt);
  const wherePresent = hasWhere(stmt);
  const bareDestructive =
    (type === "DELETE" || type === "UPDATE") && !wherePresent;

  return {
    statement: stmt,
    type,
    tablesReferenced,
    hasWhereClause: wherePresent,
    bareDestructive,
  };
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

interface ScoreAccum {
  score: number;
  factors: string[];
}

const DANGEROUS_TYPES = new Set(["DELETE", "DROP", "TRUNCATE", "UPDATE", "ALTER"]);
const DDL_TYPES = new Set(["DROP", "TRUNCATE", "CREATE", "ALTER"]);

function scoreStatement(sr: StatementRisk, acc: ScoreAccum): void {
  if (sr.bareDestructive) {
    acc.score += 55;
    acc.factors.push(
      `Bare ${sr.type} on [${sr.tablesReferenced.join(", ")}] with no WHERE clause — affects ALL rows`,
    );
  } else if (DANGEROUS_TYPES.has(sr.type)) {
    acc.score += 10;
    acc.factors.push(`${sr.type} on [${sr.tablesReferenced.join(", ")}]`);
  }
  if (DDL_TYPES.has(sr.type) && sr.type !== "CREATE") {
    acc.score += 15;
    acc.factors.push(`${sr.type} is a DDL operation — structural change`);
  }
}

function gradeFromScore(score: number, fkCount: number): RiskGrade {
  const adjusted = score + Math.min(fkCount * 5, 20); // FK penalty
  if (adjusted >= 55) return "F";
  if (adjusted >= 40) return "D";
  if (adjusted >= 25) return "C";
  if (adjusted >= 10) return "B";
  return "A";
}

// ---------------------------------------------------------------------------
// FK lookup
// ---------------------------------------------------------------------------

async function queryFkRelationships(
  cfg: DbConfig,
  tables: string[],
): Promise<FkRelationship[]> {
  if (tables.length === 0) return [];

  // Normalise: strip schema prefix for lookup
  const bare = tables.map((t) => t.split(".").pop() ?? t);

  const pool = poolFor(cfg, cfg.productionDb);
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const res = await client.query<{
      table_name: string;
      referenced_table: string;
      constraint_name: string;
      columns: string;
      referenced_columns: string;
    }>(
      `SELECT
         tc.table_name,
         ccu.table_name AS referenced_table,
         tc.constraint_name,
         string_agg(DISTINCT kcu.column_name, ', ') AS columns,
         string_agg(DISTINCT ccu.column_name, ', ') AS referenced_columns
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND (
           tc.table_name = ANY($1)
           OR ccu.table_name = ANY($1)
         )
         AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
       GROUP BY tc.table_name, ccu.table_name, tc.constraint_name
       ORDER BY tc.table_name, ccu.table_name`,
      [bare],
    );
    await client.query("COMMIT");
    return res.rows.map((r) => ({
      table: r.table_name,
      referencedTable: r.referenced_table,
      constraintName: r.constraint_name,
      columns: r.columns,
      referencedColumns: r.referenced_columns,
    }));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function analyzeOperation(
  cfg: DbConfig,
  sql: string,
): Promise<RiskReport> {
  const raw = splitStatements(sql);
  const statements = raw.map(analyzeStatement);

  const acc: ScoreAccum = { score: 0, factors: [] };
  for (const sr of statements) {
    scoreStatement(sr, acc);
  }

  const allTables = [...new Set(statements.flatMap((s) => s.tablesReferenced))];
  const fkRelationships = await queryFkRelationships(cfg, allTables);

  const grade = gradeFromScore(acc.score, fkRelationships.length);

  return {
    sql,
    statements,
    fkRelationships,
    touchedTables: allTables,
    riskFactors: acc.factors,
    grade,
  };
}
