'use strict';
/**
 * Local SQLite store.
 *
 * Why SQLite and not "just Google Sheets":
 *   Sheets is a great VIEW but a poor database. Price history, repost detection
 *   and "is this listing still alive" all need reliable row identity, indexes
 *   and transactions. Doing that with Sheets row lookups over the network is
 *   slow and loses data on partial failures. So: SQLite is the source of truth,
 *   Sheets is a rendered view that can be rebuilt from it at any time.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

let Database;
try { Database = require('better-sqlite3'); }
catch { Database = null; }

let db = null;

function open() {
  if (db) return db;
  if (!Database) throw new Error('better-sqlite3 not installed. Run: npm install');
  fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  db = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  init();
  return db;
}

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    listing_id        TEXT PRIMARY KEY,
    url               TEXT NOT NULL,
    model_key         TEXT,
    model             TEXT,
    variant           TEXT,
    year              INTEGER,
    price             INTEGER,
    mileage           INTEGER,
    city              TEXT,
    location          TEXT,
    marketplace_distance INTEGER,
    calculated_distance  INTEGER,
    distance_used     INTEGER,
    distance_mismatch INTEGER DEFAULT 0,
    seller_name       TEXT,
    seller_type       TEXT,
    date_posted       TEXT,
    description       TEXT,
    title_status      TEXT,
    modifications     TEXT,
    visible_damage    TEXT,
    mechanical_concerns TEXT,
    photo_analysis    TEXT,
    pros              TEXT,
    cons              TEXT,
    market_value      INTEGER,
    price_vs_market   TEXT,
    deal_score        REAL,
    deal_label        TEXT,
    scam_risk         TEXT,
    scam_reason       TEXT,
    red_flags         TEXT,
    questions         TEXT,
    match_type        TEXT,
    missing_fields    TEXT,
    est_immediate_low INTEGER,
    est_immediate_high INTEGER,
    est_effective_low INTEGER,
    est_effective_high INTEGER,
    cost_breakdown    TEXT,
    images            TEXT,
    image_signature   TEXT,
    date_first_found  TEXT,
    last_checked      TEXT,
    last_seen_active  TEXT,
    status            TEXT DEFAULT 'Active',
    saved_on_facebook INTEGER DEFAULT 0,
    duplicate_status  TEXT,
    duplicate_of      TEXT,
    duplicate_confidence REAL,
    notes             TEXT
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  TEXT NOT NULL,
    old_price   INTEGER,
    new_price   INTEGER,
    delta       INTEGER,
    pct         REAL,
    changed_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ph_listing ON price_history(listing_id);

  CREATE TABLE IF NOT EXISTS runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT,
    finished_at     TEXT,
    scanned         INTEGER DEFAULT 0,
    opened          INTEGER DEFAULT 0,
    rejected        INTEGER DEFAULT 0,
    perfect         INTEGER DEFAULT 0,
    near            INTEGER DEFAULT 0,
    needs_review    INTEGER DEFAULT 0,
    new_listings    INTEGER DEFAULT 0,
    updated         INTEGER DEFAULT 0,
    duplicates      INTEGER DEFAULT 0,
    price_changes   INTEGER DEFAULT 0,
    removed         INTEGER DEFAULT 0,
    saved_fb        INTEGER DEFAULT 0,
    errors          TEXT,
    test_mode       INTEGER DEFAULT 1,
    notes           TEXT
  );

  CREATE TABLE IF NOT EXISTS model_cache (
    model_key    TEXT PRIMARY KEY,
    payload      TEXT,
    refreshed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_listings_model ON listings(model_key);
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_listings_match ON listings(match_type);
  `);
}

const J = v => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** Insert or update. Records a price_history row when the price moves. */
function upsertListing(rec) {
  open();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT listing_id, price, date_first_found FROM listings WHERE listing_id=?').get(rec.listingId);

  let priceChanged = null;
  if (existing && rec.price != null && existing.price != null && existing.price !== rec.price) {
    const delta = rec.price - existing.price;
    const pct = existing.price ? Math.round((delta / existing.price) * 1000) / 10 : null;
    db.prepare(`INSERT INTO price_history (listing_id, old_price, new_price, delta, pct, changed_at)
                VALUES (?,?,?,?,?,?)`).run(rec.listingId, existing.price, rec.price, delta, pct, now);
    priceChanged = { from: existing.price, to: rec.price, delta, pct };
  }

  const row = {
    listing_id: rec.listingId, url: rec.url,
    model_key: rec.modelKey, model: rec.model, variant: rec.variant,
    year: rec.year, price: rec.price, mileage: rec.mileage,
    city: rec.city, location: rec.location,
    marketplace_distance: rec.marketplaceDistance, calculated_distance: rec.calculatedDistance,
    distance_used: rec.distanceUsed, distance_mismatch: rec.distanceMismatch ? 1 : 0,
    seller_name: rec.sellerName, seller_type: rec.sellerType,
    date_posted: rec.datePosted, description: rec.description,
    title_status: rec.titleStatus, modifications: J(rec.modifications),
    visible_damage: J(rec.visibleDamage), mechanical_concerns: J(rec.mechanicalConcerns),
    photo_analysis: J(rec.photoAnalysis), pros: J(rec.pros), cons: J(rec.cons),
    market_value: rec.marketValue, price_vs_market: rec.priceVsMarket,
    deal_score: rec.dealScore, deal_label: rec.dealLabel,
    scam_risk: rec.scamRisk, scam_reason: rec.scamReason,
    red_flags: J(rec.redFlags), questions: J(rec.questions),
    match_type: rec.matchType, missing_fields: J(rec.missingFields),
    est_immediate_low: rec.estImmediateLow, est_immediate_high: rec.estImmediateHigh,
    est_effective_low: rec.estEffectiveLow, est_effective_high: rec.estEffectiveHigh,
    cost_breakdown: J(rec.costBreakdown),
    images: J(rec.images), image_signature: rec.imageSignature,
    date_first_found: existing?.date_first_found || now,
    last_checked: now, last_seen_active: now,
    status: rec.status || 'Active',
    saved_on_facebook: rec.savedOnFacebook ? 1 : 0,
    duplicate_status: rec.duplicateStatus, duplicate_of: rec.duplicateOf,
    duplicate_confidence: rec.duplicateConfidence, notes: rec.notes,
  };

  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO listings (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})
     ON CONFLICT(listing_id) DO UPDATE SET ${cols.filter(c => c !== 'listing_id' && c !== 'date_first_found')
       .map(c => `${c}=excluded.${c}`).join(',')}`
  ).run(row);

  return { isNew: !existing, priceChanged };
}

const getListing   = id => (open(), db.prepare('SELECT * FROM listings WHERE listing_id=?').get(id));
const allListings  = () => (open(), db.prepare('SELECT * FROM listings ORDER BY deal_score DESC NULLS LAST').all());
// Oldest check first. Without the ORDER BY this returned rowid order, and
// checkRemoved()'s .slice(0, max) therefore re-checked the SAME first 15
// listings every hour while everything after row 15 was never re-checked at
// all -- dead listings past that point stayed Active indefinitely.
const activeIds    = () => (open(), db.prepare(`SELECT listing_id,url FROM listings WHERE status='Active' ORDER BY last_checked ASC`).all());
const priceHistory = id => (open(), db.prepare('SELECT * FROM price_history WHERE listing_id=? ORDER BY changed_at').all(id));

/** Comparables for market value: anything we have ever seen of that model. */
function comparables(modelKey) {
  open();
  return db.prepare(
    `SELECT model_key AS modelKey, year, price, mileage FROM listings
     WHERE model_key=? AND price IS NOT NULL`
  ).all(modelKey);
}

/** Candidate pool for repost detection. */
function repostCandidates(modelKey, excludeId) {
  open();
  return db.prepare(
    `SELECT listing_id, model_key, year, price, mileage, city, seller_name, description, image_signature
     FROM listings WHERE model_key=? AND listing_id != ?`
  ).all(modelKey, excludeId || '');
}

/**
 * Record that a listing was re-checked and found still alive. Without this,
 * ORDER BY last_checked in activeIds() was not enough: checkRemoved() only
 * wrote to the DB for gone/sold listings, so a living listing kept its old
 * last_checked, stayed "oldest", and the same 15 were re-checked every hour
 * -- verified live: the next-15 set was identical before and after a run.
 */
function touchChecked(listingId) {
  open();
  db.prepare(`UPDATE listings SET last_checked=?, last_seen_active=? WHERE listing_id=?`)
    .run(new Date().toISOString(), new Date().toISOString(), listingId);
}

function markRemoved(listingId, status = 'Removed') {
  open();
  db.prepare(`UPDATE listings SET status=?, last_checked=? WHERE listing_id=?`)
    .run(status, new Date().toISOString(), listingId);
}

function startRun() {
  open();
  const r = db.prepare(`INSERT INTO runs (started_at, test_mode) VALUES (?,?)`)
    .run(new Date().toISOString(), cfg.testMode ? 1 : 0);
  return r.lastInsertRowid;
}

function finishRun(id, stats) {
  open();
  db.prepare(`UPDATE runs SET finished_at=@finished_at, scanned=@scanned, opened=@opened,
    rejected=@rejected, perfect=@perfect, near=@near, needs_review=@needs_review,
    new_listings=@new_listings, updated=@updated, duplicates=@duplicates,
    price_changes=@price_changes, removed=@removed, saved_fb=@saved_fb,
    errors=@errors, notes=@notes WHERE id=@id`).run({
      id, finished_at: new Date().toISOString(),
      scanned: stats.scanned | 0, opened: stats.opened | 0, rejected: stats.rejected | 0,
      perfect: stats.perfect | 0, near: stats.near | 0, needs_review: stats.needsReview | 0,
      new_listings: stats.newListings | 0, updated: stats.updated | 0,
      duplicates: stats.duplicates | 0, price_changes: stats.priceChanges | 0,
      removed: stats.removed | 0, saved_fb: stats.savedFb | 0,
      errors: J(stats.errors || []), notes: stats.notes || null,
    });
}

const recentRuns = (n = 25) => (open(), db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(n));

/* model cache */
function getModelCache(key) {
  open();
  const r = db.prepare('SELECT * FROM model_cache WHERE model_key=?').get(key);
  if (!r) return null;
  const ageH = (Date.now() - new Date(r.refreshed_at).getTime()) / 3600000;
  return { payload: JSON.parse(r.payload), refreshedAt: r.refreshed_at, stale: ageH > cfg.modelCacheTtlHours };
}
function setModelCache(key, payload) {
  open();
  db.prepare(`INSERT INTO model_cache (model_key,payload,refreshed_at) VALUES (?,?,?)
              ON CONFLICT(model_key) DO UPDATE SET payload=excluded.payload, refreshed_at=excluded.refreshed_at`)
    .run(key, JSON.stringify(payload), new Date().toISOString());
}

module.exports = {
  open, upsertListing, getListing, allListings, activeIds, priceHistory,
  comparables, repostCandidates, markRemoved, touchChecked,
  startRun, finishRun, recentRuns, getModelCache, setModelCache,
};

if (require.main === module && process.argv.includes('--init')) {
  open();
  console.log('Initialised SQLite at', cfg.dbPath);
}
