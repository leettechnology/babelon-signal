import http from "http";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import nodemailer from "nodemailer";

const PORT = process.env.PORT || 8080;

// Temporary test-only storage.
// For production, move this to a real database.
const ndaLogs = [];

// room => { host: ws|null, guest: ws|null }
const rooms = new Map();

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch {}
}

function json(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function text(res, statusCode, msg) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(msg);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function buildNdaEmailHtml(payload) {
  const signedAt = new Date(payload.signedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  });

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5">
      <h2 style="margin:0 0 12px">BabelOn Test User NDA Confirmation</h2>
      <p>Thank you. This email confirms that you electronically signed the BabelOn Test User Non-Disclosure Agreement.</p>

      <h3 style="margin:18px 0 8px">Signer Information</h3>
      <p style="margin:0">
        <strong>Name:</strong> ${escapeHtml(payload.name)}<br>
        <strong>Email:</strong> ${escapeHtml(payload.email)}<br>
        <strong>Phone:</strong> ${escapeHtml(payload.phone)}<br>
        <strong>Signed At:</strong> ${escapeHtml(signedAt)}
      </p>

      <h3 style="margin:18px 0 8px">Agreement Summary</h3>
      <p style="margin:0 0 10px">
        You agree to keep confidential all non-public information related to the BabelOn application,
        including product design, features, testing experience, screenshots, recordings, source files,
        workflows, translations, and any technical or business information disclosed during testing.
      </p>

      <p style="margin:0 0 10px">
        You agree not to copy, distribute, publish, disclose, or use this confidential information
        except for participating in authorized testing of BabelOn.
      </p>

      <p style="margin:0 0 10px">
        This confirmation is provided for your records as an electronic acknowledgment of your NDA acceptance.
      </p>

      <hr style="margin:18px 0;border:none;border-top:1px solid #ddd">

      <p style="font-size:12px;color:#555;margin:0">
        BabelOn Test NDA Confirmation
      </p>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function sendNdaConfirmationEmail(payload) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false") === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass || !from) {
    throw new Error("Missing SMTP configuration");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass
    }
  });

  await transporter.sendMail({
    from,
    to: payload.email,
    subject: "BabelOn NDA Confirmation",
    html: buildNdaEmailHtml(payload)
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      return res.end();
    }

    // Twilio TURN endpoint
    if (req.method === "GET" && url.pathname === "/ice") {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;

      if (!sid || !token) {
        return json(res, 500, { error: "Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN" });
      }

      const client = twilio(sid, token);
      const t = await client.tokens.create({ ttl: 3600 });

      return json(res, 200, { iceServers: t.iceServers });
    }

    // NDA submit endpoint
    if (req.method === "POST" && url.pathname === "/nda-sign") {
      const body = await readJsonBody(req);

      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const phone = String(body.phone || "").trim();
      const signature = String(body.signature || "").trim();
      const accepted = body.accepted === true;

      if (!name || !email || !phone || !signature || !accepted) {
        return json(res, 400, { error: "Missing required NDA fields" });
      }

      const payload = {
        name,
        email,
        phone,
        signature,
        accepted,
        signedAt: new Date().toISOString(),
        ip:
          req.headers["x-forwarded-for"] ||
          req.socket.remoteAddress ||
          "unknown"
      };

      ndaLogs.push(payload);

      try {
        await sendNdaConfirmationEmail(payload);
      } catch (e) {
        return json(res, 500, {
          error: "NDA saved but email failed",
          details: e.message
        });
      }

      return json(res, 200, {
        ok: true,
        message: "NDA signed and confirmation email sent"
      });
    }

    if (req.method === "GET" && url.pathname === "/nda-logs") {
      return json(res, 200, { count: ndaLogs.length, items: ndaLogs });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return text(res, 200, "BabelOn signaling OK");
    }

    return text(res, 404, "Not Found");
  } catch (e) {
    return text(res, 500, "Server error");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.room = null;
  ws.role = null;

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (!msg || !msg.type) return;

    if (msg.type === "join") {
      const room = String(msg.room || "").toUpperCase().trim();
      const role = msg.role === "host" ? "host" : "guest";
      if (!room) return;

      ws.room = room;
      ws.role = role;

      if (!rooms.has(room)) {
        rooms.set(room, { host: null, guest: null });
      }

      const entry = rooms.get(room);
      entry[role] = ws;

      safeSend(entry.host, { type: "peer", status: entry.guest ? "guest-ready" : "waiting" });
      safeSend(entry.guest, { type: "peer", status: entry.host ? "host-ready" : "waiting" });
      return;
    }

    const room = ws.room;
    if (!room || !rooms.has(room)) return;

    const entry = rooms.get(room);
    const other = ws.role === "host" ? entry.guest : entry.host;
    if (!other) return;

    if (msg.type === "offer" || msg.type === "answer") {
      safeSend(other, { type: msg.type, sdp: msg.sdp });
      return;
    }

    if (msg.type === "ice") {
      safeSend(other, { type: "ice", candidate: msg.candidate });
      return;
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room || !rooms.has(room)) return;

    const entry = rooms.get(room);
    if (entry.host === ws) entry.host = null;
    if (entry.guest === ws) entry.guest = null;

    safeSend(entry.host, { type: "peer", status: "left" });
    safeSend(entry.guest, { type: "peer", status: "left" });

    if (!entry.host && !entry.guest) {
      rooms.delete(room);
    }
  });
});

server.listen(PORT, () => {
  console.log("Signaling server listening on", PORT);
});// JavaScript Document
