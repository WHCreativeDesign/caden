import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AgentName, agentLabel, compactHistoryIfNeeded, runAgentTurnRetrying } from "./agent.js";
import { providerStatus } from "./providers.js";
import { synthesizeSpeech } from "./piper.js";
import { auditEvents } from "./tools/shell.js";
import { logHistory } from "./logbus.js";
import { browserStatus, setModeOverride, closeBrowser } from "./tools/browser.js";
import { updateStatus, setUpdateInterval, checkNow } from "./update.js";
import { MAINFRAME_VERSION } from "./version.js";
import { sfxEvents, triggerSfx, sfxStatus, stopThinkingLoop, SfxEvent } from "./sfx.js";
import { loadMemory, forgetMemory } from "./tools/memory.js";
import { reminderEvents, listReminders } from "./tools/reminders.js";
import { weatherConfigStatus, setOpenWeatherApiKey } from "./tools/weather.js";
import { telegramStatus, setTelegramConfig } from "./telegram.js";
import { markBusy, markIdle } from "./activity.js";

const SFX_EVENTS: SfxEvent[] = ["sent", "success", "error", "thinking", "reminder", "startup"];

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
      telegram: telegramStatus(),
      weather: weatherConfigStatus(),
    });
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

  // Speaks Caden's reply via Piper, a local TTS engine running entirely on
  // this Pi (see synthesizeSpeech in piper.ts), and hands back a real .wav
  // file rather than base64-in-JSON — the browser just fetch()es it and
  // decodeAudioData()s the response body directly.
  app.post("/api/tts", async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "`text` must be a non-empty string" });
    // markBusy/markIdle here too, not just /api/chat: speakCaden() in the
    // web UI fires this the instant a chat reply lands, right after that
    // /api/chat request already marked itself idle — so without this, the
    // self-update watcher's "wait for in-flight requests before restarting"
    // check (activity.ts / update.ts) is blind to a synthesis request still
    // in flight. It would see idle, restart immediately, kill this
    // connection, and — worse — leave a real gap where the server is briefly
    // down for systemd to relaunch it, during which the person's very next
    // message gets a raw "Failed to fetch" with no explanation.
    markBusy();
    try {
      console.log(`[tts] synthesizing ${text.length} char${text.length === 1 ? "" : "s"} of speech`);
      const wav = await synthesizeSpeech(text);
      res.setHeader("Content-Type", "audio/wav");
      res.send(wav);
    } catch (err) {
      console.error(`[tts] synthesis failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
      res.status(502).json({ error: String((err as Error).message ?? err) });
    } finally {
      markIdle();
    }
  });

  // Telegram key management (Options tab) — see CLAUDE.md's Telegram
  // section. GET never returns the raw token, only a masked preview.
  app.get("/api/telegram/config", (_req, res) => {
    res.json(telegramStatus());
  });

  app.post("/api/telegram/config", (req, res) => {
    const { token, allowed_chat_ids } = req.body ?? {};
    if (token !== undefined && typeof token !== "string") return res.status(400).json({ error: "token must be a string" });
    if (allowed_chat_ids !== undefined && !Array.isArray(allowed_chat_ids)) return res.status(400).json({ error: "allowed_chat_ids must be an array" });
    setTelegramConfig({
      ...(token !== undefined ? { token } : {}),
      ...(allowed_chat_ids !== undefined ? { allowedChatIds: allowed_chat_ids.map(String) } : {}),
    });
    res.json(telegramStatus());
  });

  // Weather key management (Options tab) — same masked-preview convention
  // as Telegram's token. Clearing the key (empty string) just drops back to
  // the no-key wttr.in default rather than breaking the tool.
  app.get("/api/weather/config", (_req, res) => {
    res.json(weatherConfigStatus());
  });

  app.post("/api/weather/config", (req, res) => {
    const { api_key } = req.body ?? {};
    if (typeof api_key !== "string") return res.status(400).json({ error: "api_key must be a string" });
    setOpenWeatherApiKey(api_key);
    res.json(weatherConfigStatus());
  });

  app.post("/api/chat", async (req, res) => {
    const { agent, messages } = req.body ?? {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "`messages` must be an array." });
    const agentName: AgentName = ["caden", "researcher", "scout"].includes(agent) ? agent : "caden";
    console.log(`[chat] message received (agent=${agentName}, ${messages.length} message${messages.length === 1 ? "" : "s"} in history)`);
    triggerSfx("sent");

    // The client's Cancel button aborts its fetch, which closes this
    // connection — that's the cancel signal: stop retrying the instant it
    // happens rather than finishing out the backoff budget pointlessly.
    //
    // This MUST watch `res`, not `req`: `req` (the request stream) emits
    // 'close' as soon as the request body has been fully read — which is
    // immediately for a normal POST, and has nothing to do with the client
    // going away. Using it flagged EVERY chat turn as "cancelled" the moment
    // it arrived (the turn was skipped and the reply never sent — a hard bug,
    // not a rare race). `res` 'close' firing *before the response has
    // finished writing* (`!res.writableEnded`) is the real "client
    // disconnected mid-turn" signal.
    let cancelled = false;
    res.on("close", () => { if (!res.writableEnded) cancelled = true; });

    // Tells the self-update watcher not to restart out from under this
    // request — a turn can legitimately run for minutes now (the retry
    // loop below), and a coincidental restart used to just kill the
    // connection mid-flight (see activity.ts).
    markBusy();
    try {
      // Compact a long conversation into a summary + recent tail before
      // spending tokens on it — if it compacted, hand the shrunken history
      // back so the client replaces what it's storing (and resending) from
      // here on, instead of paying the full growing cost every turn.
      const { history, compacted } = await compactHistoryIfNeeded(messages);
      const result = await runAgentTurnRetrying(history, agentName, () => cancelled);
      if (cancelled) { console.log("[chat] request cancelled by client"); return; }
      triggerSfx("success");
      console.log(`[chat] reply sent (${result.rounds} round${result.rounds === 1 ? "" : "s"}, ${result.steps.length} tool call${result.steps.length === 1 ? "" : "s"}${compacted ? ", history compacted" : ""})`);
      res.json({ agent: agentName, agent_label: agentLabel(agentName), ...(compacted ? { history } : {}), ...result });
    } catch (err) {
      if (cancelled) { console.log("[chat] request cancelled by client"); return; }
      triggerSfx("error");
      console.error(`[chat] turn failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
      res.status(502).json({ error: String((err as Error).message ?? err) });
    } finally {
      markIdle();
    }
  });

  const httpServer = createServer(app);
  const logWss = new WebSocketServer({ noServer: true });
  const sfxWss = new WebSocketServer({ noServer: true });
  const remindersWss = new WebSocketServer({ noServer: true });

  logWss.on("connection", (ws: WebSocket) => {
    const onEntry = (entry: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(entry)); };
    // Replay everything logged since boot first, so the panel shows the full
    // picture the moment it opens rather than only what happens afterward.
    // JS is single-threaded and there's no await here, so no live entry can
    // slip in between the snapshot and attaching the listener.
    for (const entry of logHistory()) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(entry)); }
    auditEvents.on("entry", onEntry);
    ws.on("close", () => auditEvents.off("entry", onEntry));
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
    } else if (url.pathname === "/ws/sfx") {
      sfxWss.handleUpgrade(req, socket, head, (ws) => sfxWss.emit("connection", ws));
    } else if (url.pathname === "/ws/reminders") {
      remindersWss.handleUpgrade(req, socket, head, (ws) => remindersWss.emit("connection", ws));
    } else {
      socket.destroy();
    }
  });

  // /api/chat can legitimately stay open for the full 3-minute retry
  // budget with nothing written back until it resolves — Node's own default
  // request timeout is comfortably above that already, but making it
  // explicit removes any doubt that Node itself is what's cutting a slow
  // chat request short.
  httpServer.requestTimeout = 5 * 60 * 1000;

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Caden listening on http://0.0.0.0:${PORT}`);
  });

  return httpServer;
}
