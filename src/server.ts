import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AgentName, agentLabel, runAgentTurn } from "./agent.js";
import { providerStatus } from "./providers.js";
import { auditEvents } from "./tools/shell.js";
import { browserEvents, browserStatus, addStreamViewer, removeStreamViewer, setStreamInterval, setModeOverride, closeBrowser } from "./tools/browser.js";
import { updateStatus, setUpdateInterval, checkNow } from "./update.js";
import { MAINFRAME_VERSION } from "./version.js";
import { sfxEvents, triggerSfx, sfxStatus, stopThinkingLoop, SfxEvent } from "./sfx.js";
import { loadMemory, forgetMemory } from "./tools/memory.js";
import { reminderEvents, listReminders } from "./tools/reminders.js";

const SFX_EVENTS: SfxEvent[] = ["sent", "success", "error", "thinking", "reminder", "startup"];

// A turn only throws when every LLM provider failed (see llm() in
// providers.ts — both Groq's whole key pool rate-limited and Gemini
// unavailable) or the agent looped past its round cap. The former is
// transient — the key pool recovers as soon as a rate-limit window expires —
// so instead of handing the person an error the instant that happens, retry
// quietly in the background for a few minutes before actually giving up.
// The round-cap case is a real limit, not a blip, so it's surfaced right away
// instead of retried.
const CHAT_RETRY_BUDGET_MS = 3 * 60 * 1000;
const CHAT_RETRY_BASE_MS = 2000;
const CHAT_RETRY_MAX_MS = 15000;

function isProviderFailure(err: unknown): boolean {
  return String((err as Error)?.message ?? err ?? "").includes("All LLM providers failed");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 7777;
const START_TIME = Date.now();

export function startServer() {
  const app = express();
  // 20mb headroom for image attachments (chat uploads + forwarded
  // screenshots) — the frontend downscales images before sending, but this
  // still needs enough room for a full base64-encoded photo.
  app.use(express.json({ limit: "20mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/status", (_req, res) => {
    res.json({
      uptime_s: Math.floor((Date.now() - START_TIME) / 1000),
      mainframe_version: MAINFRAME_VERSION,
      update: updateStatus(),
      browser: browserStatus(),
      providers: providerStatus(),
      sfx: sfxStatus(),
    });
  });

  app.post("/api/browser/interval", (req, res) => {
    const ms = Number(req.body?.interval_ms);
    if (!Number.isFinite(ms)) return res.status(400).json({ error: "interval_ms must be a number" });
    res.json({ interval_ms: setStreamInterval(ms) });
  });

  // ── Options / debug panel ────────────────────────────────────────────
  app.post("/api/browser/mode", (req, res) => {
    const mode = req.body?.mode;
    if (!["auto", "local", "stream"].includes(mode)) return res.status(400).json({ error: "mode must be auto, local, or stream" });
    res.json({ mode_override: setModeOverride(mode === "auto" ? null : mode) });
  });

  app.post("/api/browser/restart", async (_req, res) => {
    await closeBrowser();
    res.json({ ok: true });
  });

  app.post("/api/update/interval", (req, res) => {
    const ms = Number(req.body?.interval_ms);
    if (!Number.isFinite(ms)) return res.status(400).json({ error: "interval_ms must be a number" });
    res.json({ interval_ms: setUpdateInterval(ms) });
  });

  app.post("/api/update/check-now", async (_req, res) => {
    res.json(await checkNow());
  });

  app.get("/api/memory", (_req, res) => {
    res.json(loadMemory());
  });

  app.post("/api/memory/forget", (_req, res) => {
    res.json(forgetMemory());
  });

  app.post("/api/sfx/test", (req, res) => {
    const event = req.body?.event;
    if (!SFX_EVENTS.includes(event)) return res.status(400).json({ error: `event must be one of: ${SFX_EVENTS.join(", ")}` });
    triggerSfx(event as SfxEvent);
    // "thinking" loops until something stops it (a real turn ending) — a
    // manual test has no such follow-up, so auto-stop it rather than
    // leaving it looping on the speaker indefinitely if someone forgets.
    if (event === "thinking") setTimeout(stopThinkingLoop, 8000);
    res.json({ ok: true });
  });

  app.get("/api/reminders", (_req, res) => {
    res.json({ reminders: listReminders() });
  });

  app.post("/api/chat", async (req, res) => {
    const { agent, messages } = req.body ?? {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "`messages` must be an array." });
    const agentName: AgentName = ["caden", "researcher", "scout"].includes(agent) ? agent : "caden";
    triggerSfx("sent");

    // The client's Cancel button aborts its fetch, which closes this
    // connection — that's the cancel signal: stop retrying the instant it
    // happens rather than finishing out the backoff budget pointlessly.
    let cancelled = false;
    req.on("close", () => { cancelled = true; });

    const startedAt = Date.now();
    let attempt = 0;
    let lastErr: unknown;
    while (!cancelled) {
      try {
        const result = await runAgentTurn(messages, agentName);
        if (cancelled) return;
        triggerSfx("success");
        res.json({ agent: agentName, agent_label: agentLabel(agentName), ...result });
        return;
      } catch (err) {
        lastErr = err;
        const elapsed = Date.now() - startedAt;
        if (cancelled || !isProviderFailure(err) || elapsed >= CHAT_RETRY_BUDGET_MS) break;
        const backoff = Math.min(CHAT_RETRY_BASE_MS * 2 ** attempt, CHAT_RETRY_MAX_MS);
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(backoff, CHAT_RETRY_BUDGET_MS - elapsed)));
      }
    }

    if (!cancelled) {
      triggerSfx("error");
      res.status(502).json({ error: String((lastErr as Error)?.message ?? lastErr) });
    }
  });

  const httpServer = createServer(app);
  const logWss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });
  const sfxWss = new WebSocketServer({ noServer: true });
  const remindersWss = new WebSocketServer({ noServer: true });

  logWss.on("connection", (ws: WebSocket) => {
    const onEntry = (entry: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(entry)); };
    auditEvents.on("entry", onEntry);
    ws.on("close", () => auditEvents.off("entry", onEntry));
  });

  browserWss.on("connection", (ws: WebSocket) => {
    addStreamViewer();
    const onFrame = (buf: Buffer) => { if (ws.readyState === ws.OPEN) ws.send(buf); };
    const onStatus = (status: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ status })); };
    browserEvents.on("frame", onFrame);
    browserEvents.on("status", onStatus);
    ws.on("close", () => {
      browserEvents.off("frame", onFrame);
      browserEvents.off("status", onStatus);
      removeStreamViewer();
    });
  });

  sfxWss.on("connection", (ws: WebSocket) => {
    const onPlay = (msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    sfxEvents.on("play", onPlay);
    ws.on("close", () => sfxEvents.off("play", onPlay));
  });

  remindersWss.on("connection", (ws: WebSocket) => {
    const onDue = (reminder: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reminder)); };
    reminderEvents.on("due", onDue);
    ws.on("close", () => reminderEvents.off("due", onDue));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/ws/log") {
      logWss.handleUpgrade(req, socket, head, (ws) => logWss.emit("connection", ws));
    } else if (url.pathname === "/ws/browser") {
      browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit("connection", ws));
    } else if (url.pathname === "/ws/sfx") {
      sfxWss.handleUpgrade(req, socket, head, (ws) => sfxWss.emit("connection", ws));
    } else if (url.pathname === "/ws/reminders") {
      remindersWss.handleUpgrade(req, socket, head, (ws) => remindersWss.emit("connection", ws));
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Caden listening on http://0.0.0.0:${PORT}`);
  });

  return httpServer;
}
