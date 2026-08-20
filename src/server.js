const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "change-this-webhook-token";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WHATSAPP_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "maseray.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    membership_number TEXT NOT NULL UNIQUE,
    monthly_contribution REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    contribution_month TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'unpaid',
    payment_reference TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(member_id, contribution_month),
    FOREIGN KEY(member_id) REFERENCES members(id)
  );
`);

if (db.prepare("SELECT COUNT(*) AS c FROM members").get().c === 0) {
  db.prepare(
    "INSERT INTO members(name,phone,membership_number,monthly_contribution) VALUES(?,?,?,?)"
  ).run("Demo Member", "23200000000", "MTB-001", 100);
}

app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

const cleanPhone = (phone = "") => String(phone).replace(/\D/g, "");
const isValidMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));
const validNonNegativeNumber = value => Number.isFinite(Number(value)) && Number(value) >= 0;
const memberByPhone = phone =>
  db.prepare("SELECT * FROM members WHERE phone=? AND active=1").get(cleanPhone(phone));

function verifyWhatsAppSignature(req) {
  if (!WHATSAPP_APP_SECRET) return true;
  const signature = req.get("x-hub-signature-256") || "";
  if (!signature.startsWith("sha256=") || !req.rawBody) return false;
  const expected = crypto
    .createHmac("sha256", WHATSAPP_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  const actual = signature.slice(7);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function sendWhatsAppText(to, body) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("WhatsApp reply skipped: credentials are not configured.");
    return { skipped: true };
  }

  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp API ${response.status}: ${errorText}`);
  }

  return response.json();
}

app.get("/api/health", (req, res) =>
  res.json({ ok: true, service: "maseray-whatsapp-webhook", time: new Date().toISOString() })
);

app.get("/api/members", (req, res) => {
  res.json(
    db.prepare(`
      SELECT m.*,
        COALESCE(SUM(CASE WHEN c.status='paid' THEN c.amount ELSE 0 END),0) AS total_paid,
        COUNT(c.id) AS contribution_count
      FROM members m
      LEFT JOIN contributions c ON c.member_id=m.id
      WHERE m.active=1
      GROUP BY m.id
      ORDER BY m.name COLLATE NOCASE
    `).all()
  );
});

app.post("/api/members", (req, res) => {
  try {
    const { name, phone, membership_number, monthly_contribution } = req.body;
    if (!String(name || "").trim() || !cleanPhone(phone) || !String(membership_number || "").trim()) {
      return res.status(400).json({ error: "Name, phone and membership number are required." });
    }
    if (!validNonNegativeNumber(monthly_contribution)) {
      return res.status(400).json({ error: "Monthly contribution must be a valid non-negative number." });
    }
    const result = db.prepare(
      "INSERT INTO members(name,phone,membership_number,monthly_contribution) VALUES(?,?,?,?)"
    ).run(
      String(name).trim(),
      cleanPhone(phone),
      String(membership_number).trim(),
      Number(monthly_contribution)
    );
    res.status(201).json(db.prepare("SELECT * FROM members WHERE id=?").get(result.lastInsertRowid));
  } catch (error) {
    res.status(400).json({ error: "Phone or membership number already exists." });
  }
});

app.put("/api/members/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, phone, membership_number, monthly_contribution, active } = req.body;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid member id." });
    if (!String(name || "").trim() || !cleanPhone(phone) || !String(membership_number || "").trim()) {
      return res.status(400).json({ error: "Name, phone and membership number are required." });
    }
    if (!validNonNegativeNumber(monthly_contribution)) {
      return res.status(400).json({ error: "Monthly contribution must be a valid non-negative number." });
    }
    const result = db.prepare(
      "UPDATE members SET name=?,phone=?,membership_number=?,monthly_contribution=?,active=? WHERE id=?"
    ).run(
      String(name).trim(),
      cleanPhone(phone),
      String(membership_number).trim(),
      Number(monthly_contribution),
      active === false ? 0 : 1,
      id
    );
    if (!result.changes) return res.status(404).json({ error: "Member not found." });
    res.json(db.prepare("SELECT * FROM members WHERE id=?").get(id));
  } catch (error) {
    res.status(400).json({ error: "Could not update member. Check phone and membership number." });
  }
});

