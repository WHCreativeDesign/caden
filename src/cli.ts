#!/usr/bin/env node
// A terminal chat client for a running Caden daemon — talks to the same
// /api/chat the web UI uses, styled with the same synthwave palette. Run
// with `npm run chat` (or `caden-chat` if scripts/install.sh symlinked it).
import * as readline from "node:readline";
import { loadDotEnvIfPresent } from "./env.js";

loadDotEnvIfPresent();

const CYAN = "\x1b[38;2;0;255;242m";
const MAGENTA = "\x1b[38;2;255;43;214m";
const VIOLET = "\x1b[38;2;139;92;246m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\x1b[2K\r";

const HOST = process.env.CADEN_HOST || `http://localhost:${process.env.PORT || 7777}`;
const AGENT_LABELS: Record<string, string> = { caden: "Caden", researcher: "Caden — Research", scout: "Caden — Scout" };

let agent: "caden" | "researcher" | "scout" = "caden";
let history: Array<{ role: string; content: string }> = [];

function banner() {
  console.log("");
  console.log(`  ${BOLD}${CYAN}C A D E N${RESET}  ${DIM}— terminal${RESET}`);
  console.log(`  ${DIM}${HOST}${RESET}`);
  console.log(`  ${DIM}/agent <caden|researcher|scout>  /new  /status  /quit${RESET}`);
  console.log("");
}

function printAssistant(text: string, thinking: string[], steps: Array<{ tool: string; arguments: string; result: string }>, err = false) {
  const color = err ? MAGENTA : CYAN;
  if (thinking.length || steps.length) {
    for (const line of thinking) console.log(`  ${DIM}· ${line}${RESET}`);
    for (const step of steps) console.log(`  ${DIM}· ${RESET}${VIOLET}${step.tool}${RESET}${DIM} ${step.arguments} → ${step.result.slice(0, 140)}${RESET}`);
  }
  console.log(`  ${BOLD}${color}${(AGENT_LABELS[agent] || "Caden").toUpperCase()}${RESET}`);
  console.log(`  ${text}`);
  console.log("");
}

async function callApi(path: string, body?: unknown) {
  const resp = await fetch(HOST + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((data as any).error || `request failed (${resp.status})`);
  return data;
}

async function ask(text: string) {
  history.push({ role: "user", content: text });
  process.stdout.write(`  ${DIM}thinking…${RESET}`);
  try {
    const data: any = await callApi("/api/chat", { agent, messages: history });
    process.stdout.write(CLEAR_LINE);
    const reply = data.reply || "(no reply)";
    history.push({ role: "assistant", content: reply });
    printAssistant(reply, data.thinking || [], data.steps || []);
  } catch (err) {
    process.stdout.write(CLEAR_LINE);
    history.pop();
    console.log(`  ${MAGENTA}error${RESET} — ${String((err as Error).message ?? err)}`);
    console.log("");
  }
}

async function showStatus() {
  try {
    const data: any = await callApi("/api/status");
    console.log(`  ${DIM}sha${RESET} ${data.update?.sha ?? "—"}   ${DIM}uptime${RESET} ${data.uptime_s ?? 0}s   ${DIM}browser${RESET} ${data.browser?.mode ?? "idle"}`);
    console.log(`  ${DIM}groq keys${RESET} ${data.providers?.groq?.available ?? 0}/${data.providers?.groq?.total ?? 0}   ${DIM}gemini keys${RESET} ${data.providers?.gemini?.available ?? 0}/${data.providers?.gemini?.total ?? 0}`);
  } catch (err) {
    console.log(`  ${MAGENTA}error${RESET} — ${String((err as Error).message ?? err)}`);
  }
  console.log("");
}

function prompt(rl: readline.Interface) {
  rl.setPrompt(`  ${CYAN}›${RESET} `);
  rl.prompt();
}

async function handleLine(rl: readline.Interface, raw: string): Promise<boolean> {
  const line = raw.trim();
  if (!line) return true;

  if (line === "/quit" || line === "/exit") return false;
  if (line === "/new") { history = []; console.log(`  ${DIM}cleared${RESET}\n`); return true; }
  if (line === "/status") { await showStatus(); return true; }
  if (line.startsWith("/agent")) {
    const next = line.split(/\s+/)[1];
    if (next && AGENT_LABELS[next]) { agent = next as typeof agent; console.log(`  ${DIM}switched to ${AGENT_LABELS[next]}${RESET}\n`); }
    else console.log(`  ${DIM}usage: /agent <caden|researcher|scout>${RESET}\n`);
    return true;
  }

  await ask(line);
  return true;
}

async function main() {
  banner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  prompt(rl);

  // Readline can emit several buffered 'line' events synchronously — before
  // an async handler for the first one even reaches its first `await` — so
  // piped/pasted multi-line input could otherwise race a later command
  // (e.g. /quit) past an in-flight request and exit mid-fetch. An explicit
  // queue, processed strictly one line at a time, avoids that regardless of
  // how readline batches delivery.
  const queue: string[] = [];
  let currentDrain: Promise<void> | undefined;
  async function drain() {
    while (queue.length) {
      const line = queue.shift()!;
      const keepGoing = await handleLine(rl, line);
      if (!keepGoing) { rl.close(); return; }
      prompt(rl);
    }
  }
  function kick() {
    if (!currentDrain) currentDrain = drain().finally(() => { currentDrain = undefined; });
  }
  rl.on("line", (raw) => { queue.push(raw); kick(); });

  // stdin EOF (piped input ending, or Ctrl+D) fires 'close' immediately —
  // possibly while a line is still queued or mid-flight, e.g. all lines of
  // a piped script arrive before any of their async handling has run. Wait
  // for the in-flight drain to actually finish before exiting.
  rl.on("close", async () => {
    if (currentDrain) await currentDrain.catch(() => {});
    console.log(`\n  ${DIM}goodbye${RESET}\n`);
    process.exit(0);
  });
}

main();
