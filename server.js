import http from "http";
import { WebSocketServer } from "ws";
import nodemailer from "nodemailer";

const PORT = process.env.PORT || 8080;

/* ----------------------------
   SIMPLE NDA STORAGE (memory)
-----------------------------*/
const ndaLogs = [];

/* ----------------------------
   HELPERS
-----------------------------*/
function json(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function text(res, code, msg) {
  res.writeHead(code, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(msg);
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/* ----------------------------
   EMAIL
-----------------------------*/
async function sendNdaEmail(payload) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const html = `
    <div style="font-family:Arial,sans-serif">
      <h2>BabelOn NDA Confirmation</h2>
      <p>This confirms you signed the BabelOn tester NDA.</p>
      <p><strong>Name:</strong> ${escapeHtml(payload.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(payload.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(payload.phone)}</p>
      <p><strong>Signed:</strong> ${escapeHtml(payload.signedAt)}</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: payload.email,
    subject: "BabelOn NDA Confirmation",
    html
  });
}

/* ----------------------------
   HTTP SERVER
-----------------------------*/
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return json(res, 200, { ok: true });
    }

    if (req.url === "/") {
      return text(res, 200, "BabelOn signaling OK");
    }

    if (req.url === "/nda-sign" && req.method === "POST") {
      const body = await readBody(req);

      const payload = {
        name: body.name || "",
        email: body.email || "",
        phone: body.phone || "",
        signedAt: new Date().toISOString()
      };

      ndaLogs.push(payload);

      try {
        await sendNdaEmail(payload);
        return json(res, 200, {
          ok: true,
          message: "NDA saved and email sent"
        });
      } catch (e) {
        console.error("SMTP ERROR:", e);
        return json(res, 500, {
          error: "NDA saved but email failed",
          details: e.message
        });
      }
    }

    if (req.url === "/nda-logs") {
      return json(res, 200, ndaLogs);
    }

    return text(res, 404, "Not found");

  } catch (e) {
    console.error("SERVER ERROR:", e);
    return text(res, 500, "Server error");
  }
});

/* ----------------------------
   BASIC SIGNALING SOCKET
-----------------------------*/
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    // keep existing signaling simple
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === 1) {
        client.send(msg.toString());
      }
    });
  });
});

server.listen(PORT, () => {
  console.log("BabelOn server live on port", PORT);
});
