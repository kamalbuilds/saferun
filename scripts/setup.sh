#!/usr/bin/env bash
# SafeRun local setup: real Postgres 17 + Pagila dataset + MCP server + TrueForge wiring.
set -euo pipefail

PG17=${PG17:-/opt/homebrew/opt/postgresql@17/bin}
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
