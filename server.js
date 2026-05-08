const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();

app.get("/", (req, res) => {
  res.json({ ok: true, service: "BabelOn signaling server", version: "emoji-sticker-fix-v4" });
});

app.get("/ice", (req, res) => {
  res.json({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  });
});

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

    if (["ready","offer","answer","ice","caption","emoji","hello"].includes(msg.type)) {
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
