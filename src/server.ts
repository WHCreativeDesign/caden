import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AgentName, agentLabel, planThinking, runAgentTurn } from "./agent.js";
import { providerStatus } from "./providers.js";
import { auditEvents } from "./tools/shell.js";
import { browserEvents, browserStatus, addStreamViewer, removeStreamViewer, setStreamInterval } from "./tools/browser.js";
import { updateStatus } from "./update.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 7777;
const START_TIME = Date.now();

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/status", (_req, res) => {
    res.json({
      uptime_s: Math.floor((Date.now() - START_TIME) / 1000),
      update: updateStatus(),
      browser: browserStatus(),
      providers: providerStatus(),
    });
  });

  app.post("/api/browser/interval", (req, res) => {
    const ms = Number(req.body?.interval_ms);
    if (!Number.isFinite(ms)) return res.status(400).json({ error: "interval_ms must be a number" });
    res.json({ interval_ms: setStreamInterval(ms) });
  });

  app.post("/api/chat", async (req, res) => {
    const { agent, messages } = req.body ?? {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "`messages` must be an array." });
    const agentName: AgentName = ["caden", "researcher", "scout"].includes(agent) ? agent : "caden";
    try {
      const thinking = await planThinking(messages);
      const planText = thinking.join("\n");
      const result = await runAgentTurn(messages, agentName, planText);
      res.json({ agent: agentName, agent_label: agentLabel(agentName), thinking, ...result });
    } catch (err) {
      res.status(502).json({ error: String((err as Error).message ?? err) });
    }
  });

  const httpServer = createServer(app);
  const logWss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });

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

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/ws/log") {
      logWss.handleUpgrade(req, socket, head, (ws) => logWss.emit("connection", ws));
    } else if (url.pathname === "/ws/browser") {
      browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit("connection", ws));
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Caden listening on http://0.0.0.0:${PORT}`);
  });

  return httpServer;
}
