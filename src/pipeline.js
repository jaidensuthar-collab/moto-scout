'use strict';
/**
 * Staged pipeline. The whole point is to spend expensive resources (browser
 * navigations, vision calls) only on listings that have already earned them.
 *
 *   Stage 1  Scrape search cards                      — ~free
 *   Stage 2  Cheap gate on model/year/price           — ~free, kills ~95%
 *   Stage 3  Open the survivors, extract full detail  — costly: one page load each
 *   Stage 4  Deep analysis (photos/market/score)      — costliest: may call a vision model
 *
 * A run that scans 300 cards typically opens fewer than 10 listings.
 */
const cfg = require('./config');
const mp = require('./marketplace');
const parse = require('./parse');
const analyze = require('./analyze');
const geo = require('./geo');
const scoring = require('./scoring');
const dedupe = require('./dedupe');
const db = require('./db');
const { sleep } = require('./cdp');

/**
 * Things that are obviously not a motorcycle listing.
 *
 * Built up from real misses, not guessed in advance. First two: "Bonamici
 * Rearsets Yamaha R3 2015+" ($505, no "rearset" in this list at all) and a
 * listing titled "2023 Yamaha YZF-R" whose real description -- only readable
 * after the openListing() heading fix above -- was an R7 frame parted out
 * piece by piece. Fixing those exposed a systematic gap: every active record
 * with a resolved model but NO price was audited (price=null on a real
 * vehicle listing is itself a red flag -- genuine for-sale posts almost
 * always have one), and 9 of 9 turned out to be parts, not motorcycles:
 * "brake light", "slip on" (exhaust), "rear turn signal fender assembly",
 * "header" (exhaust), "stock muffler", "gas tank and fuel pump", and "clear
 * wind screen" -- the last one caught because the existing term was the
 * single word "windscreen", which does not match the two-word "wind screen"
 * sellers actually typed.
 *
 * "Frame"-adjacent phrases stay deliberately narrow: a real complete bike's
 * description often mentions its frame positively ("frame has no cracks"),
 * so only phrasing that makes the frame itself the product for sale counts.
 */
const PART_RE = /fairing|exhaust|stator|headlight|tail\s?light|tailight|brake\s?light|wind\s?screen|windshield|plastics?\b|\brim\b|\bwheel\b|sprocket|\bchain\b|mirror|decal|sticker|lever|\bbolt\b|filter|boots?|gloves?|helmet|jacket|bracket|gauge|\bmat\b|\bparts?\b|\bseat\b|fender eliminator|frame slider|rearsets?|swing\s?arm|brake\s?caliper|master\s?cylinder|\b(bare|rolling|title\s?only)\s?frame\b|frame\s?(only|with|for\s?sale)\b|slip[\s-]?on|turn\s?signal|\bheaders?\b|\bmuffler\b|fuel\s?pump|gas\s?tank|engine\s?guards?|crash\s?bars?/i;

/**
 * Not a parts listing, but not a real listing either: a crowdfunding/donation
 * post ("Fund my dream with $1... Kawasaki ninja 500", a Cash App link, no
 * actual bike for sale) found during the same audit. Donation-site domains
 * plus begging language, checked independently of PART_RE and of the price
 * gate -- these never have a real price to gate on in the first place.
 */
const DONATION_RE = /\bgofundme\b|cash\.?app\b|venmo\.com|paypal\.me|\bdonat(e|ion)s?\b.{0,40}\b(goal|dream|buy|save|fund)\b|\bfund(ing)?\s+my\b/i;

/**
 * Also found in the same audit: a "2026 CFMOTO 450ss" listing that was not a
 * sale at all, but a DAILY RENTAL via riders-share.com ("Listing is for
 * daily rental"). The stored price ($100) was a day rate, not a purchase
 * price -- would have looked like an extraordinary deal rather than the junk
 * it was. Checked like DONATION_RE: independently, no price co-gate.
 */
const RENTAL_RE = /riders-share\.com|turo\.com|\bdaily\s+rental\b|\brent(al)?\s+(only|this\s+bike)\b|\$\s*\d+\s*\/\s*(day|night)\b/i;

const AD_RE = /partner listing|\bsponsored\b/i;

/** STAGE 2 — cheap gate. Deliberately permissive: when in doubt, let it through
 *  to Stage 3 rather than silently dropping a possible match. */
