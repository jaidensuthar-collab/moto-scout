'use strict';
/**
 * Google Sheets as the VIEW layer.
 *
 * SQLite is the source of truth. Code here owns exactly three tabs -- Master
 * Listings, Price History, Logs -- rewriting them completely on every sync.
 *
 * On 2026-10-05 Jaiden reorganised the sheet by hand: he deleted the
 * code-generated Dashboard/Perfect/Near/Review/Best/Removed/Aprilia tabs (all
 * reproducible from Master Listings) and replaced them with per-brand tabs
 * (Kawasaki, Yamaha, CFMoto, Honda) that are each a SINGLE live FILTER/SORT
 * formula in A2 reading off Master Listings, not pasted values. They
 * self-update as Master Listings changes and were never meant to be written
 * by this code again.
 *
 * This matters structurally: the old code cleared and repasted every brand
 * tab on every sync, which would have silently destroyed those formulas the
 * next time it ran. Brand tabs are now READ-ONLY from this file's
 * perspective -- the only thing still done to them is applying conditional
 * formatting (a color scale on the Score column), which changes cell display,
 * never cell content, so it cannot touch the formula underneath.
 */
const fs = require('fs');
const cfg = require('./config');
const db = require('./db');

let google = null;
try { ({ google } = require('googleapis')); } catch { google = null; }

const TAB = {
  master:   'Master Listings',
  history:  'Price History',
  logs:     'Logs',
};

/**
 * Brand tabs this code may apply FORMATTING to but must never clear or
 * overwrite -- see the file header. Derived from cfg.models so a newly
 * tracked brand (e.g. adding a Suzuki model) is picked up automatically;
 * Jaiden still has to create that tab by hand with its own FILTER formula,
 * exactly like he did for Kawasaki/Yamaha/CFMoto/Honda.
 */
const BRANDS = [...new Set(cfg.models.map(m => m.label.split(' ')[0]))];
const brandOf = model => (model || '').split(' ')[0];

/** In TEST_MODE every tab name gets a suffix so production views are untouched. */
function tabName(key) {
  return cfg.testMode ? `${TAB[key]} _TEST` : TAB[key];
}

function brandTabName(brand) {
  return cfg.testMode ? `${brand} _TEST` : brand;
}

const HEADERS = [
  'Unique Listing ID', 'Facebook Listing URL', 'Motorcycle Model', 'Exact Variant', 'Year',
  'Listed Price', 'Mileage', 'Marketplace Distance', 'Calculated Distance', 'City', 'Location',
  'Seller Name', 'Seller Type', 'Date Posted', 'Listing Description', 'Title Status',
  'Modifications', 'Visible Damage', 'Mechanical Concerns', 'Photo Analysis', 'Pros', 'Cons',
  'Market Value Estimate', 'Price Compared With Market', 'Deal Score', 'Deal Label',
  'Scam Risk', 'Scam Risk Reason', 'Red Flags', 'Questions To Ask Seller',
  'Match Type', 'Missing Information',
  'Estimated Immediate Maintenance Cost', 'Estimated Repair Cost', 'Estimated Additional Cost',
  'Estimated Real Purchase Cost',
  'Date First Found', 'Last Checked', 'Last Price', 'Current Price', 'Price Change',
  'Listing Status', 'Saved On Facebook', 'Duplicate or Repost Status', 'Original Listing ID If Duplicate',
  'Notes',
];

const HISTORY_HEADERS = ['Listing ID', 'Model', 'Old Price', 'New Price', 'Change', 'Percent', 'Changed At', 'URL'];
const LOG_HEADERS = ['Run Started', 'Run Finished', 'Test Mode', 'Scanned', 'Opened', 'Rejected',
  'Perfect', 'Near', 'Needs Review', 'New', 'Updated', 'Duplicates', 'Price Changes',
  'Removed', 'Saved On Facebook', 'Errors'];

const asList = v => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(' • ');
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.join(' • ') : String(v); }
  catch { return String(v); }
};

