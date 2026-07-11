// Self-awareness: real vitals about the machine Caden lives on, so "how are
// you doing" / "check your temperature" gets an actual answer instead of a
// guess or a fumbled shell command. Built as a dedicated structured tool
// (not left to run_shell) because parsing `vcgencmd`/`df` output correctly
// through a text-only tool call is exactly the kind of thing a model
// otherwise gets subtly wrong.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { schema, ToolDef } from "../types.js";

const execFileAsync = promisify(execFile);

async function cpuTempC(): Promise<number | null> {
  try {
    const raw = await readFile("/sys/class/thermal/thermal_zone0/temp", "utf8");
    return Math.round((parseInt(raw.trim(), 10) / 1000) * 10) / 10;
  } catch {
    try {
      const { stdout } = await execFileAsync("vcgencmd", ["measure_temp"]);
      const m = stdout.match(/([\d.]+)/);
      return m ? Math.round(parseFloat(m[1]) * 10) / 10 : null;
    } catch {
      return null;
    }
  }
}

async function diskUsage(): Promise<{ total_gb: number; used_gb: number; available_gb: number; used_pct: number } | null> {
  try {
    const { stdout } = await execFileAsync("df", ["-k", "/"]);
    const lines = stdout.trim().split("\n");
    const parts = lines[lines.length - 1].trim().split(/\s+/);
    const totalKb = parseInt(parts[1], 10);
    const usedKb = parseInt(parts[2], 10);
    const availKb = parseInt(parts[3], 10);
    if (!totalKb) return null;
    const toGb = (kb: number) => Math.round((kb / 1024 / 1024) * 10) / 10;
    return { total_gb: toGb(totalKb), used_gb: toGb(usedKb), available_gb: toGb(availKb), used_pct: Math.round((usedKb / totalKb) * 100) };
  } catch {
    return null;
  }
}

async function systemStatus() {
  const [cpu_temp_c, disk] = await Promise.all([cpuTempC(), diskUsage()]);
  const totalMemGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const freeMemGb = Math.round((os.freemem() / 1024 ** 3) * 10) / 10;
  return {
    hostname: os.hostname(),
    cpu_temp_c,
    load_avg_1_5_15: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memory: { total_gb: totalMemGb, free_gb: freeMemGb, used_pct: Math.round(((totalMemGb - freeMemGb) / totalMemGb) * 100) },
    disk,
    system_uptime_s: Math.round(os.uptime()),
  };
}

export const systemTools: ToolDef[] = [
  {
    schema: schema(
      "system_status",
      "Check this machine's own vitals: CPU temperature, memory usage, disk usage, load average, and system uptime. Use this when asked how you're doing, whether you're overheating or under load, or before/after something resource-heavy.",
      {},
    ),
    handler: async () => systemStatus(),
  },
];
