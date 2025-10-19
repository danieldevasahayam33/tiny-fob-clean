// ─────────────────────────────────────────────
// index.js — Tiny FOB (Full Hardened Version)
// ─────────────────────────────────────────────

const express = require("express");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { Parser } = require("json2csv");
const { URL } = require("url");
const helmet = require("helmet");
const cors = require("cors");

const app = express();

// ─────────────────────────────────────────────
// SECURITY MIDDLEWARE
// ─────────────────────────────────────────────
app.disable("x-powered-by");
app.set("trust proxy", 1); // respect Render/CF proxy IPs
app.use(
  helmet({
    contentSecurityPolicy: false, // not enforcing CSP for this API-style service
    crossOriginResourcePolicy: { policy: "same-site" },
  })
);
app.use(cors({ origin: false })); // no cross-origin browser calls by default

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
        id   SERIAL PRIMARY KEY,
        ts   TIMESTAMPTZ DEFAULT now(),
        slug TEXT,
        dest TEXT,
        ip   TEXT,
        ua   TEXT
      )
    `);
    console.log("✅ Postgres connected, clicks table ready");
  })().catch((e) => console.error("DB init error:", e));
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
app.get("/", (_req, res) =>
  res.send("👋 Tiny FOB is online and logging clicks.")
);

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

  res.redirect(302, dest);
});

// ─────────────────────────────────────────────
// ✅ SAFE ZONE — Paste new routes BELOW this line
// ─────────────────────────────────────────────

// Daily CSV for a given UTC date (YYYY-MM-DD)
app.get("/admin/export/day", async (req, res) => {
  if (!adminOK(req)) return res.status(403).send("forbidden");

  // default = today UTC; allow override via ?day=YYYY-MM-DD
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
// ❌ DO NOT PASTE BELOW THIS LINE
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("🚀 Tiny FOB running on port", port));