/** One DB row → one spreadsheet row, in HEADERS order. */
function rowFor(r, history) {
  const h = history?.filter(p => p.listing_id === r.listing_id) || [];
  const last = h.length ? h[h.length - 1] : null;
  return [
    r.listing_id, r.url, r.model || '', r.variant || '', r.year ?? '',
    r.price ?? '', r.mileage ?? '', r.marketplace_distance ?? '', r.calculated_distance ?? '',
    r.city || '', r.location || '',
    r.seller_name || '', r.seller_type || '', r.date_posted || '',
    (r.description || '').slice(0, 1800), r.title_status || 'Unknown',
    asList(r.modifications), asList(r.visible_damage), asList(r.mechanical_concerns),
    (r.photo_analysis || '').slice(0, 1200),
    asList(r.pros), asList(r.cons),
    r.market_value ?? '', r.price_vs_market || '',
    r.deal_score ?? '', r.deal_label || '',
    r.scam_risk || '', r.scam_reason || '', asList(r.red_flags), asList(r.questions),
    r.match_type || '', asList(r.missing_fields),
    r.est_immediate_low != null ? `$${r.est_immediate_low}-$${r.est_immediate_high}` : '',
    '',  // Estimated Repair Cost is broken out inside cost_breakdown
    '',  // Estimated Additional Cost likewise
    r.est_effective_low != null ? `$${r.est_effective_low}-$${r.est_effective_high}` : '',
    (r.date_first_found || '').slice(0, 19), (r.last_checked || '').slice(0, 19),
    last ? last.old_price : '', r.price ?? '',
    last ? `${last.delta > 0 ? '+' : ''}${last.delta} (${last.pct}%)` : '',
    r.status || 'Active', r.saved_on_facebook ? 'Yes' : 'No',
    r.duplicate_status || 'Unique', r.duplicate_of || '',
    r.notes || '',
  ];
}

async function client() {
  if (!google) throw new Error('googleapis not installed. Run: npm install');
  if (!cfg.sheetId) throw new Error('SHEET_ID is not set in .env');
  if (!cfg.googleSaJson || !fs.existsSync(cfg.googleSaJson)) {
    throw new Error(`Service-account JSON not found at ${cfg.googleSaJson}`);
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: cfg.googleSaJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

/**
 * Create any missing CODE-OWNED tabs (Master/History/Logs). Safe to call every
 * run. Deliberately does NOT touch brand tabs -- their lifecycle belongs to
 * Jaiden now (see the file header). Auto-creating a deleted brand tab would
 * leave it empty with no formula, which looks broken rather than helpful.
 */
async function ensureTabs(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheetId });
  const have = new Set(meta.data.sheets.map(s => s.properties.title));
  const want = Object.keys(TAB).map(tabName);
  const missing = want.filter(t => !have.has(t));
  if (!missing.length) return { created: [] };
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.sheetId,
    requestBody: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) },
  });
  return { created: missing };
}

async function writeTab(sheets, title, header, rows, opts = {}) {
  await sheets.spreadsheets.values.clear({ spreadsheetId: cfg.sheetId, range: `${title}!A1:ZZ100000` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: cfg.sheetId,
    range: `${title}!A1`,
    // USER_ENTERED so =HYPERLINK() renders as a link instead of literal text.
    valueInputOption: opts.formulas ? 'USER_ENTERED' : 'RAW',
    requestBody: { values: [header, ...rows] },
  });
  if (!opts.widths && !opts.freezeHeader) return;

  // Formatting pass: column widths + frozen header + bold header row, so the
  // tab is readable the moment you open it rather than needing manual fiddling.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheetId });
  const sheet = meta.data.sheets.find(s => s.properties.title === title);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;
  const requests = [];

  if (opts.widths) {
    opts.widths.forEach((px, i) => requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    }));
  }
  if (opts.freezeHeader) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.92, green: 0.93, blue: 0.95 },
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // Wrap everything so long cells grow vertically instead of being clipped.
    requests.push({
      repeatCell: {
        range: { sheetId },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
      },
    });
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: cfg.sheetId, requestBody: { requests } });
  }
}

