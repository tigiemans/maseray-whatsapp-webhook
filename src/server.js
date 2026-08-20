const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "change-this-webhook-token";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WHATSAPP_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Connect the Render Postgres database to this service.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

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

async function memberByPhone(phone) {
  const result = await pool.query(
    "SELECT * FROM members WHERE phone=$1 AND active=1",
    [cleanPhone(phone)]
  );
  return result.rows[0];
}

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

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      membership_number TEXT NOT NULL UNIQUE,
      monthly_contribution NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS contributions (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      contribution_month CHAR(7) NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid','unpaid')),
      payment_reference TEXT,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(member_id, contribution_month)
    );
    CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
    CREATE INDEX IF NOT EXISTS idx_contributions_member ON contributions(member_id);
    CREATE INDEX IF NOT EXISTS idx_contributions_month ON contributions(contribution_month);
  `);
  console.log("Persistent PostgreSQL database is ready.");
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "maseray-whatsapp-webhook", database: "postgres", time: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, error: "Database unavailable" });
  }
});

app.get("/api/members", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*,
        COALESCE(SUM(CASE WHEN c.status='paid' THEN c.amount ELSE 0 END),0) AS total_paid,
        COUNT(c.id)::INTEGER AS contribution_count
      FROM members m
      LEFT JOIN contributions c ON c.member_id=m.id
      WHERE m.active=TRUE
      GROUP BY m.id
      ORDER BY m.name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load members." });
  }
});

app.post("/api/members", async (req, res) => {
  try {
    const { name, phone, membership_number, monthly_contribution } = req.body;
    if (!String(name || "").trim() || !cleanPhone(phone) || !String(membership_number || "").trim()) {
      return res.status(400).json({ error: "Name, phone and membership number are required." });
    }
    if (!validNonNegativeNumber(monthly_contribution)) {
      return res.status(400).json({ error: "Monthly contribution must be a valid non-negative number." });
    }
    const result = await pool.query(
      "INSERT INTO members(name,phone,membership_number,monthly_contribution) VALUES($1,$2,$3,$4) RETURNING *",
      [String(name).trim(), cleanPhone(phone), String(membership_number).trim(), Number(monthly_contribution)]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: "Phone or membership number already exists." });
  }
});

app.put("/api/members/:id", async (req, res) => {
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
    const result = await pool.query(
      "UPDATE members SET name=$1,phone=$2,membership_number=$3,monthly_contribution=$4,active=$5 WHERE id=$6 RETURNING *",
      [String(name).trim(), cleanPhone(phone), String(membership_number).trim(), Number(monthly_contribution), active !== false, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Member not found." });
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: "Could not update member. Check phone and membership number." });
  }
});

app.delete("/api/members/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query("UPDATE members SET active=FALSE WHERE id=$1 RETURNING id", [id]);
    if (!result.rowCount) return res.status(404).json({ error: "Member not found." });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Could not deactivate member." });
  }
});

app.get("/api/contributions", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*,m.name,m.phone,m.membership_number
      FROM contributions c
      JOIN members m ON m.id=c.member_id
      ORDER BY c.contribution_month DESC,m.name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load contributions." });
  }
});

app.post("/api/contributions", async (req, res) => {
  const client = await pool.connect();
  try {
    const { member_id, contribution_month, amount, status, payment_reference } = req.body;
    const memberId = Number(member_id);
    if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: "A valid member is required." });
    if (!isValidMonth(contribution_month)) return res.status(400).json({ error: "Contribution month must use YYYY-MM format." });
    if (!validNonNegativeNumber(amount) || Number(amount) <= 0) return res.status(400).json({ error: "Amount must be greater than zero." });
    if (!["paid", "unpaid"].includes(status)) return res.status(400).json({ error: "Status must be paid or unpaid." });

    const member = await client.query("SELECT id FROM members WHERE id=$1 AND active=TRUE", [memberId]);
    if (!member.rowCount) return res.status(404).json({ error: "Member not found." });

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO contributions(member_id,contribution_month,amount,status,payment_reference,paid_at)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(member_id,contribution_month) DO UPDATE SET
        amount=EXCLUDED.amount,
        status=EXCLUDED.status,
        payment_reference=EXCLUDED.payment_reference,
        paid_at=EXCLUDED.paid_at
    `, [memberId, contribution_month, Number(amount), status, String(payment_reference || "").trim() || null, status === "paid" ? new Date() : null]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Contribution error", error);
    res.status(400).json({ error: "Could not save contribution." });
  } finally {
    client.release();
  }
});

app.get("/api/member/lookup", async (req, res) => {
  try {
    const member = await memberByPhone(req.query.phone);
    if (!member) return res.status(404).json({ error: "Member not found." });
    const history = await pool.query(`
      SELECT contribution_month,amount,status,payment_reference,paid_at
      FROM contributions WHERE member_id=$1 ORDER BY contribution_month DESC
    `, [member.id]);
    res.json({ member, history: history.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not look up member." });
  }
});

app.get("/api/reports/summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM members WHERE active=TRUE)::INTEGER AS active_members,
        (SELECT COALESCE(SUM(amount),0) FROM contributions WHERE status='paid') AS total_paid,
        (SELECT COALESCE(SUM(amount),0) FROM contributions WHERE status='unpaid') AS total_unpaid
    `);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Could not load summary." });
  }
});

app.get("/webhook/whatsapp", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN && req.query["hub.challenge"]) {
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
      if (!message?.from || message.type !== "text") continue;
      const phone = cleanPhone(message.from);
      const member = await memberByPhone(phone);
      if (!member) {
        await sendWhatsAppText(phone, "Hello! We could not find your WhatsApp number in the Maseray Temne Blogger member list. Please contact an administrator to register your number.");
        continue;
      }
      const latest = await pool.query(`
        SELECT contribution_month,amount,status FROM contributions
        WHERE member_id=$1 ORDER BY contribution_month DESC LIMIT 1
      `, [member.id]);
      const row = latest.rows[0];
      const contributionLine = row
        ? `Latest contribution: ${row.contribution_month} — ${Number(row.amount).toFixed(2)} (${row.status}).`
        : "No contribution record has been entered yet.";
      await sendWhatsAppText(phone, `Hello ${member.name}! Your membership number is ${member.membership_number}. Your monthly contribution is ${Number(member.monthly_contribution).toFixed(2)}. ${contributionLine}`);
    }
  } catch (error) {
    console.error("Webhook processing error", error);
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

async function start() {
  await initDatabase();
  const server = app.listen(PORT, "0.0.0.0", () => console.log(`Maseray Temne Blogger running on port ${PORT}`));
  function shutdown(signal) {
    console.log(`${signal}: shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch(error => {
  console.error("Startup failed", error);
  process.exit(1);
});

module.exports = { app, pool, cleanPhone };