function cheapGate(card) {
  const t = card.raw || '';
  if (AD_RE.test(t)) return { pass: false, why: 'sponsored/partner listing' };
  if (DONATION_RE.test(t)) return { pass: false, why: 'donation/crowdfunding post, not a real listing' };
  if (RENTAL_RE.test(t)) return { pass: false, why: 'rental listing, not a sale' };

  const price = parse.parsePrice(t).value;
  const year = parse.parseYear(t).value;

  // Cheap structural rejects first — they apply whether the model is confirmed
  // or merely suspected, so doing them up front saves work either way.
  //
  // Threshold was 900 until a real listing titled "2025 Ninja 500 fairings"
  // at $1,234 slipped through and got stored as a genuine Ninja 500 -- a
  // full fairing/bodywork kit is itself a PART_RE match ("fairing") but
  // legitimately costs well over $900, so the old threshold assumed every
  // part is cheap and let this one through on price alone. Raised to 1500,
  // which stays comfortably under where real complete bikes in this dataset
  // start (~$2000+) while covering expensive single parts like fairing kits.
  if (PART_RE.test(t) && (price == null || price < 1500)) return { pass: false, why: 'appears to be a part' };
  if (price != null && price > cfg.criteria.near.maxPrice) return { pass: false, why: `price $${price} over near-match ceiling` };

  // Distance, from the city printed on the search card. Facebook's radius
  // filter intermittently returns statewide results, and in one audit 39 of
  // 70 rejected listings were rejected purely for being >100 mi away --
  // Houston, Dallas, Katy -- each one having first spent one of the 25
  // listing-opens a sweep gets. The card names the city, the gazetteer
  // resolves it, so reject here and keep the open budget for bikes in range.
  // Unknown city => let it through; the detail page re-derives distance.
  const cityDist = geo.distanceFor({ location: { value: parse.parseLocation(t).value }, marketplaceDistance: { value: null } }).used;
  if (cityDist != null && cityDist > cfg.criteria.near.maxDistance) return { pass: false, why: `${cityDist} mi away by city, over ${cfg.criteria.near.maxDistance} mi limit` };
  if (year != null && year < cfg.criteria.near.minYear) return { pass: false, why: `year ${year} older than near-match floor` };

  const model = cfg.identifyModel(t);
  if (model) return { pass: true, model, price, year, ambiguous: null };

  // No confirmed model. Lots of sellers just write "2021 Kawasaki ninja" with no
  // displacement, so before discarding, check whether it COULD be one of ours.
  // Passing here does not claim a match — it buys the listing a detail-page
  // visit, where the description almost always names the real model.
  const amb = cfg.identifyAmbiguous(t, year);
  if (amb) return { pass: true, model: null, price, year, ambiguous: amb, why: amb.note };

  return { pass: false, why: 'no tracked model matched' };
}

/** STAGE 4 — full analysis of one opened listing. */
async function analyzeListing(listing, visionBudget) {
  const blob = `${listing.description || ''}\n${listing.rawCardText || ''}`;

  const title = analyze.analyzeTitle(blob);
  const mods = analyze.analyzeMods(blob);
  const photo = await analyze.analyzePhotos(listing, visionBudget);
  const distance = geo.distanceFor(listing);

  const comps = listing.modelKey ? db.comparables(listing.modelKey) : [];
  const market = scoring.estimateMarketValue(listing, comps);
  const pvm = scoring.priceVsMarket(listing.price.value, market);
  const scam = analyze.analyzeScamRisk(listing, market);
  const cost = scoring.estimateRealCost(listing, photo, mods);

  // Second parts/junk check, against the real description this time.
  //
  // cheapGate()'s checks (above) only ever see the terse pre-open search card
  // -- a title like "2023 Yamaha YZF-R" gives no hint that the listing is
  // someone parting out an R7 frame piece by piece until the actual
  // description is readable. Same regexes, now run against the full blob
  // post-open, so a misleading title can't hide what the description reveals.
  // DONATION_RE has no price co-gate: a crowdfunding post never has a real
  // price in the first place, so there is nothing to gate on.
  const isPart = PART_RE.test(blob) && (listing.price.value == null || listing.price.value < 1500);
  const isDonation = DONATION_RE.test(blob);
  const isRental = RENTAL_RE.test(blob);

  const ctx = { listing, market, pvm, title, mods, photo, scam, distance, isPart, isDonation, isRental };
  const deal = scoring.dealScore(ctx);
  const match = scoring.classify(ctx);
  const pc = scoring.prosCons(ctx);

  // Repost detection against everything we've already seen of this model.
  const imageSignature = dedupe.imageSignature(listing.images);
  const cands = listing.modelKey ? db.repostCandidates(listing.modelKey, listing.listingId) : [];
  const repost = dedupe.detectRepost({
    imageSignature,
    sellerName: listing.seller.name.value,
    year: listing.year.value,
    mileage: listing.mileage.value,
    city: listing.location.value,
    price: listing.price.value,
    description: listing.description,
  }, cands);

  return { title, mods, photo, distance, market, pvm, scam, cost, deal, match, prosCons: pc, imageSignature, repost };
}

