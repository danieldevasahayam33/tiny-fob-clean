// ─────────────────────────────────────────────
// index.js — Tiny FOB (Hardened + Metrics)
// ─────────────────────────────────────────────

const express = require("express");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { Parser } = require("json2csv");
const { URL } = require("url");
const helmet = require("helmet");
const cors = require("cors");
const client = require("prom-client");

const app = express();

// ─────────────────────────────────────────────
// METRICS SETUP
// ─────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register }); // node/process metrics

// Custom counter for redirects
const clicksTotal = new client.Counter({
  name: "clicks_total",
  help: "Total number of redirects recorded",
  labelNames: ["slug"],
});
register.registerMetric(clicksTotal);

// ─────────────────────────────────────────────
// SECURITY MIDDLEWARE
// ─────────────────────────────────────────────
app.disable("x-powered-by");
app.set("trust proxy", 1); // respect Render/CF proxy IPs
app.use(
  helmet({
    contentSecurityPolicy: false, // API-style service; CSP optional
    crossOriginResourcePolicy: { policy: "same-site" },
  })
);
app.use(cors({ origin: false })); // disallow cross-origin browser calls by default

// ─────────────────────────────────────────────
// METRICS SETUP (Prometheus)
// ─────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register }); // node/process metrics

// Custom counter for redirects
const clicksTotal = new client.Counter({
  name: "clicks_total",
  help: "Total number of redirects recorded",
  labelNames: ["slug"],
});
register.registerMetric(clicksTotal);

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────
const ADMIN = process.env.FOB_ADMIN_PASS || "testpass";
const DATABASE_URL = process.env.DATABASE_URL;

// Optional: comma-separated list of allowed redirect hostnames
// e.g. DEST_HOST_ALLOWLIST="example.com,example.org"
const DEST_HOST_ALLOWLIST = (process.env.DEST_HOST_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Header-only admin check (avoid leaking creds in URLs/logs)
function adminOK(req) {
  return req.get("x-admin-pass") === ADMIN;
}

// ─────────────────────────────────────────────
// DATABASE INITIALIZATION (hardened)
// ─────────────────────────────────────────────
let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // Pool-level error guard so a broken idle client doesn’t crash the app
  pool.on("error", (err) => {
    console.error("🧯 pg pool error:", err.message);
  });

  (async () => {
    // Per-connection session settings: timeouts + tag
    await pool.query(`
      SET application_name = 'tiny-fob';
      SET statement_timeout = '15s';
      SET idle_in_transaction_session_timeout = '10s';
    `);

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clicks (
        id   SERIAL PRIMARY KEY,
        ts   TIMESTAMPTZ DEFAULT now(),
        slug TEXT,
        dest TEXT,
        ip   TEXT,
        ua   TEXT
      )
    `);

    // Helpful indexes (idempotent)
    await pool.query(`CREATE INDEX IF NOT EXISTS clicks_ts_idx   ON clicks(ts);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS clicks_slug_idx ON clicks(slug);`);

    console.log("✅ Postgres connected, clicks table/indexes ready");
  })().catch((e) => console.error("DB init error:", e));
} else {
  console.warn("⚠️ No DATABASE_URL found. Logging disabled.");
}

// Graceful shutdown for Render restarts / deploys
const shutdown = async (signal) => {
  try {
    console.log(`🛑 ${signal} received, closing pg pool...`);
    if (pool) await pool.end();
  } catch (e) {
    console.error("pg pool shutdown error:", e);
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─────────────────────────────────────────────
// HEALTH CHECK
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
// KILL SWITCH (maintenance mode)
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (app.locals.killed && !req.path.startsWith("/admin")) {
    return res.status(503).send("Service unavailable");
  }
  next();
});

app.post("/admin/kill", express.urlencoded({ extended: true }), (req, res) => {
  if (!adminOK(req)) return res.status(403).send("forbidden");
  app.locals.killed = true;
  res.send("killed");
});

app.post("/admin/unkill", express.urlencoded({ extended: true }), (req, res) => {
  if (!adminOK(req)) return res.status(403).send("forbidden");
  app.locals.killed = false;
  res.send("un-killed");
});

// ─────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────
app.get("/", (_req, res) => res.send("👋 Tiny FOB is online and logging clicks."));

// ─────────────────────────────────────────────
// RATE LIMIT + SAFE REDIRECTOR
// ─────────────────────────────────────────────
const goLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/go", goLimiter);

function isAllowedDest(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (DEST_HOST_ALLOWLIST.length === 0) return true;
    return DEST_HOST_ALLOWLIST.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

app.get("/go/:slug", async (req, res) => {
  const slug = req.params.slug;
  const rawDest = req.query.dest || "https://example.com";
  const dest = isAllowedDest(rawDest) ? rawDest : "https://example.com";

  const ip = (req.headers["x-forwarded-for"] || req.ip || "")
    .split(",")[0]
    .trim();
  const ua = req.get("user-agent") || "";

  try {
    if (pool) {
      await pool.query(
        "INSERT INTO clicks (slug, dest, ip, ua) VALUES ($1,$2,$3,$4)",
        [slug, dest, ip, ua]
      );
    }
  } catch (e) {
    console.error("⚠️ insert fail:", e.message);
  }

  // metric
  clicksTotal.inc({ slug }, 1);

  res.redirect(302, dest);
});

// ─────────────────────────────────────────────
// ✅ SAFE ZONE — Admin/ops routes
// ─────────────────────────────────────────────

// Daily CSV for a given UTC date (YYYY-MM-DD)
app.get("/admin/export/day", async (req, res) => {
  if (!adminOK(req)) return res.status(403).send("forbidden");

  const day = (req.query.day || new Date().toISOString().slice(0, 10)).trim();

  try {
    const { rows } = await pool.query(
      `
      SELECT id, ts, ip, ua, slug, dest
      FROM clicks
      WHERE ts::date = $1::date
      ORDER BY id
    `,
      [day]
    );

    const csv = new Parser().parse(rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=clicks_${day}.csv`
    );
    res.send(csv);
  } catch (e) {
    res.status(500).send("export error: " + e.message);
  }
});

// CSV export (last 1000)
app.get("/admin/export", async (req, res) => {
  if (!adminOK(req)) return res.status(403).send("forbidden");
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
  if (!adminOK(req)) return res.status(403).send("forbidden");
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
  if (!adminOK(req)) return res.status(403).send("forbidden");
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
// METRICS ENDPOINT (Prometheus compatible)
// ─────────────────────────────────────────────
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// ─────────────────────────────────────────────
// METRICS ENDPOINT (Prometheus compatible)
// ─────────────────────────────────────────────
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});


// ─────────────────────────────────────────────
// ❌ DO NOT PASTE BELOW THIS LINE
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("🚀 Tiny FOB running on port", port));