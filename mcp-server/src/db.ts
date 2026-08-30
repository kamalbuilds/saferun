import pg from "pg";

const { Pool } = pg;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  /** Database that SafeRun treats as production. */
  productionDb: string;
}

export function loadConfig(): DbConfig {
  return {
    host: process.env.SAFERUN_PG_HOST ?? "127.0.0.1",
    port: Number(process.env.SAFERUN_PG_PORT ?? 5544),
    user: process.env.SAFERUN_PG_USER ?? "saferun",
    productionDb: process.env.SAFERUN_PG_PROD_DB ?? "pagila",
  };
}

const pools = new Map<string, pg.Pool>();

export function poolFor(cfg: DbConfig, database: string): pg.Pool {
  let pool = pools.get(database);
  if (!pool) {
    pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      database,
      max: 3,
    });
    pools.set(database, pool);
  }
  return pool;
}

/** Close a pool (needed before DROP DATABASE / cloning from template). */
export async function closePool(database: string): Promise<void> {
  const pool = pools.get(database);
  if (pool) {
    pools.delete(database);
    await pool.end();
  }
}

export interface TableFingerprint {
  table: string;
  rowCount: number;
  /** MD5 over all row contents, order-independent. Empty table -> "empty". */
  checksum: string;
}

/**
 * Fingerprint every user table: exact row count + order-independent MD5
 * checksum of the full row contents. Two databases with equal fingerprints
 * contain identical data.
 */
export async function fingerprintDatabase(
  cfg: DbConfig,
  database: string,
): Promise<TableFingerprint[]> {
  const pool = poolFor(cfg, database);
  const tables = await pool.query<{ schemaname: string; tablename: string }>(
    `SELECT schemaname, tablename FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY schemaname, tablename`,
  );
  const result: TableFingerprint[] = [];
  for (const { schemaname, tablename } of tables.rows) {
    const ident = `${quoteIdent(schemaname)}.${quoteIdent(tablename)}`;
    const res = await pool.query<{ n: string; checksum: string | null }>(
      `SELECT count(*)::text AS n,
              md5(string_agg(h, '' ORDER BY h)) AS checksum
       FROM (SELECT md5(t::text) AS h FROM ${ident} t) sub`,
    );
    result.push({
      table: `${schemaname}.${tablename}`,
      rowCount: Number(res.rows[0].n),
      checksum: res.rows[0].checksum ?? "empty",
    });
  }
  return result;
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll(`"`, `""`)}"`;
}

export interface FingerprintDiff {
  table: string;
  before: { rowCount: number; checksum: string };
  after: { rowCount: number; checksum: string };
  rowDelta: number;
  changed: boolean;
}

export function diffFingerprints(
  before: TableFingerprint[],
  after: TableFingerprint[],
): FingerprintDiff[] {
  const afterMap = new Map(after.map((f) => [f.table, f]));
  const diffs: FingerprintDiff[] = [];
  for (const b of before) {
    const a = afterMap.get(b.table) ?? { table: b.table, rowCount: 0, checksum: "dropped" };
    diffs.push({
      table: b.table,
      before: { rowCount: b.rowCount, checksum: b.checksum },
      after: { rowCount: a.rowCount, checksum: a.checksum },
      rowDelta: a.rowCount - b.rowCount,
      changed: a.checksum !== b.checksum,
    });
    afterMap.delete(b.table);
  }
  for (const a of afterMap.values()) {
    diffs.push({
      table: a.table,
      before: { rowCount: 0, checksum: "absent" },
      after: { rowCount: a.rowCount, checksum: a.checksum },
      rowDelta: a.rowCount,
      changed: true,
    });
  }
  return diffs;
}