/**
 * Write every tab in as few API calls as possible.
 *
 * writeTab() above does 2-3 calls PER tab (clear, update, a metadata get +
 * batchUpdate for formatting) -- with 13 tabs that is 30+ requests every
 * sync. Running two syncs back to back during testing tripped Sheets'
 * per-minute write-request quota ("Quota exceeded... Write requests per
 * minute"), which is exactly the kind of failure an hourly automation can't
 * afford to hit. The Sheets API supports batching natively: one batchClear
 * for every range, one values.batchUpdate per valueInputOption (RAW and
 * USER_ENTERED can't share a call), and one formatting batchUpdate covering
 * every tab. That takes the whole sync from 30+ calls down to about 5,
 * regardless of how many tabs exist.
 */
async function writeTabsBatched(sheets, tabs) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheetId });
  const sheetIdByTitle = Object.fromEntries(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId: cfg.sheetId,
    requestBody: { ranges: tabs.map(t => `${t.title}!A1:ZZ100000`) },
  });

  const toData = list => list.map(t => ({ range: `${t.title}!A1`, values: [t.header, ...t.rows] }));
  const formulaTabs = tabs.filter(t => t.opts?.formulas);
  const rawTabs = tabs.filter(t => !t.opts?.formulas);
  if (rawTabs.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cfg.sheetId,
      requestBody: { valueInputOption: 'RAW', data: toData(rawTabs) },
    });
  }
  if (formulaTabs.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cfg.sheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: toData(formulaTabs) },
    });
  }

  const requests = [];
  for (const t of tabs) {
    const sheetId = sheetIdByTitle[t.title];
    if (sheetId == null) continue; // tab vanished between ensureTabs() and here -- skip, don't crash the whole sync
    if (t.opts?.widths) {
      t.opts.widths.forEach((px, i) => requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: px },
          fields: 'pixelSize',
        },
      }));
    }
    if (t.opts?.freezeHeader) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      });
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.92, green: 0.93, blue: 0.95 },
            },
          },
          fields: 'userEnteredFormat(textFormat,backgroundColor)',
        },
      });
      requests.push({
        repeatCell: {
          range: { sheetId },
          cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
          fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
        },
      });
    }
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: cfg.sheetId, requestBody: { requests } });
  }
}

/** Rebuild every tab from SQLite. */
async function syncAll() {
  const sheets = await client();
  const created = await ensureTabs(sheets);

  const all = db.allListings();
  const history = db.open().prepare('SELECT * FROM price_history ORDER BY changed_at').all();

  const active = all.filter(r => r.status === 'Active');
  const rows = r => r.map(x => rowFor(x, history));
  const READABLE = { freezeHeader: true };

  const byId = Object.fromEntries(all.map(r => [r.listing_id, r]));

  // Only the 3 code-owned tabs get written. See the file header: everything
  // else (brand tabs) is a live formula Jaiden built and owns -- writing to
  // them here would clear the formula and paste static values over it.
  await writeTabsBatched(sheets, [
    { title: tabName('master'), header: HEADERS, rows: rows(all), opts: READABLE },
    { title: tabName('history'), header: HISTORY_HEADERS, rows: history.map(p => [
        p.listing_id, byId[p.listing_id]?.model || '', p.old_price, p.new_price,
        `${p.delta > 0 ? '+' : ''}${p.delta}`, `${p.pct}%`, p.changed_at, byId[p.listing_id]?.url || '',
      ]), opts: READABLE },
    { title: tabName('logs'), header: LOG_HEADERS, rows: db.recentRuns(100).map(r => [
        r.started_at, r.finished_at, r.test_mode ? 'TEST' : 'LIVE', r.scanned, r.opened, r.rejected,
        r.perfect, r.near, r.needs_review, r.new_listings, r.updated, r.duplicates,
        r.price_changes, r.removed, r.saved_fb, (r.errors || '').slice(0, 900),
      ]), opts: READABLE },
  ]);

  // Still computed and returned even though there's no Perfect/Near/Best tab
  // anymore -- useful summary numbers for n8n's run-summary step, cheap to
  // compute, costs no extra API calls.
  const brandCounts = {};
  for (const brand of BRANDS) brandCounts[brand] = active.filter(r => brandOf(r.model) === brand).length;

  return {
    ok: true, testMode: cfg.testMode, createdTabs: created.created,
    counts: {
      master: all.length, perfect: active.filter(r => r.match_type === 'Perfect Match').length,
      near: active.filter(r => r.match_type === 'Near Match').length,
      review: active.filter(r => r.match_type === 'Needs Review').length,
      byBrand: brandCounts,
      removed: all.filter(r => r.status !== 'Active').length,
      history: history.length,
    },
  };
}

