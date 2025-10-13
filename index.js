// index.js — Tiny FOB (CJS) with Postgres logging + debug routes

const express   = require("express");
const rateLimit = require("express-rate-limit");
const { Pool }  = require("pg");

const app   = express();
const ADMIN = process.env.FOB_ADMIN_PASS || "testpass";

// ---------- DB setup ----------
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false } // needed for Render PG
  });

  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS clicks (
          id   BIGSERIAL PRIMARY KEY,
          ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
          ip   TEXT,
          ua   TEXT,
          slug TEXT,
          dest TEXT,
          qs   TEXT
        )
      `);
      console.log("clicks table ready");
    } catch (e) {
      console.error("DB init error:", e);
    }
  })();
} else {
  console.warn("DATABASE_URL not set — clicks will not be persisted");
}

// ---------- Health ----------
app.get("/status", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---------- Global kill switch ----------
app.use((req, res, next) => {
  if (app.locals.killed && !req.path.startsWith("/admin")) {
    return res.status(503).send("Service unavailable");
  }
  next();
});

// ---------- Home ----------
app.get("/", (_req, res) => res.send("Tiny FOB online."));

// ---------- Rate limit for redirector ----------
const goLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // 120 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/go", goLimiter);

// ---------- Redirector with logging ----------
app.get("/go/:slug", async (req, res) => {
  const slug = req.params.slug;
  const dest = req.query.dest || "https://example.com";

  const ip = (req.headers["x-forwarded-for"] || req.ip || "")
    .toString()
    .split(",")[0]
    .trim();
  const ua = req.get("user-agent") || "";
  const qs = req.originalUrl.includes("?")
    ? req.originalUrl.split("?")[1]
    : null;

  if (pool) {
    try {
      await pool.query(
        "INSERT INTO clicks(ip, ua, slug, dest, qs) VALUES ($1,$2,$3,$4,$5)",
        [ip, ua, slug, dest, qs]
      );
    } catch (e) {
      console.error("INSERT fail:", e);
      // still redirect even if logging fails
    }
  }

  return res.redirect(302, dest);
});

// ---------- Admin: kill / unkill ----------
const passFrom = (req) =>
  (req.body && req.body.pass) ||
  req.query.pass ||
  req.get("x-admin-pass");

app.post("/admin/kill", express.urlencoded({ extended: true }), (req, res) => {
  if (passFrom(req) !== ADMIN) return res.status(403).send("forbidden");
  app.locals.killed = true;
  res.send("killed");
});

app.post("/admin/unkill", express.urlencoded({ extended: true }), (req, res) => {
  if (passFrom(req) !== ADMIN) return res.status(403).send("forbidden");
  app.locals.killed = false;
  res.send("un-killed");
});

// ---------- Debug routes ----------
app.get("/admin/_envcheck", (_req, res) => {
  res.json({
    hasDB: !!process.env.DATABASE_URL,
    hasAdminPass: !!process.env.FOB_ADMIN_PASS
  });
});

app.get("/admin/_dbcheck", async (_req, res) => {
  if (!pool) return res.status(500).json({ ok: false, error: "no pool (DATABASE_URL missing?)" });
  try {
    const r = await pool.query("select now() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Tiny FOB running on port", port));// ─────────────────────────────────────────────
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

  // Initialize table automatically if missing
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
// KILL SWITCH (MAINTENANCE MODE)
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (app.locals.killed && !req.path.startsWith("/admin")) {
    return res.status(503).send("Service unavailable");
  }
  next();
});

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
// MAIN PAGE
// ─────────────────────────────────────────────
app.get("/", (_req, res) => res.send("👋 Tiny FOB is online and logging clicks."));

// ─────────────────────────────────────────────
// REDIRECTOR WITH LOGGING
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
// (You can add more /admin or analytics routes here)
// ─────────────────────────────────────────────

// 📦 Export last 1000 rows as CSV
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

// 🧾 Show last 5 logged clicks in JSON
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

// 🧮 Count clicks per slug
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
// (Always keep this as the last line)
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("🚀 Tiny FOB running on port", port));