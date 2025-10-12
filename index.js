// index.js — Tiny FOB (clean, Render-friendly)
const express = require("express");
const app = express();

const ADMIN = process.env.FOB_ADMIN_PASS || "testpass";

app.get('/status', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use((req, res, next) => {
  if (app.locals.killed && !req.path.startsWith("/admin")) {
    return res.status(503).send("Service unavailable");
  }
  next();
});

app.get('/status', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/", (_, res) => res.send("Tiny FOB container says hello."));
app.get("/go/:slug", (req, res) => {
  // simple redirect demo; add logging later if you want
  res.redirect(302, req.query.dest || "https://example.com");
});

app.post("/admin/kill", express.urlencoded({ extended: true }), (req, res) => {
  const pass = req.body.pass || req.query.pass;
  if (pass !== ADMIN) return res.status(403).send("forbidden");
  app.locals.killed = true;
  res.send("killed");
});

app.post("/admin/unkill", express.urlencoded({ extended: true }), (req, res) => {
  const pass = req.body.pass || req.query.pass;
  if (pass !== ADMIN) return res.status(403).send("forbidden");
  app.locals.killed = false;
  res.send("un-killed");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Tiny FOB running on port", port));
