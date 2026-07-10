// Full, audited shell access — Caden's core "control over the Pi" tool.
// Governance model: no allowlist, no approval gate — every command runs.
// The only hardcoded restriction is a tiny, fixed deny list for a handful of
// literally irreversible self-destructive commands (formatting a disk,
// wiping root), so a hallucinated command can't brick the device Caden runs
// on. Everything else is unrestricted; the audit log is the real safety net.
import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { schema, ToolDef } from "../types.js";

const AUDIT_DIR = join(homedir(), ".caden");
const AUDIT_LOG = join(AUDIT_DIR, "audit.log");
const MAX_OUTPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 30_000;

export const auditEvents = new EventEmitter();

export interface AuditEntry {
  ts: string;
  command: string;
  cwd: string;
  status: "running" | "ok" | "error";
  exit_code?: number;
  output?: string;
}

async function appendAudit(entry: AuditEntry) {
  await mkdir(AUDIT_DIR, { recursive: true }).catch(() => {});
  await appendFile(AUDIT_LOG, JSON.stringify(entry) + "\n").catch(() => {});
  auditEvents.emit("entry", entry);
}

// Deliberately narrow — this is the one hardcoded governance rule, not a
// broad allowlist. See CLAUDE.md for why it exists and how to remove it.
const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|hd|mmcblk|nvme)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|$)/i,
  /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(\s|$)/i,
  />\s*\/dev\/(sd|hd|mmcblk|nvme)/i,
];

function isCatastrophic(command: string): boolean {
  return CATASTROPHIC_PATTERNS.some((re) => re.test(command));
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…(truncated)" : s;
}

async function runShell(command: string, cwd?: string, timeoutMs?: number) {
  if (typeof command !== "string" || !command.trim()) throw new Error("command must be a non-empty string");
  if (isCatastrophic(command)) {
    await appendAudit({ ts: new Date().toISOString(), command, cwd: cwd || process.cwd(), status: "error", output: "refused: matches the hardcoded catastrophic-command deny list" });
    throw new Error("Refused: this command matches the hardcoded catastrophic-command deny list (disk-format / root-wipe patterns).");
  }

  const workDir = cwd || process.cwd();
  const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 5 * 60_000);

  // Logged before execution so a crash mid-command still leaves a record.
  await appendAudit({ ts: new Date().toISOString(), command, cwd: workDir, status: "running" });

  return new Promise((resolve) => {
    execFile("/bin/bash", ["-lc", command], { cwd: workDir, timeout, maxBuffer: 10 * 1024 * 1024 }, async (err, stdout, stderr) => {
      const exitCode = (err as any)?.code ?? 0;
      const output = truncate([stdout, stderr].filter(Boolean).join("\n---stderr---\n"));
      await appendAudit({ ts: new Date().toISOString(), command, cwd: workDir, status: err ? "error" : "ok", exit_code: typeof exitCode === "number" ? exitCode : undefined, output });
      resolve({ exit_code: typeof exitCode === "number" ? exitCode : -1, output, timed_out: (err as any)?.killed === true });
    });
  });
}

export const shellTools: ToolDef[] = [
  {
    schema: schema(
      "run_shell",
      "Run a shell command on the Pi you live on, as the configured user. Full access — file operations, package management, service control, anything a normal shell command can do. Every call is logged to the audit trail. Returns exit code and combined stdout/stderr (truncated if long).",
      {
        command: { type: "string", description: "the shell command to run" },
        cwd: { type: "string", description: "working directory, defaults to Caden's own directory" },
        timeout_ms: { type: "number", description: "max time to allow, default 30000, capped at 300000" },
      },
      ["command"],
    ),
    handler: async (args) => runShell(String(args.command ?? ""), args.cwd ? String(args.cwd) : undefined, args.timeout_ms),
  },
];

export { AUDIT_LOG };
