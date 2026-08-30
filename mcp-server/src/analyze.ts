/**
 * analyze.ts — static (read-only) SQL risk analyzer.
 *
 * Given a SQL string, parses it with regex-based heuristics (after stripping
 * comments), queries information_schema for FK relationships (schema-qualified),
 * and returns a RiskReport without executing anything.
 *
 * Fixes applied (Qodo review):
 *  1. Leading comments/CTE don't hide DML — stripSqlComments() + first-DML scan.
 *  2. WHERE inside comments doesn't count — WHERE check runs on stripped text.
 *  4. FK query is schema-qualified (public.film_actor, not just film_actor).
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
  schema: string;
  referencedTable: string;
  referencedSchema: string;
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
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Strip SQL block comments (/* ... *\/) and line comments (-- ...) from a SQL
 * string, preserving string literals intact.
 * The result has the same semicolon structure as the original.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < sql.length) {
    // Inside a single-quoted literal — only escape sequence that matters is ''
    if (inSingle) {
      if (sql[i] === "'" && sql[i + 1] === "'") {
        out += "''";
        i += 2;
      } else if (sql[i] === "'") {
        out += "'";
        i++;
        inSingle = false;
      } else {
        out += sql[i++];
      }
      continue;
    }
    // Inside a double-quoted identifier
    if (inDouble) {
      if (sql[i] === '"' && sql[i + 1] === '"') {
        out += '""';
        i += 2;
      } else if (sql[i] === '"') {
        out += '"';
        i++;
        inDouble = false;
      } else {
        out += sql[i++];
      }
      continue;
    }
    // Block comment
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        // Replace comment content with spaces to preserve offsets/semicolons
        out += " ";
        i++;
      }
      i += 2; // consume */
      out += " ";
      continue;
    }
    // Line comment
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i++;
      }
      // Preserve the newline
      if (i < sql.length) out += sql[i++];
      continue;
    }
    // String/ident start
    if (sql[i] === "'") { inSingle = true; out += sql[i++]; continue; }
    if (sql[i] === '"') { inDouble = true; out += sql[i++]; continue; }

    out += sql[i++];
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQL statement parsing helpers
// ---------------------------------------------------------------------------

