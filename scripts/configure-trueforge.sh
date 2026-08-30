#!/usr/bin/env bash
# Wire SafeRun into a locally running TrueForge (http://localhost:8790).
# Requires: OPENROUTER_API_KEY (or edit the provider below), DAYTONA_API_KEY.
set -euo pipefail

TF=${TF:-http://localhost:8790}

echo "== model provider (OpenRouter, free tool-calling model)"
# Secrets are piped via stdin (--data @-), never exposed in argv.
jq -n --arg key "$OPENROUTER_API_KEY" '{manifest:{type:"custom",name:"openrouter",base_url:"https://openrouter.ai/api/v1",auth:{api_key:$key},models:[{model_id:"minimax/minimax-m3:free",name:"minimax-m3",properties:{context_length:200000,max_output_tokens:16000}}]}}' \
  | curl -sf -X POST "$TF/api/v1/settings/model-providers" -H 'Content-Type: application/json' --data @- > /dev/null && echo ok

echo "== Daytona sandbox provider"
jq -n --arg key "$DAYTONA_API_KEY" '{manifest:{type:"daytona",auth:{api_key:$key},exec_timeout_ms:120000,auto_stop_interval_in_minutes:15,auto_archive_interval_in_minutes:60,auto_delete_interval_in_minutes:120}}' \
  | curl -sf -X PUT "$TF/api/v1/settings/sandbox-providers" -H 'Content-Type: application/json' --data @- > /dev/null && echo ok

echo "== saferun-db MCP connector"
curl -sf -X POST "$TF/api/v1/settings/mcp-servers" -H 'Content-Type: application/json' -d '{
 "manifest": {"type": "remote", "name": "saferun-db", "url": "http://127.0.0.1:8931/mcp", "description": "SafeRun blast-radius engine: inspect production Postgres, simulate destructive SQL in an isolated clone, verify rollback restores data, and execute only verified operations."}}' > /dev/null && echo ok

echo "== dangerous-ops skill"
curl -sf -X POST "$TF/api/v1/settings/skills" -H 'Content-Type: application/json' -d '{
 "manifest": {"type": "git", "name": "dangerous-ops", "url": "https://github.com/kamalbuilds/saferun", "path": "skills/dangerous-ops", "ref": "main", "description": "Safety protocol for destructive database operations: simulate in a clone, verify rollback, require human approval before touching production."}}' > /dev/null && echo ok

echo "== saferun agent"
curl -sf -X POST "$TF/api/v1/agents" -H 'Content-Type: application/json' -d '{
 "name": "saferun",
 "manifest": {
   "model": {"name": "openrouter/minimax-m3"},
   "instructions": "You are SafeRun, a database guardian agent. You stand between humans (and other AI agents) and irreversible database damage. For ANY destructive request (DELETE, UPDATE, DROP, TRUNCATE, migrations) you follow the dangerous-ops skill protocol: inspect first, simulate the operation AND its rollback in an isolated clone, verify the rollback restores every table checksum, present a blast-radius report, and only execute after explicit human approval. You never touch production without a verified simulation and an approval. For wide investigations, delegate read-only analysis to subagents. Use the sandbox to write and run analysis code when data processing is needed.",
   "mcp_servers": [{"name": "saferun-db", "require_approval_for_tools": ["execute_approved_operation"]}],
   "skills": [{"name": "dangerous-ops"}],
   "config": {"sandbox": {"enabled": true}, "dynamic_sub_agents": {"enabled": true}}
 }}' > /dev/null && echo ok

echo "Done. Open $TF and start a session with the saferun agent."
