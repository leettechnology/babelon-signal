const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "BabelOn signaling server", version: "stability-nearby-fix-v7" });
});

app.get("/ice", (req, res) => {
  const turnUrls = String(process.env.TURN_URLS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.json({
    iceServers,
    turnConfigured: turnUrls.length > 0
  });
});

const translationCache = new Map();

app.post("/translate", async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 1000);
  const target = String(req.body?.target || "en").replace(/[^a-zA-Z-]/g, "").slice(0, 12);
  if (!text) return res.status(400).json({ ok: false, error: "Text is required." });

  const cacheKey = target + "\n" + text;
  if (translationCache.has(cacheKey)) {
    return res.json({ ok: true, text: translationCache.get(cacheKey), cached: true });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
      encodeURIComponent(target) + "&dt=t&q=" + encodeURIComponent(text);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Translation provider returned " + response.status);
    const data = await response.json();
    const translated = Array.isArray(data?.[0])
      ? data[0].map(part => part?.[0] || "").join("")
      : "";
    if (!translated) throw new Error("Translation provider returned no text");
    translationCache.set(cacheKey, translated);
    if (translationCache.size > 500) translationCache.delete(translationCache.keys().next().value);
    res.json({ ok: true, text: translated });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.name === "AbortError" ? "Translation timed out." : error.message });
  } finally {
    clearTimeout(timeout);
  }
});

// A small built-in test page makes Railway smoke testing possible without a
// second web server. The production site can continue hosting the same files.
app.get("/call.html", (req, res) => res.sendFile(path.join(__dirname, "call.html")));
app.get("/js/call.js", (req, res) => res.sendFile(path.join(__dirname, "call.js")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map();

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function joinRoom(ws, room) {
  if (ws.room && ws.room !== room) leaveRoom(ws);
  ws.room = room;
  if (!rooms.has(room)) rooms.set(room, new Set());
  const clients = rooms.get(room);
  clients.forEach(client => send(client, { type: "peer", status: "joined", room }));
  clients.add(ws);
  send(ws, { type: "joined", room, peers: clients.size - 1 });
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room || !rooms.has(room)) return;
  const clients = rooms.get(room);
  clients.delete(ws);
  clients.forEach(client => send(client, { type: "peer", status: "left", room }));
  if (clients.size === 0) rooms.delete(room);
  ws.room = null;
}

function relay(ws, msg) {
  const room = msg.room || ws.room;
  if (!room || !rooms.has(room)) return;
  rooms.get(room).forEach(client => {
    if (client !== ws) send(client, msg);
  });
}

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join" && msg.room) {
      joinRoom(ws, msg.room);
      return;
    }

    if (["ready","offer","answer","ice","caption","emoji","hello","audio-check","hangup"].includes(msg.type)) {
      relay(ws, msg);
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      leaveRoom(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {
      leaveRoom(ws);
      ws.terminate();
    }
  });
}, 30000);

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("BabelOn signaling server running on port " + port));

