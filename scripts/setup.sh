#!/usr/bin/env bash
# SafeRun local setup: real Postgres 17 + Pagila dataset + MCP server + TrueForge wiring.
set -euo pipefail

# Locate PostgreSQL 17 binaries: PATH first, common Homebrew/Linux paths as fallback.
if [ -z "${PG17:-}" ]; then
  for cand in "$(dirname "$(command -v initdb 2>/dev/null)" 2>/dev/null)" \
              /opt/homebrew/opt/postgresql@17/bin \
              /usr/local/opt/postgresql@17/bin \
              /usr/lib/postgresql/17/bin; do
    if [ -n "$cand" ] && [ -x "$cand/initdb" ]; then PG17="$cand"; break; fi
  done
fi
if [ -z "${PG17:-}" ] || [ ! -x "$PG17/initdb" ]; then
  echo "PostgreSQL 17 binaries not found. Install postgresql@17 or set PG17=/path/to/pg17/bin" >&2
  exit 1
fi
PGDATA=${PGDATA:-$PWD/.pgdata}
PORT=${SAFERUN_PG_PORT:-5544}

if [ ! -d "$PGDATA" ]; then
  "$PG17/initdb" -D "$PGDATA" -U saferun --auth=trust -E UTF8
fi
"$PG17/pg_ctl" -D "$PGDATA" -o "-p $PORT -k /tmp" -l /tmp/saferun-pg.log start || true

"$PG17/psql" -h 127.0.0.1 -p "$PORT" -U saferun -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='pagila'" | grep -q 1 || {
  "$PG17/psql" -h 127.0.0.1 -p "$PORT" -U saferun -d postgres -c "CREATE DATABASE pagila"
  curl -sL -o /tmp/pagila-schema.sql https://raw.githubusercontent.com/devrimgunduz/pagila/v2.1.0/pagila-schema.sql
  curl -sL -o /tmp/pagila-data.sql https://raw.githubusercontent.com/devrimgunduz/pagila/v2.1.0/pagila-data.sql
  "$PG17/psql" -h 127.0.0.1 -p "$PORT" -U saferun -d pagila -q -f /tmp/pagila-schema.sql
  "$PG17/psql" -h 127.0.0.1 -p "$PORT" -U saferun -d pagila -q -f /tmp/pagila-data.sql
}

cd mcp-server && npm install && npm run dev
