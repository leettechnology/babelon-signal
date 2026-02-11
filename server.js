import http from "http";
import { WebSocketServer } from "ws";

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("BabelOn signaling OK");
});

const wss = new WebSocketServer({ server });

// room => { host: ws|null, guest: ws|null }
const rooms = new Map();

function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch {}
}

wss.on("connection", (ws) => {
  ws.room = null;
  ws.role = null;

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg?.type) return;

    if (msg.type === "join"){
      const room = String(msg.room || "").toUpperCase().trim();
      const role = (msg.role === "host") ? "host" : "guest";
      if (!room) return;

      ws.room = room;
      ws.role = role;

      if (!rooms.has(room)) rooms.set(room, { host: null, guest: null });
      const r = rooms.get(room);

      if (role === "host"){
        if (r.host && r.host !== ws) safeSend(r.host, { type:"peer_left", room });
        r.host = ws;
      } else {
        if (r.guest && r.guest !== ws) safeSend(r.guest, { type:"peer_left", room });
        r.guest = ws;
      }

      safeSend(ws, { type:"joined", room, role });

      if (r.host && r.guest){
        safeSend(r.host, { type:"ready", room });
        safeSend(r.guest, { type:"ready", room });
      }
      return;
    }

    const room = ws.room;
    if (!room || !rooms.has(room)) return;
    const r = rooms.get(room);
    const other = (ws.role === "host") ? r.guest : r.host;
    if (!other) return;

    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice"){
      safeSend(other, msg);
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room || !rooms.has(room)) return;
    const r = rooms.get(room);

    if (ws.role === "host" && r.host === ws) r.host = null;
    if (ws.role === "guest" && r.guest === ws) r.guest = null;

    const other = (ws.role === "host") ? r.guest : r.host;
    if (other) safeSend(other, { type:"peer_left", room });

    if (!r.host && !r.guest) rooms.delete(room);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("Signaling on", PORT));
