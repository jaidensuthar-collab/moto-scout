'use strict';
/**
 * Pre-flight. Run this first; it tells you exactly which piece is not ready
 * instead of making you debug a silent failure inside n8n.
 *   node src/selfcheck.js
 */
const fs = require('fs');
const cfg = require('./config');

const results = [];
const ok   = (n, d) => results.push({ n, s: 'OK', d });
const warn = (n, d) => results.push({ n, s: 'WARN', d });
const bad  = (n, d) => results.push({ n, s: 'FAIL', d });

(async () => {
  // Node version
  const major = Number(process.versions.node.split('.')[0]);
  major >= 20 ? ok('Node', `v${process.versions.node}`)
              : bad('Node', `v${process.versions.node} — need 20+ (global WebSocket/fetch)`);

  // Dependencies
  for (const dep of ['better-sqlite3', 'express', 'googleapis']) {
    try { require.resolve(dep); ok(`dep ${dep}`, 'installed'); }
    catch { bad(`dep ${dep}`, 'missing — run: npm install'); }
  }

  // .env
  fs.existsSync(require('path').join(cfg.root, '.env'))
    ? ok('.env', 'present')
    : bad('.env', 'missing — run: cp .env.example .env');

  cfg.apiKey ? ok('SCOUT_API_KEY', `set (${cfg.apiKey.length} chars)`)
             : bad('SCOUT_API_KEY', 'empty — generate: openssl rand -hex 24');

  // Browser / Facebook
  try {
    const { browserVersion, listTargets, openPage } = require('./cdp');
    const v = await browserVersion(cfg.cdpUrl);
    const t = await listTargets(cfg.cdpUrl);
    ok('Browser CDP', `${v.Browser} — ${t.length} tabs`);
    const fb = t.find(x => (x.url || '').includes('facebook.com'));
    if (fb) {
      const p = await openPage(cfg.cdpUrl, u => u.includes('facebook.com'));
      const mp = require('./marketplace');
      const blk = await mp.detectBlock(p);
      blk.blocked ? bad('Facebook session', `blocked: ${blk.reason}`)
                  : ok('Facebook session', 'appears logged in');
      p.close();
    } else {
      warn('Facebook session', 'no Facebook tab open — open facebook.com in Opera, or the helper will open one');
    }
  } catch (e) {
    bad('Browser CDP', `${e.message}. Launch Opera from ~/Applications/Opera.app (it passes --remote-debugging-port=9222)`);
  }

  // Database
  try { require('./db').open(); ok('SQLite', cfg.dbPath); }
  catch (e) { bad('SQLite', e.message); }

  // Sheets
  if (!cfg.sheetId) warn('Google Sheets', 'SHEET_ID not set — Sheets sync will be skipped');
  else if (!cfg.googleSaJson || !fs.existsSync(cfg.googleSaJson)) {
    bad('Google Sheets', `service-account JSON not found at ${cfg.googleSaJson}`);
  } else {
    try {
      const s = await require('./sheets').client();
      const meta = await s.spreadsheets.get({ spreadsheetId: cfg.sheetId });
      ok('Google Sheets', `"${meta.data.properties.title}" reachable`);
    } catch (e) {
      bad('Google Sheets', `${String(e.message).slice(0, 150)} — did you share the sheet with the service-account email as Editor?`);
    }
  }

  // AI
  cfg.ai.provider
    ? (cfg.ai.apiKey ? ok('AI vision', `${cfg.ai.provider} / ${cfg.ai.visionModel}`)
                     : bad('AI vision', `AI_PROVIDER=${cfg.ai.provider} but AI_API_KEY is empty`))
    : warn('AI vision', 'not configured — photo analysis falls back to TEXT heuristics and says so');

  // Safety switches
  ok('TEST_MODE', String(cfg.testMode) + (cfg.testMode ? ' (writes to _TEST tabs, no FB saves)' : ' (LIVE)'));
  ok('Facebook save', cfg.enableFacebookSave ? 'ENABLED' : 'disabled');
  ok('Notifications', cfg.enableNotifications ? 'ENABLED' : 'disabled (by design)');

  // JS dialog auto-dismiss. A blocked confirm()/alert() freezes the page's
  // main thread, which freezes every CDP eval -- this was the root cause of a
  // sweep that ran 52 minutes and wrote nothing. The first attempt at this fix
  // shipped broken: it sent Page.enable before the websocket had finished
  // opening, the send failed silently, and the dialog listener never received
  // anything. Caught only by actually triggering a dialog and timing the
  // eval that follows it.
  try {
    const { newPage, closeTarget, sleep } = require('./cdp');
    const page = await newPage(cfg.cdpUrl, 'https://example.com', { background: true });
    try {
      await sleep(1500);
      page.eval(`setTimeout(()=>{ try { confirm('selfcheck') } catch(e){} }, 200)`).catch(() => {});
      await sleep(1000);
      const t0 = Date.now();
      await page.eval('1+1', 3000);
      const ms = Date.now() - t0;
      ms < 1000
        ? ok('Dialog auto-dismiss', `eval returned in ${ms} ms while a dialog was open`)
        : bad('Dialog auto-dismiss', `eval took ${ms} ms -- the dialog is blocking the renderer again`);
    } finally {
      // page.close() only closes OUR websocket connection, not the real
      // browser tab (see cdp.js) -- every selfcheck run was leaving a fresh
      // example.com tab open forever. closeTarget() makes the actual close
      // request. Found by counting Opera's own tabs: 10 of them example.com,
      // one per selfcheck run today.
      await closeTarget(cfg.cdpUrl, page.meta.id).catch(() => {});
    }
  } catch (e) {
    warn('Dialog auto-dismiss', `could not test (${e.message}) -- is a browser tab reachable?`);
  }

  // Sheets write scope. Jaiden reorganised the spreadsheet by hand on
  // 2026-10-05: brand tabs (Kawasaki/Yamaha/CFMoto/Honda) are now his own live
  // FILTER formulas reading off Master Listings, not code-generated. The old
  // code cleared and repasted every brand tab on every sync, which would have
  // destroyed those formulas on the next run. This asserts the write path
  // only ever touches Master/History/Logs.
  try {
    const sheets = require('./sheets');
    const owned = Object.keys(sheets.TAB);
    const leaksBrands = owned.some(k => sheets.BRANDS.includes(sheets.TAB[k]));
    const onlyThree = owned.length === 3 && owned.includes('master') && owned.includes('history') && owned.includes('logs');
    (onlyThree && !leaksBrands)
      ? ok('Sheets write scope', 'TAB only covers master/history/logs; brand tabs untouched')
      : bad('Sheets write scope', `TAB = [${owned.join(', ')}] -- syncAll() may write over Jaiden's brand-tab formulas`);
  } catch (e) {
    bad('Sheets write scope', e.message);
  }

  // Model expansion (Honda CBR 300-600, Ninja 300, Yamaha MT-03, CFMoto
  // 300/500), added 2026-10-05. The CBR-out-of-range check needed its own
  // regex because the shared modelStated() word-boundary check silently
  // missed displacement digits glued directly to a trailing trim letter
  // ("CBR650R" has no boundary between "0" and "R") -- caught only by
  // testing the no-space form, not the spaced one.
  try {
    const p = require('./pipeline');
    const CASES = [
      ['2021 Honda CBR500R', true], ['2016 Honda CBR300R', true], ['2015 Honda CBR600RR', true],
      ['2019 Honda CBR', true],                 // bare CBR, no displacement -> still worth opening
      ['2020 Honda CBR650R', false],            // glued digits, the regression case
      ['2021 Honda CBR 650 R', false],           // spaced form
      ['2019 Honda CBR1000RR', false],
      ['2019 Honda Rebel', false], ['2018 Honda Africa Twin', false], ['2020 Honda Grom', false],
      ['2015 Kawasaki Ninja 300', true],
      ['2021 Yamaha MT-03', true], ['2021 Yamaha MT03', true], ['2022 Yamaha MT-07', false],
      ['2019 CFMoto 300NK', true], ['2022 CFMoto 500SR', true], ['2023 CFMoto 450SS', true],
      ['2021 Honda', true],                      // brand-only, still ambiguous-worth-opening
    ];
    const failed = CASES.filter(([title, want]) => {
      const raw = `$4,000 | ${title} | Austin, TX`;
      return p.cheapGate({ raw }).pass !== want;
    });
    failed.length
      ? bad('Model expansion', `${failed.length}/${CASES.length} wrong: ` + failed.map(([t]) => t).join('; '))
      : ok('Model expansion', `${CASES.length}/${CASES.length} regression cases pass`);
  } catch (e) {
    bad('Model expansion', e.message);
  }

  // Parts-listing detection. Two real misses here: "Bonamici Rearsets Yamaha
  // R3 2015+" ($505, no "rearset" anywhere in the old PART_RE) and a listing
  // titled "2023 Yamaha YZF-R" whose real description -- unreadable until the
  // openListing() heading fix -- was an R7 frame parted out piece by piece
  // ("R7 swing arm... $250", "R7 front brake calipers... $100"). Both are
  // asserted here: PART_RE itself, and that classify() rejects on ctx.isPart
  // regardless of what else is true about the listing.
  try {
    const { cheapGate } = require('./pipeline');
    const sc = require('./scoring');
    const PART_CASES = [
      ['$505 | Bonamici Rearsets Yamaha R3 2015+ | San Antonio, TX', false],
      ['$500 | 2023 Yamaha yzfr | Temple, TX', true], // card alone is ambiguous, not rejected -- the description is what catches it
      ['$4,000 | 2018 Kawasaki Ninja 400 | Round Rock, TX', true],
      ['$300 | Yamaha R3 swing arm with caliper | Austin, TX', false],
      ['$250 | Yamaha R3 master cylinder | Austin, TX', false],
      ['$400 | 2017 Yamaha R3, frame has no cracks, runs great | Austin, TX', true], // "frame" mentioned positively must NOT trip the filter
      // Found by auditing every stored record with a resolved model but no
      // price (a real for-sale post almost always has one) -- 9 of 9 turned
      // out to be parts or non-listings, none were motorcycles.
      ['$0 | 2025 Ninja 500 brake light | Austin, TX', false],
      ['$0 | Ninja 400 slip on | San Antonio, TX', false],
      ['$0 | 2025 Ninja 500 rear turn signal fender assembly | Austin, TX', false],
      ['$0 | Yamaha R3 header | Katy, TX', false],
      ['$0 | 2024 CFMOTO 450SS stock muffler | Copperas Cove, TX', false],
      ['$0 | Ninja 400 gas tank and fuel pump | Bryan, TX', false],
      ['$0 | 2018 ninja 400 clear wind screen | San Antonio, TX', false], // "windscreen" alone missed the two-word "wind screen" sellers actually type
      ['$0 | CFMoto Ibex 450 Lower engine guards crash bars | Austin, TX', false],
      ['$4,500 | 2024 Yamaha R3 ABS | San Antonio, TX', true],
      ['$3,900 | 2021 Honda CBR500R | Austin, TX', true],
      // A real listing titled "2025 Ninja 500 fairings" at $1,234 slipped
      // through and got stored as a genuine Ninja 500 -- the old $900
      // co-gate assumed every part is cheap, but a full fairing/bodywork kit
      // legitimately costs well over that.
      ['$1,234 | 2025 Ninja 500 fairings | San Antonio, TX', false],
    ];
    const DONATION_CASES = [
      ["Fund my dream with $1 Kawasaki ninja 500, cash.app/f/POOL", false],
      ['2018 Kawasaki Ninja 400, clean title, runs great', true],
    ];
    const donationFailed = DONATION_CASES.filter(([raw, wantPass]) => cheapGate({ raw }).pass !== wantPass);
    const partFailed = PART_CASES.filter(([raw, wantPass]) => cheapGate({ raw }).pass !== wantPass).concat(donationFailed);

    const ctx = extra => ({
      listing: { modelKey: 'yamaha_r3', ambiguous: null, year: { value: 2020 }, price: { value: 500 }, mileage: { value: 5000 } },
      title: { reject: false, status: { value: 'Clean' } }, mods: { major: [] }, distance: { used: 40 },
      ...extra,
    });
    const isPartRejects = sc.classify(ctx({ isPart: true })).type === 'Rejected';
    const normalNearMatches = sc.classify(ctx({ isPart: false })).type !== 'Rejected';

    const failed = partFailed.length + (isPartRejects ? 0 : 1) + (normalNearMatches ? 0 : 1);
    failed === 0
      ? ok('Parts detection', `${PART_CASES.length}/${PART_CASES.length} PART_RE cases + isPart short-circuit pass`)
      : bad('Parts detection', `${partFailed.length} PART_RE case(s) wrong; isPart short-circuit ${isPartRejects ? 'ok' : 'BROKEN'}`);
  } catch (e) {
    bad('Parts detection', e.message);
  }

  // CFMoto trim labeling + rental detection. Found auditing a real listing:
  // "2026 CFMOTO 450nk", a genuine for-sale bike, correctly priced, stored and
  // shown as "CFMoto 450SS" -- wrong model name, because one regex used to
  // catch SS/NK/SR under a single label. Same audit also found a daily
  // rental (riders-share.com) whose day rate had been stored as if it were a
  // purchase price.
  try {
    const cfg = require('./config');
    const { cheapGate } = require('./pipeline');
    const TRIM_CASES = [
      ['2026 CFMOTO 450nk', 'CFMoto 450NK'],
      ['2024 CFMOTO 450sr', 'CFMoto 450SR'],
      ['2023 CFMOTO 450ss', 'CFMoto 450SS'],
      ['2023 CFMOTO ss', 'CFMoto 450SS'],
    ];
    const trimFailed = TRIM_CASES.filter(([text, want]) => cfg.identifyModel(text)?.label !== want);
    const bareTrimAmbiguous = cfg.identifyModel('2024 CFMoto 450') == null
      && cfg.identifyAmbiguous('2024 CFMoto 450', 2024)?.key === 'maybe_cfmoto450';
    const rentalRejected = cheapGate({ raw: '$100 | 2026 CFMOTO 450ss daily rental riders-share.com | Austin, TX' }).pass === false;
    const failed = trimFailed.length + (bareTrimAmbiguous ? 0 : 1) + (rentalRejected ? 0 : 1);
    failed === 0
      ? ok('CFMoto trims + rental', `${TRIM_CASES.length}/${TRIM_CASES.length} trim labels correct, bare-450 ambiguous, rental rejected`)
      : bad('CFMoto trims + rental', `${trimFailed.length} trim label(s) wrong; bare-450 ambiguous: ${bareTrimAmbiguous}; rental rejected: ${rentalRejected}`);
  } catch (e) {
    bad('CFMoto trims + rental', e.message);
  }

  // Scout tab re-tagging. window.__motoScoutTab is wiped by every real
  // navigation (a full location.href change reloads the JS context), so
  // getPage() calling openListing() across SEPARATE runs -- exactly what the
  // hourly n8n schedule does against the same long-lived helper -- could
  // never find its own tab again once it had navigated anywhere. Caught by
  // counting Opera's own tabs: 13 Facebook tabs open, not one of them
  // tagged. Checked live: open the tab, navigate it, confirm the tag
  // survived, confirm a second getPage() call reattaches to the same tab
  // instead of creating a new one.
  try {
    const mp = require('./marketplace');
    const page1 = await mp.getPage();
    await mp.openListing(page1, 'https://www.facebook.com/marketplace/');
    const stillTagged = await page1.eval('(()=>!!window.__motoScoutTab)()', 4000).catch(() => false);
    const page2 = await mp.getPage();
    const reattached = page2.meta.id === page1.meta.id;
    (stillTagged && reattached)
      ? ok('Tab re-tagging', 'tag survives navigation; a second getPage() reattaches to the same tab')
      : bad('Tab re-tagging', `tag survived nav: ${stillTagged}; reattached to same tab: ${reattached} -- tabs will leak again`);
  } catch (e) {
    warn('Tab re-tagging', `could not test (${e.message}) -- is a browser tab reachable?`);
  }

  // Card-level distance prefilter + checkRemoved rotation. In one audit 39 of
  // 70 rejected listings were rejected purely for distance (Houston, Dallas,
  // Katy), each having first spent one of the 25 listing-opens a sweep gets;
  // the search card names the city, so they are now rejected before opening.
  // Separately, activeIds() had no ORDER BY, so checkRemoved() re-checked the
  // same first 15 rows every hour and never reached the rest.
  try {
    const { cheapGate } = require('./pipeline');
    const DIST = [
      ['$4,400 | 2021 Kawasaki Ninja 400 | Houston, TX', false],
      ['$3,500 | 2020 Honda CBR500R | Dallas, TX', false],
      ['$4,000 | 2018 Kawasaki Ninja 400 | Round Rock, TX', true],
      ['$4,200 | 2023 CFMoto 450SS | San Antonio, TX', true],   // 91 mi: inside the 100 mi near limit
      ['$4,000 | 2019 Yamaha R3 | Nowheresville, TX', true],    // unknown city must NOT be rejected
    ];
    const distFailed = DIST.filter(([raw, want]) => cheapGate({ raw }).pass !== want);
    const dbSrc = require('fs').readFileSync(require('path').join(__dirname, 'db.js'), 'utf8');
    const plSrc = require('fs').readFileSync(require('path').join(__dirname, 'pipeline.js'), 'utf8');
    // Both halves are needed: oldest-first ordering AND bumping last_checked on
    // listings found still alive. With only the first, the same 15 were still
    // re-checked every hour (verified live).
    const rotates = /activeIds[\s\S]{0,200}ORDER BY last_checked ASC/.test(dbSrc)
                 && /else db\.touchChecked\(/.test(plSrc);
    (distFailed.length === 0 && rotates)
      ? ok('Distance prefilter', `${DIST.length}/${DIST.length} card-distance cases pass; checkRemoved rotates oldest-first`)
      : bad('Distance prefilter', `${distFailed.length} distance case(s) wrong; activeIds ordered: ${rotates}`);
  } catch (e) {
    bad('Distance prefilter', e.message);
  }

  // Title-gate regression cases.
  //
  // Every one of these is a bug that actually shipped, so they are asserted on
  // every self-check rather than left to manual testing. The recurring theme is
  // bare numbers: "400" appears inside "$4,400" and "4,400 miles", which both
  // wrongly excluded genuine brand-only listings and wrongly opened a Kawasaki
  // jet ski as a possible Ninja 400.
  try {
    const { cheapGate } = require('./pipeline');
    const CASES = [
      // [card text, should we open it?, what it is testing]
      ['$3,400 | 2020 Kawasaki Mule | Kyle, TX',            false, 'ATV, price contains 400'],
      ['$2,400 | 2019 Kawasaki jet ski | Austin, TX',       false, 'watercraft, price contains 400'],
      ['$4,400 | 2021 Kawasaki Vulcan | Austin, TX',        false, 'cruiser'],
      ['$3,800 | 2019 Yamaha Grizzly | Buda, TX',           false, 'ATV'],
      ['$4,100 | 2017 Yamaha V Star | Austin, TX',          false, 'cruiser'],
      ['$4,000 | 2019 Yamaha MT-07 | Austin, TX',           false, 'naked, not tracked'],
      ['$4,000 | 2020 Kawasaki Z650 | Austin, TX',          false, 'naked, not tracked'],
      ['$3,000 | 2013 Kawasaki | Buda, TX',                 false, 'older than the near-match floor'],
      ['$4,400 | 2021 Kawasaki | Round Rock, TX',           true,  'brand only, price contains 400'],
      ['$3,500 | 2019 Kawasaki | 4,400 miles | Austin, TX', true,  'brand only, mileage contains 400'],
      ['$3,900 | 2019 Yamaha | Austin, TX',                 true,  'brand only'],
      ['$4,200 | 2024 CFMoto | San Antonio, TX',            true,  'brand only'],
      ['$4,000 | 2022 Aprilia | Austin, TX',                true,  'brand only'],
      ['$3,900 | 2019 Kawasaki 400 | Austin, TX',           true,  'real displacement'],
      ['$4,000 | 2021 Kawasaki ninja | Round Rock, TX',     true,  'Ninja, no displacement'],
      ['$4,000 | 2017 Yamaha YZF | Austin, TX',             true,  'YZF, no model number'],
      ['$3,900 | 2019 Kawasaki Ninja 400 | Austin, TX',     true,  'confirmed Ninja 400'],
      ['$4,000 | 2016 Yamaha R3 | Austin, TX',              true,  'confirmed R3'],
      ['$4,300 | 2024 Aprilia RS 457 | Austin, TX',         true,  'confirmed RS 457'],
    ];
    const failed = CASES.filter(([raw, want]) => !!cheapGate({ raw }).pass !== want);
    failed.length
      ? bad('Title gate', `${failed.length}/${CASES.length} wrong: ` +
            failed.map(([raw, , why]) => why).join('; '))
      : ok('Title gate', `${CASES.length}/${CASES.length} regression cases pass`);
  } catch (e) {
    bad('Title gate', e.message);
  }

  // Field extraction must read LISTING-scoped text only.
  //
  // A partially rendered detail page leaves Facebook's nav and the retained
  // search query in the body text. Matching a model against that made a real
  // listing titled "2023 CFMOTO ss" get stored as a Yamaha R3 and surface as
  // the second-best find at 8.3/10, purely because the search that found it
  // was for "yamaha r3".
  try {
    const parse = require('./parse');
    const CASES = [
      ['chrome cannot inject a model', 'model',
       { raw: '$3,000 | 2020 Honda Rebel | Austin, TX' },
       { title: '(1) Marketplace - 2020 Honda Rebel | Facebook',
         head: 'Marketplace | yamaha r3 | ninja 400 | Browse all', desc: '' }, null],
      ['title beats chrome', 'model',
       { raw: '$4,000 | 2023 CFMOTO ss | Austin, TX' },
       { title: '(1) Marketplace - 2023 CFMOTO ss | Facebook',
         head: 'Marketplace | yamaha r3 | Browse all', desc: '' }, 'CFMoto 450SS'],
      ['description resolves a vague title', 'model',
       { raw: '$4,000 | 2021 Kawasaki | Austin, TX' },
       { title: '(1) Marketplace - 2021 Kawasaki | Facebook', head: 'Marketplace | Browse all',
         desc: 'Selling my Ninja 400, 6k miles, clean title.' }, 'Kawasaki Ninja 400'],
      ['mileage ignores chrome figures', 'mileage',
       { raw: '$4,000 | 2019 Kawasaki Ninja 400 | Austin, TX' },
       { title: '(1) Marketplace - 2019 Kawasaki Ninja 400 | Facebook',
         head: 'Within 80 mi | 50,000 results | Marketplace', desc: 'Runs great, 7,200 miles.' }, 7200],
    ];
    const failed = CASES.filter(([, fieldName, card, detail, want]) => {
      const r = parse.normalize({ url: 'https://www.facebook.com/marketplace/item/1/', ...card }, detail);
      return r[fieldName].value !== want;
    });
    failed.length
      ? bad('Field extraction', `${failed.length}/${CASES.length} wrong: ` + failed.map(([n]) => n).join('; '))
      : ok('Field extraction', `${CASES.length}/${CASES.length} regression cases pass`);
  } catch (e) {
    bad('Field extraction', e.message);
  }

  // Classification ordering.
  //
  // Hard limits must be applied BEFORE the unconfirmed-model branch. This
  // ordering has regressed twice: once letting far listings with unknown
  // mileage into Needs Review, and once letting ANY ambiguous listing skip
  // every limit, which filled the review queue with things like a $199 item
  // 221 miles away whose only qualification was the word "Yamaha".
  try {
    const sc = require('./scoring');
    const AMB = { key: 'maybe_brand_only', note: 'Only a year and a brand were given, model not stated' };
    const ctx = o => ({
      listing: {
        modelKey: o.modelKey || null, ambiguous: o.ambiguous || null,
        year: { value: o.y ?? null }, price: { value: o.p ?? null }, mileage: { value: o.m ?? null },
      },
      title: { reject: !!o.titleReject, status: { value: o.title || 'Unknown' } },
      mods: { major: o.major || [] },
      distance: { used: o.d ?? null },
    });
    const CASES = [
      ['unresolved 221 mi away',      { ambiguous: AMB, d: 221, p: 4000 }, 'Rejected'],
      ['unresolved over price',       { ambiguous: AMB, d: 40, p: 9000 },  'Rejected'],
      ['unresolved salvage title',    { ambiguous: AMB, d: 40, p: 4000, titleReject: true, title: 'Salvage' }, 'Rejected'],
      ['unresolved but in range',     { ambiguous: AMB, d: 40, p: 4000 },  'Needs Review'],
      ['confirmed near match',        { modelKey: 'ninja_400', d: 91, p: 4000, y: 2021, m: 5000, title: 'Clean' }, 'Near Match'],
      ['confirmed perfect match',     { modelKey: 'ninja_400', d: 20, p: 4000, y: 2018, m: 10000, title: 'Clean' }, 'Perfect Match'],
    ];
    const failed = CASES.filter(([, o, want]) => sc.classify(ctx(o)).type !== want);
    failed.length
      ? bad('Classify order', `${failed.length}/${CASES.length} wrong: ` + failed.map(([n]) => n).join('; '))
      : ok('Classify order', `${CASES.length}/${CASES.length} regression cases pass`);
  } catch (e) {
    bad('Classify order', e.message);
  }

  // Focus policy. The scout must never pull Jaiden's window to its own tab, so
  // fronting is opt-in and nothing on the sweep path opts in.
  try {
    const { Page } = require('./cdp');
    const leaks = Page.prototype.bringToFront.toString().includes('allowFocus');
    const srcs = ['click', 'insertText', 'typeKeys']
      .filter(m => !Page.prototype[m].toString().includes('ensureInputFocus'));
    (leaks && !srcs.length)
      ? ok('Focus policy', 'bringToFront is opt-in; input uses focus emulation')
      : bad('Focus policy', !leaks
            ? 'bringToFront() is unconditional — it will steal window focus'
            : `${srcs.join('/')} front the tab instead of emulating focus`);
  } catch (e) {
    bad('Focus policy', e.message);
  }

  // Report
  const pad = Math.max(...results.map(r => r.n.length));
  console.log('\nmoto-scout self-check\n' + '─'.repeat(60));
  for (const r of results) {
    const mark = r.s === 'OK' ? '✓' : r.s === 'WARN' ? '!' : '✗';
    console.log(`${mark} ${r.n.padEnd(pad)}  ${r.d}`);
  }
  const fails = results.filter(r => r.s === 'FAIL').length;
  const warns = results.filter(r => r.s === 'WARN').length;
  console.log('─'.repeat(60));
  console.log(fails ? `${fails} blocking problem(s), ${warns} warning(s).`
                    : `All clear. ${warns} warning(s).`);
  process.exit(fails ? 1 : 0);
})();
