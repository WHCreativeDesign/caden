import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AgentName, agentLabel, planThinking, runAgentTurn } from "./agent.js";
import { providerStatus } from "./providers.js";
import { auditEvents } from "./tools/shell.js";
import { browserEvents, browserStatus, addStreamViewer, removeStreamViewer, setStreamInterval, setModeOverride, closeBrowser } from "./tools/browser.js";
import { updateStatus, setUpdateInterval, checkNow } from "./update.js";
import { MAINFRAME_VERSION } from "./version.js";
import { sfxEvents, triggerSfx, sfxStatus, SfxEvent } from "./sfx.js";
import { loadMemory, forgetMemory } from "./tools/memory.js";

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
    if (!["sent", "success", "error"].includes(event)) return res.status(400).json({ error: "event must be sent, success, or error" });
    triggerSfx(event as SfxEvent);
    res.json({ ok: true });
  });

  app.post("/api/chat", async (req, res) => {
    const { agent, messages } = req.body ?? {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "`messages` must be an array." });
    const agentName: AgentName = ["caden", "researcher", "scout"].includes(agent) ? agent : "caden";
    triggerSfx("sent");
    try {
      const thinking = await planThinking(messages);
      const planText = thinking.join("\n");
      const result = await runAgentTurn(messages, agentName, planText);
      triggerSfx("success");
      res.json({ agent: agentName, agent_label: agentLabel(agentName), thinking, ...result });
    } catch (err) {
      triggerSfx("error");
      res.status(502).json({ error: String((err as Error).message ?? err) });
    }
  });

  const httpServer = createServer(app);
  const logWss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });
  const sfxWss = new WebSocketServer({ noServer: true });

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

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/ws/log") {
      logWss.handleUpgrade(req, socket, head, (ws) => logWss.emit("connection", ws));
    } else if (url.pathname === "/ws/browser") {
      browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit("connection", ws));
    } else if (url.pathname === "/ws/sfx") {
      sfxWss.handleUpgrade(req, socket, head, (ws) => sfxWss.emit("connection", ws));
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Caden listening on http://0.0.0.0:${PORT}`);
  });

  return httpServer;
}
