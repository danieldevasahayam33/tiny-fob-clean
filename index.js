// index.js — Tiny FOB (CJS, Render-friendly, with Postgres logging)

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
    ssl: { rejectUnauthorized: false }
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

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Tiny FOB running on port", port));