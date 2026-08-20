const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const port = 3100 + Math.floor(Math.random() * 500);
const dataFile = path.join(__dirname, "..", "data", "maseray.db");
const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (_) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy. Output:\n${output}`);
}

async function request(url, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

(async () => {
  try {
    const health = await waitForHealth();
    assert.equal(health.ok, true);

    const members = await request("/api/members");
    assert.equal(members.response.ok, true);
    assert.ok(Array.isArray(members.body));
    assert.ok(members.body.some(member => member.membership_number === "MTB-001"));

    const created = await request("/api/members", {
      method: "POST",
      body: JSON.stringify({
        name: "Smoke Test Member",
        phone: `232700${Date.now().toString().slice(-6)}`,
        membership_number: `SMOKE-${Date.now()}`,
        monthly_contribution: 100
      })
    });
    assert.equal(created.response.status, 201);

    const contribution = await request("/api/contributions", {
      method: "POST",
      body: JSON.stringify({
        member_id: created.body.id,
        contribution_month: "2026-08",
        amount: 100,
        status: "paid",
        payment_reference: "SMOKE-TEST"
      })
    });
    assert.equal(contribution.response.ok, true);

    const lookup = await request(`/api/member/lookup?phone=${encodeURIComponent(created.body.phone)}`);
    assert.equal(lookup.response.ok, true);
    assert.equal(lookup.body.member.name, "Smoke Test Member");
    assert.equal(lookup.body.history[0].status, "paid");

    const invalid = await request("/api/contributions", {
      method: "POST",
      body: JSON.stringify({ member_id: created.body.id, contribution_month: "bad-month", amount: 0, status: "paid" })
    });
    assert.equal(invalid.response.status, 400);

    console.log("Smoke test passed.");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      try { if (fs.existsSync(dataFile)) fs.rmSync(dataFile); } catch (_) {}
    }, 500);
  }
})();
