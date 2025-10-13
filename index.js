// ─────────────────────────────────────────────
// index.js — Tiny FOB (Full Annotated Version)
// ─────────────────────────────────────────────

const express = require("express");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { Parser } = require("json2csv");
const app = express();

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────
const ADMIN = process.env.FOB_ADMIN_PASS || "testpass";
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────
// DATABASE INITIALIZATION
// ─────────────────────────────────────────────
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clicks (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMPTZ DEFAULT now(),
        slug TEXT,
        dest TEXT,
        ip TEXT,
        ua TEXT
      )
    `);
    console.log("✅ Postgres connected, clicks table ready");
  })();
} else {
  console.warn("⚠️ No DATABASE_URL found. Logging disabled.");
}

// ─────────────────────────────────────────────
// HEALTH CHECK ENDPOINT
// ─────────────────────────────────────────────
app.get("/status", async (_req, res) => {
  try {
    const r = pool
      ? await pool.query("SELECT count(*)::int AS c FROM clicks")
      : { rows: [{ c: 0 }] };
    res.json({ ok: true, ts: new Date().toISOString(), clicks: r.rows[0].c });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (app.locals.killed && !req.path.startsWith("/admin")) {
    return res.status(503).send("Service unavailable");
  }
  next();
});

// ─────────────────────────────────────────────
app.post("/admin/kill", express.urlencoded({ extended: true }), (req, res) => {
  if ((req.body.pass || req.query.pass) !== ADMIN) return res.status(403).send("forbidden");
  app.locals.killed = true;
  res.send("killed");
});

app.post("/admin/unkill", express.urlencoded({ extended: true }), (req, res) => {
  if ((req.body.pass || req.query.pass) !== ADMIN) return res.status(403).send("forbidden");
  app.locals.killed = false;
  res.send("un-killed");
});

// ─────────────────────────────────────────────
app.get("/", (_req, res) => res.send("👋 Tiny FOB is online and logging clicks."));

// ─────────────────────────────────────────────
const goLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/go", goLimiter);

app.get("/go/:slug", async (req, res) => {
  const slug = req.params.slug;
  const dest = req.query.dest || "https://example.com";
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const ua = req.get("user-agent") || "";

  try {
    if (pool)
      await pool.query("INSERT INTO clicks (slug, dest, ip, ua) VALUES ($1,$2,$3,$4)", [
        slug,
        dest,
        ip,
        ua,
      ]);
  } catch (e) {
    console.error("⚠️ insert fail:", e.message);
  }

  res.redirect(302, dest);
});

// ─────────────────────────────────────────────
// ✅ SAFE ZONE — Paste new routes BELOW this line
// ─────────────────────────────────────────────

// Daily CSV for a given UTC date (YYYY-MM-DD)
app.get("/admin/export/day", async (req, res) => {
  const pass = req.query.pass || req.get("x-admin-pass");
  if (pass !== (process.env.FOB_ADMIN_PASS || "testpass"))
    return res.status(403).send("forbidden");

  // default = today UTC; allow override via ?day=YYYY-MM-DD
  const day = (req.query.day || new Date().toISOString().slice(0,10)).trim();

  try {
    const { rows } = await pool.query(`
      SELECT id, ts, ip, ua, slug, dest, qs
      FROM clicks
      WHERE ts::date = $1::date
      ORDER BY id
    `, [day]);

    const csv = new (require("json2csv").Parser)().parse(rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=clicks_${day}.csv`);
    res.send(csv);
  } catch (e) {
    res.status(500).send("export error: " + e.message);
  }
});


// CSV export (last 1000)
app.get("/admin/export", async (req, res) => {
  if ((req.query.pass || req.get("x-admin-pass")) !== ADMIN)
    return res.status(403).send("forbidden");
  try {
    const { rows } = await pool.query(
      "SELECT * FROM clicks ORDER BY id DESC LIMIT 1000"
    );
    const csv = new Parser().parse(rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=clicks.csv");
    res.send(csv);
  } catch (e) {
    res.status(500).send("error exporting CSV: " + e.message);
  }
});

// Last 5 clicks (JSON)
app.get("/admin/last", async (req, res) => {
  if ((req.query.pass || req.get("x-admin-pass")) !== ADMIN)
    return res.status(403).send("forbidden");
  try {
    const { rows } = await pool.query(
      "SELECT ts, slug, left(dest,60) AS dest FROM clicks ORDER BY id DESC LIMIT 5"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clicks per slug
app.get("/admin/stats", async (req, res) => {
  if ((req.query.pass || req.get("x-admin-pass")) !== ADMIN)
    return res.status(403).send("forbidden");
  try {
    const { rows } = await pool.query(
      "SELECT slug, count(*)::int AS hits FROM clicks GROUP BY slug ORDER BY hits DESC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ❌ DO NOT PASTE BELOW THIS LINE
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("🚀 Tiny FOB running on port", port));