/** Split a multi-statement SQL string into individual statements. */
function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; }
    else if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; }
    else if (ch === ";" && !inSingle && !inDouble) {
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

/**
 * Extract the top-level DML/DDL statement type.
 *
 * Handles:
 *  - Leading block/line comments (already stripped by caller)
 *  - CTEs: WITH ... DELETE/UPDATE/INSERT/SELECT → returns the actual DML type
 *
 * Strategy: scan tokens; skip WITH and its (comma-separated parenthesised CTE
 * bodies), then read the first real keyword.
 */
function statementType(stripped: string): string {
  const tokens = stripped.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "other";

  const first = tokens[0].toUpperCase();
  if (first !== "WITH") return first || "other";

  // CTE: skip past balanced parentheses to find the actual DML keyword.
  // Simple heuristic: find the last ')' that closes the CTE block, then read
  // the next token.
  let depth = 0;
  let inStr = false;
  let pastCTE = false;
  const s = stripped.trim();
  let idx = 0;
  while (idx < s.length) {
    const ch = s[idx];
    if (!inStr && ch === "'") { inStr = true; idx++; continue; }
    if (inStr && ch === "'" && s[idx + 1] === "'") { idx += 2; continue; }
    if (inStr && ch === "'") { inStr = false; idx++; continue; }
    if (!inStr && ch === "(") { depth++; }
    else if (!inStr && ch === ")") {
      depth--;
      if (depth === 0) {
        // May be followed by , (more CTEs) or whitespace + DML keyword
        idx++;
        // skip optional comma + whitespace
        while (idx < s.length && /[\s,]/.test(s[idx])) idx++;
        // Peek: if next char is '(' we have another CTE body, loop
        if (idx < s.length && s[idx] !== "(") {
          pastCTE = true;
          break;
        }
        continue;
      }
    }
    idx++;
  }
  if (!pastCTE) return "WITH";
  const rest = s.slice(idx).trimStart().split(/\s+/)[0]?.toUpperCase();
  return rest || "WITH";
}

/**
 * Extract table names referenced in a SQL statement.
 * Handles FROM/JOIN/INTO/UPDATE/TABLE/TRUNCATE patterns.
 */
function extractTables(stripped: string): string[] {
  const normalized = stripped.replace(/\s+/g, " ");
  const tables = new Set<string>();

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

/** True if the stripped statement has a WHERE clause. */
function hasWhere(stripped: string): boolean {
  return /\bWHERE\b/i.test(stripped);
}

function analyzeStatement(raw: string, stripped: string): StatementRisk {
  const type = statementType(stripped);
  const tablesReferenced = extractTables(stripped);
  const wherePresent = hasWhere(stripped);
  const bareDestructive =
    (type === "DELETE" || type === "UPDATE") && !wherePresent;

  return {
    statement: raw,
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
  const adjusted = score + Math.min(fkCount * 5, 20);
  if (adjusted >= 55) return "F";
  if (adjusted >= 40) return "D";
  if (adjusted >= 25) return "C";
  if (adjusted >= 10) return "B";
  return "A";
}

// ---------------------------------------------------------------------------
// FK lookup — schema-qualified (fix #4)
// ---------------------------------------------------------------------------

/**
 * Parse a potentially schema-qualified table name like "public.film_actor" or
 * just "film_actor". Returns { schema, table }.
 */
function parseSchemaTable(name: string): { schema: string; table: string } {
  const parts = name.split(".");
  if (parts.length >= 2) {
    return { schema: parts[0], table: parts[1] };
  }
  return { schema: "public", table: parts[0] };
}

async function queryFkRelationships(
  cfg: DbConfig,
  tables: string[],
): Promise<FkRelationship[]> {
  if (tables.length === 0) return [];

  const parsed = tables.map(parseSchemaTable);
  // Build arrays for unnest: parallel arrays of schemas + table names
  const schemas = parsed.map((p) => p.schema);
  const names = parsed.map((p) => p.table);

  const pool = poolFor(cfg, cfg.productionDb);
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const res = await client.query<{
      table_schema: string;
      table_name: string;
      referenced_schema: string;
      referenced_table: string;
      constraint_name: string;
      columns: string;
      referenced_columns: string;
    }>(
      `SELECT
         tc.table_schema,
         tc.table_name,
         ccu.table_schema AS referenced_schema,
         ccu.table_name   AS referenced_table,
         tc.constraint_name,
         string_agg(DISTINCT kcu.column_name, ', ') AS columns,
         string_agg(DISTINCT ccu.column_name, ', ') AS referenced_columns
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema    = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema    = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
         AND (
               EXISTS (
                 SELECT 1 FROM unnest($1::text[], $2::text[]) AS t(s, n)
                 WHERE tc.table_schema = t.s AND tc.table_name = t.n
               )
               OR EXISTS (
                 SELECT 1 FROM unnest($1::text[], $2::text[]) AS t(s, n)
                 WHERE ccu.table_schema = t.s AND ccu.table_name = t.n
               )
         )
       GROUP BY tc.table_schema, tc.table_name, ccu.table_schema, ccu.table_name, tc.constraint_name
       ORDER BY tc.table_schema, tc.table_name, ccu.table_name`,
      [schemas, names],
    );
    await client.query("COMMIT");
    return res.rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      referencedSchema: r.referenced_schema,
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
  // Strip comments once; use the stripped version for classification + WHERE.
  const strippedWhole = stripSqlComments(sql);

  const rawStmts = splitStatements(sql);
  const strippedStmts = splitStatements(strippedWhole);

  const statements = rawStmts.map((raw, i) =>
    analyzeStatement(raw, strippedStmts[i] ?? raw),
  );

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
