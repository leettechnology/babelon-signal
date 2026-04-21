import http from "http";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import nodemailer from "nodemailer";
import mysql from "mysql2/promise";

const PORT = process.env.PORT || 8080;

let db = null;

async function initDb() {
  try {
    db = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    console.log("Database pool initialized");
  } catch (e) {
    console.error("DB INIT ERROR:", e);
  }
}

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
      if (data.length > 1024 * 1024) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function buildNdaEmailHtml(payload) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5">
      <h2>BabelOn NDA Confirmation</h2>
      <p>This confirms your electronic acceptance of the BabelOn tester NDA.</p>
      <p><strong>Name:</strong> ${String(payload.name || "")}</p>
      <p><strong>Email:</strong> ${String(payload.email || "")}</p>
      <p><strong>Phone:</strong> ${String(payload.phone || "")}</p>
      <p><strong>Signed At:</strong> ${String(payload.signedAt || "")}</p>
    </div>
  `;
}

async function sendNdaConfirmationEmail(payload) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: payload.email,
    subject: "BabelOn NDA Confirmation",
    html: buildNdaEmailHtml(payload)
  });
}

async function logActivity(userId, sessionToken, eventType, details) {
  if (!db) return;
  await db.execute(
    `INSERT INTO activity_sessions (user_id, session_token, event_type, details)
     VALUES (?, ?, ?, ?)`,
    [userId || null, sessionToken || "anonymous", eventType, details ? JSON.stringify(details) : null]
  );
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

    if (req.method === "GET" && url.pathname === "/") {
      return text(res, 200, "BabelOn signaling OK");
    }

    if (req.method === "GET" && url.pathname === "/ice") {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;

      if (!sid || !token) {
        return json(res, 500, { error: "Missing TWILIO credentials" });
      }

      const client = twilio(sid, token);
      const t = await client.tokens.create({ ttl: 3600 });
      return json(res, 200, { iceServers: t.iceServers });
    }

    if (req.method === "POST" && url.pathname === "/nda-sign") {
      const body = await readJsonBody(req);

      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const phone = String(body.phone || "").trim();
      const signature = String(body.signature || "").trim();
      const accepted = body.accepted === true;
      const preferredLanguage = String(body.preferredLanguage || "").trim();
      const accessibilityMode = body.accessibilityMode === true ? 1 : 0;

      if (!name || !email || !phone || !signature || !accepted) {
        return json(res, 400, { error: "Missing required NDA fields" });
      }

      if (!db) {
        return json(res, 500, { error: "Database not configured" });
      }

      const signedAt = new Date();
      let userId = null;

      const [existingRows] = await db.execute(
        `SELECT id FROM users WHERE email = ? LIMIT 1`,
        [email]
      );

      if (existingRows.length) {
        userId = existingRows[0].id;
        await db.execute(
          `UPDATE users
           SET full_name = ?, phone = ?, nda_signed_at = ?, nda_signature_name = ?, preferred_language = COALESCE(NULLIF(?, ''), preferred_language), accessibility_mode = ?
           WHERE id = ?`,
          [name, phone, signedAt, signature, preferredLanguage, accessibilityMode, userId]
        );
      } else {
        const [insertResult] = await db.execute(
          `INSERT INTO users (full_name, email, phone, preferred_language, nda_signed_at, nda_signature_name, accessibility_mode, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
          [name, email, phone, preferredLanguage || null, signedAt, signature, accessibilityMode]
        );
        userId = insertResult.insertId;
      }

      await db.execute(
        `INSERT INTO nda_signatures (user_id, nda_version, accepted, signature_name, signed_at, ip_address, confirmation_email_sent)
         VALUES (?, '1.0', 1, ?, ?, ?, 0)`,
        [
          userId,
          signature,
          signedAt,
          req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown"
        ]
      );

      try {
        await sendNdaConfirmationEmail({
          name: name,
          email: email,
          phone: phone,
          signedAt: signedAt.toISOString()
        });
      } catch (e) {
        console.error("SMTP ERROR:", e);
        return json(res, 500, {
          error: "NDA saved but email failed",
          details: e.message
        });
      }

      await logActivity(userId, body.sessionToken || "anonymous", "nda_signed", {
        email: email,
        name: name
      });

      return json(res, 200, {
        ok: true,
        message: "NDA signed and confirmation email sent",
        userId: userId
      });
    }

    if (req.method === "POST" && url.pathname === "/save-language") {
      const body = await readJsonBody(req);
      const email = String(body.email || "").trim();
      const preferredLanguage = String(body.preferredLanguage || "").trim();

      if (!email || !preferredLanguage) {
        return json(res, 400, { error: "Missing email or language" });
      }

      if (!db) {
        return json(res, 500, { error: "Database not configured" });
      }

      await db.execute(
        `UPDATE users SET preferred_language = ? WHERE email = ?`,
        [preferredLanguage, email]
      );

      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/track-event") {
      const body = await readJsonBody(req);
      const sessionToken = String(body.sessionToken || "anonymous");
      const eventType = String(body.eventType || "").trim();
      const userId = body.userId || null;
      const details = body.details || null;

      if (!eventType) {
        return json(res, 400, { error: "Missing eventType" });
      }

      await logActivity(userId, sessionToken, eventType, details);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/admin-users") {
      if (!db) {
        return json(res, 500, { error: "Database not configured" });
      }

      const [rows] = await db.execute(
        `SELECT id, full_name, email, phone, preferred_language, status, nda_signed_at, accessibility_mode, created_at
         FROM users
         ORDER BY created_at DESC`
      );

      return json(res, 200, { users: rows });
    }

    if (req.method === "POST" && url.pathname === "/admin-user-action") {
      const body = await readJsonBody(req);
      const userId = Number(body.userId || 0);
      const actionType = String(body.actionType || "").trim();
      const reason = String(body.reason || "").trim();

      if (!userId || !actionType || !reason) {
        return json(res, 400, { error: "Missing moderation fields" });
      }

      if (!db) {
        return json(res, 500, { error: "Database not configured" });
      }

      let newStatus = "active";
      if (actionType === "suspend") newStatus = "suspended";
      if (actionType === "ban") newStatus = "banned";
      if (actionType === "delete") newStatus = "deleted";
      if (actionType === "restore") newStatus = "active";

      await db.execute(`UPDATE users SET status = ? WHERE id = ?`, [newStatus, userId]);
      await db.execute(
        `INSERT INTO moderation_actions (user_id, action_type, reason, admin_note)
         VALUES (?, ?, ?, ?)`,
        [userId, actionType, reason, body.adminNote || null]
      );

      await logActivity(userId, "admin", "moderation_action", { actionType, reason });
      return json(res, 200, { ok: true });
    }

    return text(res, 404, "Not Found");
  } catch (e) {
    console.error("SERVER ERROR:", e);
    return text(res, 500, "Server error");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.room = null;
  ws.role = null;

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg || !msg.type) return;

    if (msg.type === "join") {
      const room = String(msg.room || "").toUpperCase().trim();
      const role = msg.role === "host" ? "host" : "guest";
      if (!room) return;

      ws.room = room;
      ws.role = role;

      if (!rooms.has(room)) rooms.set(room, { host: null, guest: null });
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

    if (!entry.host && !entry.guest) rooms.delete(room);
  });
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log("BabelOn signaling server listening on", PORT);
  });
});
