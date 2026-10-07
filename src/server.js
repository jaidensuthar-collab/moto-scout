'use strict';
/**
 * Local helper API. n8n talks to this over HTTP.
 *
 * Why an HTTP service rather than n8n's Execute Command node:
 *   - The browser connection and SQLite handle stay warm between runs instead of
 *     paying process startup on every node execution.
 *   - n8n's HTTP Request node gives retries, timeouts and error branches for free.
 *   - Execute Command is unavailable or awkward in several n8n deployments.
 *   - Clean JSON in/out makes every stage independently testable with curl.
 *
 * Bound to 127.0.0.1 and protected by a shared secret header so nothing else on
 * the machine can drive your Facebook session.
 */
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const pipeline = require('./pipeline');
const sheets = require('./sheets');
const mp = require('./marketplace');
const { browserVersion, listTargets } = require('./cdp');

const app = express();
app.use(express.json({ limit: '4mb' }));

/** Shared-secret auth. Health check stays open so you can curl it easily. */
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!cfg.apiKey) return res.status(500).json({ error: 'SCOUT_API_KEY is not set in .env' });
  if (req.get('X-Scout-Key') !== cfg.apiKey) return res.status(401).json({ error: 'bad or missing X-Scout-Key' });
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e =>
  res.status(500).json({ error: String(e.message).slice(0, 400), stack: cfg.testMode ? e.stack : undefined }));

/* ── health / diagnostics ─────────────────────────────── */

app.get('/health', wrap(async (_req, res) => {
  let browser = null, tabs = null;
  try { browser = (await browserVersion(cfg.cdpUrl)).Browser; tabs = (await listTargets(cfg.cdpUrl)).length; }
  catch (e) { browser = `UNREACHABLE: ${e.message}`; }
  res.json({
    ok: true,
    testMode: cfg.testMode,
    facebookSaveEnabled: cfg.enableFacebookSave,
    notificationsEnabled: cfg.enableNotifications,
    browser, tabs,
    sheetConfigured: !!cfg.sheetId,
    aiProvider: cfg.ai.provider || '(none - heuristics only)',
    models: cfg.models.map(m => m.label),
  });
}));

/** Confirms we can see a logged-in Facebook session without touching credentials. */
app.get('/facebook/status', wrap(async (_req, res) => {
  const page = await mp.getPage();
  try {
    const blk = await mp.detectBlock(page);
    res.json({ loggedIn: !blk.blocked, ...blk, url: await page.eval('(()=>location.href)()') });
  } finally { page.close(); }
}));

/* ── stage-by-stage endpoints (each independently testable) ── */

app.post('/search', wrap(async (req, res) => {
  const { city = 'austin', query = 'yamaha r3', radius = 80, maxPrice } = req.body || {};
  const page = await mp.getPage();
  try {
    const r = await mp.search(page, { city, query, radius, maxPrice: maxPrice || cfg.searchMaxPrice });
    res.json({ ...r, cardCount: r.cards.length });
  } finally { page.close(); }
}));

app.post('/listing', wrap(async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  const page = await mp.getPage();
  try { res.json(await mp.openListing(page, url)); }
  finally { page.close(); }
}));

/** Analyse a single listing end-to-end without touching the browser again. */
app.post('/analyze', wrap(async (req, res) => {
  const { card = {}, detail = {} } = req.body || {};
  const parse = require('./parse');
  const listing = parse.normalize(card, detail);
  const a = await pipeline.analyzeListing(listing, { used: 0 });
  res.json({ listing, analysis: a, record: pipeline.toRecord(listing, a) });
}));

/** THE MAIN ENTRY POINT. n8n's hourly schedule calls this. */
app.post('/run', wrap(async (req, res) => {
  const limit = req.body?.limit;
  const out = await pipeline.runSweep({ limit });
  res.json(out);
}));

app.post('/check-removed', wrap(async (req, res) => {
  res.json(await pipeline.checkRemoved({ max: req.body?.max || 15 }));
}));

app.post('/sheets/sync', wrap(async (_req, res) => { res.json(await sheets.syncAll()); }));
app.post('/sheets/init', wrap(async (_req, res) => {
  const s = await sheets.client();
  res.json(await sheets.ensureTabs(s));
}));
/** Color-code Deal Score + Scam Risk on Master Listings and every brand tab.
 *  Not part of the hourly /sheets/sync -- call this once, or again after
 *  adding a new brand tab by hand. */
app.post('/sheets/colorize', wrap(async (_req, res) => {
  const s = await sheets.client();
  res.json(await sheets.applyColorScale(s));
}));

/* ── data access ──────────────────────────────────────── */

app.get('/listings', wrap(async (req, res) => {
  const all = db.allListings();
  const t = req.query.match;
  res.json({ count: all.length, listings: t ? all.filter(r => r.match_type === t) : all });
}));
app.get('/listings/:id', wrap(async (req, res) => {
  const r = db.getListing(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ ...r, priceHistory: db.priceHistory(req.params.id) });
}));
app.get('/runs', wrap(async (_req, res) => res.json(db.recentRuns(50))));

/* ── NOTIFICATIONS — architected, intentionally disabled ──
 *
 * To turn on later:
 *   1. ENABLE_NOTIFICATIONS=true in .env
 *   2. Implement a sender below (Discord webhook, Telegram, email, SMS...)
 *   3. In the n8n workflow, connect "Notification Gate" to a real notifier node.
 * The gate already receives exactly the payload a notifier would want, so
 * nothing upstream has to change.
 */
app.post('/notify', wrap(async (req, res) => {
  if (!cfg.enableNotifications) {
    return res.json({
      sent: false,
      reason: 'notifications disabled (ENABLE_NOTIFICATIONS=false)',
      wouldHaveSent: req.body || null,
    });
  }
  res.json({ sent: false, reason: 'no notifier implemented yet; add one in src/server.js /notify' });
}));

/* ── SELLER MESSAGING — deliberately NOT implemented ──────
 * Stubbed on purpose. Contacting sellers is an outward-facing action that
 * should never happen automatically. When you want it, it belongs behind an
 * explicit per-listing approval step, not a schedule trigger.
 */
app.post('/message-seller', (_req, res) => {
  res.status(501).json({
    error: 'not implemented by design',
    detail: 'Messaging sellers is an irreversible outward action. Add it only behind an explicit human approval step.',
  });
});

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`moto-scout helper listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  TEST_MODE=${cfg.testMode}  facebookSave=${cfg.enableFacebookSave}  ai=${cfg.ai.provider || 'none'}`);
  if (!cfg.apiKey) console.warn('  WARNING: SCOUT_API_KEY is empty. Set it in .env before using with n8n.');
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
module.exports = app;