/** Flatten everything into the DB row / Sheets row shape. */
function toRecord(listing, a) {
  return {
    listingId: listing.listingId,
    url: listing.url,
    modelKey: listing.modelKey,
    model: listing.model.value,
    variant: listing.variant.value,
    year: listing.year.value,
    price: listing.price.value,
    mileage: listing.mileage.value,
    city: listing.location.value ? String(listing.location.value).split(',')[0] : null,
    location: listing.location.value,
    marketplaceDistance: a.distance.marketplace,
    calculatedDistance: a.distance.calculated,
    distanceUsed: a.distance.used,
    distanceMismatch: a.distance.mismatch,
    sellerName: listing.seller.name.value,
    sellerType: listing.seller.type.value,
    datePosted: listing.datePosted.value,
    description: listing.description,
    titleStatus: a.title.status.value || 'Unknown',
    modifications: a.mods.summary,
    visibleDamage: (a.photo.damageFound || []).join('; ') || 'None confirmed from photos',
    mechanicalConcerns: (a.photo.possibleIssues || []).join('; ') || 'None noted',
    photoAnalysis: JSON.stringify({
      source: a.photo.source, confidence: a.photo.confidence,
      observations: a.photo.observations, note: a.photo.note || null,
    }),
    pros: a.prosCons.pros,
    cons: a.prosCons.cons,
    marketValue: a.market.estimate,
    priceVsMarket: a.pvm.text,
    dealScore: a.deal.score,
    dealLabel: a.deal.label,
    scamRisk: a.scam.level,
    scamReason: a.scam.reason,
    redFlags: a.scam.flags,
    questions: a.scam.questions,
    matchType: a.match.type,
    missingFields: a.match.missing,
    estImmediateLow: a.cost.immediateLow,
    estImmediateHigh: a.cost.immediateHigh,
    estEffectiveLow: a.cost.effectiveLow,
    estEffectiveHigh: a.cost.effectiveHigh,
    costBreakdown: a.cost.items,
    images: listing.images,
    imageSignature: a.imageSignature,
    duplicateStatus: a.repost.status,
    duplicateOf: a.repost.of,
    duplicateConfidence: a.repost.confidence,
    status: 'Active',
    // classify()'s reasons explain WHY a listing landed in Needs Review or got
    // Rejected ("Title says Ninja with no displacement...") and were computed
    // but never kept anywhere -- Sheets had no way to show why an unresolved
    // listing was worth a second look. No schema change needed: this is
    // already a free-text field, so the reason goes in first since it is the
    // most actionable part of the note.
    notes: [
      a.match.reasons?.length ? a.match.reasons.join('; ') : null,
      a.distance.note,
      a.repost.signals.length ? `Repost signals: ${a.repost.signals.join(', ')}` : null,
      a.photo.note || null,
    ].filter(Boolean).join(' | '),
  };
}