/**
 * Column positions of Deal Score and Scam Risk, 0-indexed, for each sheet
 * this applies color coding to. Master Listings uses the full 46-col HEADERS
 * layout (Y, AA); every brand tab uses Jaiden's 12-col layout (B, K) -- see
 * the live formula in the file header, column order Match/Score/Deal/Year/
 * Bike/Price/Miles/Mi Away/City/Title/Risk/Link.
 */
function colorScaleTargets() {
  return [
    { title: tabName('master'), scoreCol: 24, riskCol: 26 },
    ...BRANDS.map(b => ({ title: brandTabName(b), scoreCol: 1, riskCol: 10 })),
  ];
}

/**
 * Color-code Deal Score (red-to-green gradient, 0-10) and Scam Risk
 * (LOW/MEDIUM/HIGH badges) on Master Listings and every brand tab.
 *
 * Safe to run against the brand tabs: conditional formatting changes cell
 * DISPLAY, never cell content, so it cannot touch the live FILTER formula
 * underneath (see the file header). NOT called from syncAll() -- formatting
 * rules are a standing sheet property, not something to regenerate hourly;
 * doing that would stack duplicate rules forever. Call this once, or again
 * after adding a new brand tab. Idempotent: clears this file's own rules on
 * each target sheet before re-adding them, so re-running never duplicates.
 */
async function applyColorScale(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheetId });
  const byTitle = Object.fromEntries(meta.data.sheets.map(s => [s.properties.title, s]));
  const targets = colorScaleTargets().filter(t => byTitle[t.title]);

  const requests = [];
  for (const t of targets) {
    const sheet = byTitle[t.title];
    const existing = sheet.conditionalFormats || [];
    for (let i = existing.length - 1; i >= 0; i--) {
      requests.push({ deleteConditionalFormatRule: { sheetId: sheet.properties.sheetId, index: i } });
    }
  }
  for (const t of targets) {
    const sheetId = byTitle[t.title].properties.sheetId;
    requests.push({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: t.scoreCol, endColumnIndex: t.scoreCol + 1 }],
          gradientRule: {
            minpoint: { type: 'NUMBER', value: '0', color: { red: 0.96, green: 0.49, blue: 0.47 } },
            midpoint: { type: 'NUMBER', value: '5', color: { red: 1, green: 0.95, blue: 0.6 } },
            maxpoint: { type: 'NUMBER', value: '10', color: { red: 0.58, green: 0.85, blue: 0.56 } },
          },
        },
      },
    });
    const riskRule = (text, color) => ({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: t.riskCol, endColumnIndex: t.riskCol + 1 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] },
            format: { backgroundColor: color },
          },
        },
      },
    });
    requests.push(riskRule('LOW', { red: 0.78, green: 0.91, blue: 0.78 }));
    requests.push(riskRule('MEDIUM', { red: 1, green: 0.94, blue: 0.7 }));
    requests.push(riskRule('HIGH', { red: 0.96, green: 0.70, blue: 0.68 }));
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: cfg.sheetId, requestBody: { requests } });
  }
  return { tabs: targets.map(t => t.title) };
}

module.exports = {
  syncAll, ensureTabs, client, TAB, tabName, writeTab, writeTabsBatched,
  BRANDS, brandOf, brandTabName, applyColorScale, colorScaleTargets,
  HEADERS, HISTORY_HEADERS, LOG_HEADERS,
  rowFor,
};

if (require.main === module && process.argv.includes('--init')) {
  (async () => {
    try {
      const s = await client();
      const r = await ensureTabs(s);
      console.log('Tabs ensured. Created:', r.created.length ? r.created.join(', ') : '(none, all existed)');
    } catch (e) { console.error('FAILED:', e.message); process.exit(1); }
  })();
}
