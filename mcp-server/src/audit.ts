/**
 * audit.ts — append-only JSON-line audit log for SafeRun events.
 *
 * Events: simulate, execute, refusal, analyze
 * Path: SAFERUN_AUDIT_LOG env (default ./audit.log), relative to CWD.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditEventType = "simulate" | "execute" | "refusal" | "analyze";

export interface AuditEvent {
  ts: string;           // ISO timestamp
  event: AuditEventType;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function auditLogPath(): string {
  const env = process.env.SAFERUN_AUDIT_LOG;
  if (env) return path.resolve(env);
  return path.resolve("audit.log");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Append one event to the audit log synchronously. */
export function appendAuditEvent(event: AuditEventType, details: Record<string, unknown>): void {
  const entry: AuditEvent = {
    ts: new Date().toISOString(),
    event,
    details,
  };
  const line = JSON.stringify(entry) + "\n";
  try {
    fs.appendFileSync(auditLogPath(), line);
  } catch (err) {
    console.error("[audit] write error:", (err as Error).message);
  }
}

/**
 * Return the last N lines of the audit log parsed as AuditEvent[].
 * Skips malformed lines silently. Returns [] when the log does not exist.
 */
export function readAuditLog(n = 50): AuditEvent[] {
  const p = auditLogPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.slice(-n);
  const events: AuditEvent[] = [];
  for (const line of last) {
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}