/** Full run. Returns stats + the records touched. */
async function runSweep({ limit } = {}) {
  const stats = {
    scanned: 0, opened: 0, rejected: 0, perfect: 0, near: 0, needsReview: 0,
    newListings: 0, updated: 0, duplicates: 0, priceChanges: 0, removed: 0,
    savedFb: 0, errors: [],
  };
  const runId = db.startRun();
  const visionBudget = { used: 0 };
  const maxOpen = limit || (cfg.testMode ? 3 : cfg.maxListingsPerRun);
  const records = [];

  /**
   * Hard wall-clock ceiling for the whole sweep, checked at the top of every
   * loop iteration in both stages. This is a backstop, not the primary fix --
   * navigate() now bounds itself too (see cdp.js) -- but a sweep must never
   * again be able to hang indefinitely regardless of what causes a future
   * slowdown. Checked, never relied on to fire: a healthy run finishes well
   * inside it.
   */
  const deadline = Date.now() + cfg.maxSweepMinutes * 60000;

  let page;
  try {
    page = await mp.getPage();
  } catch (e) {
    stats.errors.push({ stage: 'browser', error: String(e.message) });
    db.finishRun(runId, stats);
    return { stats, records, fatal: 'Could not attach to the browser. Is Opera running with --remote-debugging-port=9222?' };
  }

  try {
  // ── Stage 1 + 2 ──────────────────────────────────────────
  // See cfg.searchSort. Decided once per run so every search in the sweep
  // uses the same ordering and the stats are comparable run to run.
  const sortForThisRun =
    cfg.searchSort === 'newest'    ? 'creation_time_descend' :
    cfg.searchSort === 'relevance' ? undefined :
    (new Date().getHours() % 2 === 0 ? 'creation_time_descend' : undefined);
  stats.searchSort = sortForThisRun || 'relevance';
  const candidates = new Map();
  let consecutiveFailures = 0;

  // One loop level, not model x query: cfg.searchQueries is already a short,
  // deliberately broad, non-redundant list (see config.js) -- running every
  // model's own query list here is what made the stage take 38+ minutes once
  // 12 models were tracked instead of 5.
  outer:
  for (const city of cfg.cities) {
    for (const query of cfg.searchQueries) {
      if (Date.now() >= deadline) {
        stats.errors.push({ stage: 'search', error: `sweep deadline (${cfg.maxSweepMinutes} min) reached, moving to listing stage with what was found` });
        break outer;
      }
      if (consecutiveFailures >= cfg.maxConsecutiveFailures) {
        stats.errors.push({ stage: 'search', error: 'too many consecutive failures, aborting run' });
        break outer;
      }
      try {
        const res = await mp.search(page, { city, query, radius: cfg.searchRadiusMiles, sortBy: sortForThisRun });
        if (res.blocked) {
          stats.errors.push({ stage: 'search', city, query, error: `blocked: ${res.reason}` });
          // Blocked means STOP. Retrying a block is how accounts get restricted.
          break outer;
        }
        stats.scanned += res.cards.length;
        consecutiveFailures = 0;
        for (const card of res.cards) {
          const gate = cheapGate(card);
          if (!gate.pass) { stats.rejected++; continue; }
          const id = parse.listingId(card.url);
          if (id && !candidates.has(id)) candidates.set(id, card);
        }
      } catch (e) {
        consecutiveFailures++;
        stats.errors.push({ stage: 'search', city, query, error: String(e.message).slice(0, 160) });
      }
      await mp.politeDelay(cfg.delays.betweenSearches);
    }
  }

  // ── Stage 3 + 4 ──────────────────────────────────────────
  //
  // ORDER MATTERS. We can only open maxOpen listings per run (3 in test mode,
  // MAX_LISTINGS_PER_RUN live) against a candidate pool that is routinely in the
  // hundreds, so whichever listings sort first are the only ones analysed.
  //
  // Opening them in discovery order starved new bikes completely: a run would
  // spend all its slots re-checking listings already in the database and report
  // newListings: 0 while genuinely new candidates sat unopened. So:
  //   1. never-seen listings first -- the whole point of the sweep
  //   2. then known ones, oldest check first, which doubles as repair for
  //      records whose fields were extracted before a parser fix
  const ordered = [...candidates.entries()].sort((A, B) => {
    const a = db.getListing(A[0]), b = db.getListing(B[0]);
    if (!a && b) return -1;
    if (a && !b) return 1;
    if (!a && !b) return 0;
    return String(a.last_checked || '').localeCompare(String(b.last_checked || ''));
  });
  // Surfaced in stats so a run that opens few listings is self-explanatory
  // rather than looking like a failure.
  stats.candidates = ordered.length;
  stats.candidatesUnseen = ordered.filter(([id]) => !db.getListing(id)).length;
  stats.openBudget = maxOpen;

  let opened = 0;
  for (const [id, card] of ordered) {
    if (opened >= maxOpen) break;
    if (Date.now() >= deadline) {
      stats.errors.push({ stage: 'listing', error: `sweep deadline (${cfg.maxSweepMinutes} min) reached, ${ordered.length - opened} candidate(s) left for next run` });
      break;
    }
    try {
      const detail = await mp.openListing(page, card.url);
      if (detail.blocked) {
        stats.errors.push({ stage: 'listing', id, error: `blocked: ${detail.reason}` });
        break;
      }
      // A dead listing is not a session problem -- skip just this one and
      // keep going, don't abort the run. If it was already in the DB (a
      // repost we'd seen before that has since been taken down), mark it
      // removed instead of leaving stale Active data behind.
      //
      // Deliberately NOT a `continue` here: this is inside the loop's try
      // block, and a `continue` jumps straight to the next iteration,
      // skipping the politeDelay() call below (which sits after the
      // try/catch, not inside it) -- back-to-back dead listings would then
      // hit Facebook with no rate limiting between them. An if/else keeps
      // every path falling through to the same delay at the bottom.
      if (detail.gone) {
        if (db.getListing(id)) { db.markRemoved(id, 'Removed'); stats.removed++; }
      } else {
        opened++; stats.opened++;

        const listing = parse.normalize(card, detail, cheapGate(card).ambiguous);
        const a = await analyzeListing(listing, visionBudget);
        const rec = toRecord(listing, a);

        const { isNew, priceChanged } = db.upsertListing(rec);
        if (isNew) stats.newListings++; else stats.updated++;
        if (priceChanged) stats.priceChanges++;
        if (rec.duplicateStatus && rec.duplicateStatus !== 'Unique') stats.duplicates++;
        if (rec.matchType === 'Perfect Match') stats.perfect++;
        else if (rec.matchType === 'Near Match') stats.near++;
        else if (rec.matchType === 'Needs Review') stats.needsReview++;
        else stats.rejected++;

        // Save strong listings on Facebook (double-gated; never saves risky ones).
        const worthSaving = (rec.matchType === 'Perfect Match' ||
                            (rec.matchType === 'Near Match' && rec.dealScore >= 7)) &&
                            rec.scamRisk !== 'HIGH' && rec.dealLabel !== 'Risky';
        if (worthSaving) {
          const s = await mp.saveListing(page);
          if (s.saved) { stats.savedFb++; rec.savedOnFacebook = true; db.upsertListing(rec); }
        }

        records.push(rec);
      }
    } catch (e) {
      stats.errors.push({ stage: 'listing', id, error: String(e.message).slice(0, 160) });
    }
    await mp.politeDelay(cfg.delays.betweenListings);
  }

  return { stats, records, runId };
  } finally {
    // ALWAYS runs, including on an exception that escapes the stage loops
    // above. Before this, an uncaught error left the run row permanently
    // "UNFINISHED" in the database and the browser tab's CDP connection open
    // -- exactly the state a wedged sweep was found in.
    db.finishRun(runId, stats);
    try { page.close(); } catch {}
  }
}

