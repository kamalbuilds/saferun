/**
 * audit.ts — append-only JSON-line audit log for SafeRun events.
 *
 * Events: simulate, execute, refusal, analyze
 * Path: SAFERUN_AUDIT_LOG env (default ./audit.log), relative to CWD.
 *
 * Fixes applied (Qodo review):
 *  6. Bounded tail read (last 256 KB) + 5 MB rotation (.1 suffix).
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES = 5 * 1024 * 1024;   // 5 MB: rotate when exceeded
const TAIL_READ_BYTES = 256 * 1024;       // 256 KB: max bytes read for tail

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

export function auditLogPath(): string {
  const env = process.env.SAFERUN_AUDIT_LOG;
  if (env) return path.resolve(env);
  return path.resolve("audit.log");
}

/**
 * Rotate the log file if it exceeds MAX_LOG_BYTES:
 * rename current → .1 (overwriting any previous .1), then start fresh.
 * Called synchronously inside appendAuditEvent — fast enough since stat() is O(1).
 */
function maybeRotate(p: string): void {
  try {
    const stat = fs.statSync(p);
    if (stat.size >= MAX_LOG_BYTES) {
      fs.renameSync(p, p + ".1");
    }
  } catch {
    // File doesn't exist yet, or stat failed — nothing to rotate
  }
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
  const p = auditLogPath();
  try {
    maybeRotate(p);
    fs.appendFileSync(p, line);
  } catch (err) {
    console.error("[audit] write error:", (err as Error).message);
  }
}

/**
 * Return the last N lines of the audit log parsed as AuditEvent[].
 * Reads at most TAIL_READ_BYTES from the end of the file (efficient for large logs).
 * Skips malformed lines silently. Returns [] when the log does not exist.
 */
export function readAuditLog(n = 50): AuditEvent[] {
  const p = auditLogPath();
  let raw: string;
  try {
    const stat = fs.statSync(p);
    const fileSize = stat.size;
    const readFrom = Math.max(0, fileSize - TAIL_READ_BYTES);
    const buf = Buffer.alloc(Math.min(TAIL_READ_BYTES, fileSize));
    const fd = fs.openSync(p, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, readFrom);
    } finally {
      fs.closeSync(fd);
    }
    raw = buf.toString("utf8");
    // If we started mid-line, drop the first (potentially partial) line
    if (readFrom > 0) {
      const nl = raw.indexOf("\n");
      raw = nl >= 0 ? raw.slice(nl + 1) : "";
    }
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