app.delete("/api/members/:id", (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("UPDATE members SET active=0 WHERE id=?").run(id);
  if (!result.changes) return res.status(404).json({ error: "Member not found." });
  res.json({ ok: true });
});

app.get("/api/contributions", (req, res) => {
  res.json(
    db.prepare(`
      SELECT c.*,m.name,m.phone,m.membership_number
      FROM contributions c
      JOIN members m ON m.id=c.member_id
      ORDER BY c.contribution_month DESC,m.name COLLATE NOCASE
    `).all()
  );
});

app.post("/api/contributions", (req, res) => {
  try {
    const { member_id, contribution_month, amount, status, payment_reference } = req.body;
    const memberId = Number(member_id);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return res.status(400).json({ error: "A valid member is required." });
    }
    if (!isValidMonth(contribution_month)) {
      return res.status(400).json({ error: "Contribution month must use YYYY-MM format." });
    }
    if (!validNonNegativeNumber(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: "Amount must be greater than zero." });
    }
    if (!["paid", "unpaid"].includes(status)) {
      return res.status(400).json({ error: "Status must be paid or unpaid." });
    }
    if (!db.prepare("SELECT id FROM members WHERE id=? AND active=1").get(memberId)) {
      return res.status(404).json({ error: "Member not found." });
    }

    const paid = status === "paid";
    db.prepare(`
      INSERT INTO contributions(member_id,contribution_month,amount,status,payment_reference,paid_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(member_id,contribution_month) DO UPDATE SET
        amount=excluded.amount,
        status=excluded.status,
        payment_reference=excluded.payment_reference,
        paid_at=excluded.paid_at
    `).run(
      memberId,
      contribution_month,
      Number(amount),
      status,
      String(payment_reference || "").trim() || null,
      paid ? new Date().toISOString() : null
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("Contribution error", error);
    res.status(400).json({ error: "Could not save contribution." });
  }
});

app.get("/api/member/lookup", (req, res) => {
  const member = memberByPhone(req.query.phone);
  if (!member) return res.status(404).json({ error: "Member not found." });
  const history = db.prepare(`
    SELECT contribution_month,amount,status,payment_reference,paid_at
    FROM contributions WHERE member_id=? ORDER BY contribution_month DESC
  `).all(member.id);
  res.json({ member, history });
});

app.get("/api/reports/summary", (req, res) =>
  res.json({
    active_members: db.prepare("SELECT COUNT(*) AS c FROM members WHERE active=1").get().c,
    total_paid: db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM contributions WHERE status='paid'").get().total,
    total_unpaid: db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM contributions WHERE status='unpaid'").get().total
  })
);

app.get("/webhook/whatsapp", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN &&
    req.query["hub.challenge"]
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook/whatsapp", async (req, res) => {
  if (!verifyWhatsAppSignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages || [];
    for (const message of messages) {
      if (!message?.from) continue;
      const phone = cleanPhone(message.from);
      const member = memberByPhone(phone);
      console.log("WhatsApp message", {
        phone,
        memberName: member?.name || null,
        type: message.type
      });

      if (message.type !== "text") continue;

      if (!member) {
        await sendWhatsAppText(
          phone,
          "Hello! We could not find your WhatsApp number in the Maseray Temne Blogger member list. Please contact an administrator to register your number."
        );
        continue;
      }

      const latest = db.prepare(`
        SELECT contribution_month,amount,status
        FROM contributions WHERE member_id=? ORDER BY contribution_month DESC LIMIT 1
      `).get(member.id);

      const contributionLine = latest
        ? `Latest contribution: ${latest.contribution_month} — ${Number(latest.amount).toFixed(2)} (${latest.status}).`
        : "No contribution record has been entered yet.";

      await sendWhatsAppText(
        phone,
        `Hello ${member.name}! Your membership number is ${member.membership_number}. Your monthly contribution is ${Number(member.monthly_contribution).toFixed(2)}. ${contributionLine}`
      );
    }
  } catch (error) {
    console.error("Webhook processing error", error);
  }
});

app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "index.html"))
);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Maseray Temne Blogger running on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { app, db, cleanPhone };