/**
 * Re-check listings we already know about and retire the dead ones.
 * History is preserved: the row is marked Sold/Removed, never deleted.
 */
async function checkRemoved({ max = 15 } = {}) {
  const rows = db.activeIds().slice(0, max);
  const out = { checked: 0, removed: 0, errors: [] };
  if (!rows.length) return out;
  let page;
  try { page = await mp.getPage(); } catch (e) { out.errors.push(String(e.message)); return out; }

  for (const r of rows) {
    try {
      const d = await mp.openListing(page, r.url);
      out.checked++;
      if (d.blocked) { out.errors.push(`blocked: ${d.reason}`); break; }
      // d.gone (the ?unavailable_product=1 redirect -- see openListing()) is
      // the reliable signal; text-matching the body was the only check here
      // before and two listings sat marked Active/Near Match for weeks after
      // they'd redirected to this exact URL, because none of these phrases
      // happened to appear on that generic marketplace-homepage redirect.
      const body = `${d.head || ''} ${d.desc || ''} ${d.title || ''}`;
      const gone = d.gone || /this content isn'?t available|page not found|no longer available|content unavailable/i.test(body);
      const sold = /\bsold\b/i.test(d.head || '') || /marked as sold/i.test(body);
      if (gone) { db.markRemoved(r.listing_id, 'Removed'); out.removed++; }
      else if (sold) { db.markRemoved(r.listing_id, 'Sold'); out.removed++; }
      else db.touchChecked(r.listing_id);   // still alive: bump last_checked so the rotation moves on
    } catch (e) {
      out.errors.push(String(e.message).slice(0, 120));
    }
    await mp.politeDelay(cfg.delays.betweenListings);
  }
  try { page.close(); } catch {}
  return out;
}

module.exports = { runSweep, checkRemoved, cheapGate, analyzeListing, toRecord };
