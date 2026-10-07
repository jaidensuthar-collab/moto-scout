'use strict';
/**
 * Market value, real-cost estimate, deal score, match classification, pros/cons.
 *
 * Design rule that matters most here: a suspiciously cheap bike must NOT score
 * well. Price advantage is capped and risk is subtracted, so "too good to be
 * true" lands in the middle of the range with a Risky label rather than at the
 * top of the Best Deals tab.
 */
const cfg = require('./config');
const knowledge = require('../data/model-knowledge.json');

/* ─────────────────── MARKET VALUE ─────────────────── */

/**
 * Estimate market value from, in order of preference:
 *   1. Real comparables we have already seen (same model, +/-2 years, similar miles)
 *   2. The cached knowledge-base range, adjusted for year and mileage
 * Always labelled as an estimate.
 */
function estimateMarketValue(listing, comparables = []) {
  const k = knowledge[listing.modelKey];
  if (!k) return { estimate: null, basis: 'no model knowledge', confidence: 'unknown' };

  const year = listing.year.value;
  const miles = listing.mileage.value;

  const comps = comparables.filter(c =>
    c.modelKey === listing.modelKey &&
    c.price != null &&
    (!year || !c.year || Math.abs(c.year - year) <= 2) &&
    (miles == null || c.mileage == null || Math.abs(c.mileage - miles) <= 8000)
  );

  if (comps.length >= 4) {
    const prices = comps.map(c => c.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    return {
      estimate: median,
      basis: `median of ${comps.length} comparable listings seen locally`,
      confidence: comps.length >= 8 ? 'medium-high' : 'medium',
      sampleSize: comps.length,
    };
  }

  // Fall back to the knowledge base, adjusted.
  let est = k.valueRangeUSD.typical;
  if (year) {
    const newest = new Date().getFullYear();
    const age = Math.max(0, newest - year);
    est -= Math.min(age * 180, (k.valueRangeUSD.typical - k.valueRangeUSD.low));
  }
  if (miles != null) {
    if (miles < 5000) est += 350;
    else if (miles > 20000) est -= 500;
    else if (miles > 12000) est -= 250;
  }
  est = Math.max(k.valueRangeUSD.low - 400, Math.round(est / 50) * 50);
  return {
    estimate: est,
    basis: comps.length
      ? `knowledge-base range adjusted for year/mileage (only ${comps.length} local comps, too few to rely on)`
      : 'knowledge-base range adjusted for year and mileage',
    confidence: 'low-medium',
    sampleSize: comps.length,
  };
}

function priceVsMarket(price, market) {
  if (price == null || !market?.estimate) {
    return { delta: null, pct: null, text: 'Cannot compare, market estimate unavailable' };
  }
  const delta = price - market.estimate;
  const pct = Math.round((delta / market.estimate) * 100);
  const dir = delta < 0 ? 'below' : 'above';
  return {
    delta,
    pct,
    text: `$${Math.abs(delta).toLocaleString()} ${dir} estimated market (~${Math.abs(pct)}% ${dir}, estimate)`,
  };
}

/* ─────────────────── REAL COST ─────────────────── */

/**
 * Immediate costs are kept SEPARATE from the listing price, as a range.
 * Nothing here is folded into the purchase price.
 */
function estimateRealCost(listing, photo, mods) {
  const items = [];
  const add = (label, lo, hi, why) => items.push({ label, lo, hi, why });

  const miles = listing.mileage.value;
  const text = `${listing.description || ''} ${listing.rawCardText || ''}`;
  const obs = (photo?.observations || []).join(' ').toLowerCase();

  if (/new tires?/i.test(text)) {
    add('Tires', 0, 0, 'Seller states new tires');
  } else if (miles != null && miles > 10000) {
    add('Tires', 220, 400, `Likely due at ${miles.toLocaleString()} mi`);
  } else if (/tires?.*(worn|low|need)/i.test(text) || /tire/.test(obs)) {
    add('Tires', 220, 400, 'Tire wear indicated');
  } else {
    add('Tires', 0, 220, 'Condition unconfirmed');
  }

  if (miles != null && miles > 14000) add('Chain and sprockets', 120, 260, `Typical replacement window at ${miles.toLocaleString()} mi`);
  else add('Chain and sprockets', 0, 120, 'May have life remaining');

  add('Fluids and filter', 60, 120, 'Baseline service on any used bike');
  add('Battery', 0, 110, 'Age unknown on most listings');
  add('Brake pads', 0, 120, 'Wear unconfirmed');

  if (/needs?\s+(work|repair|tlc)/i.test(text)) add('Seller-stated repairs', 150, 600, 'Seller says it needs work');
  if (/\bdrop(ped)?\b|\blaid down\b|\bcrash/i.test(text)) add('Cosmetic/crash repair', 100, 500, 'Drop or crash mentioned');
  if ((mods?.major || []).length) add('Reversing modifications', 150, 700, `Major mods: ${mods.major.join(', ')}`);

  add('Title, registration, inspection', 90, 180, 'Texas transfer, plates, inspection');

  const lo = items.reduce((s, i) => s + i.lo, 0);
  const hi = items.reduce((s, i) => s + i.hi, 0);
  const price = listing.price.value;

  return {
    items,
    immediateLow: lo,
    immediateHigh: hi,
    effectiveLow: price != null ? price + lo : null,
    effectiveHigh: price != null ? price + hi : null,
    summary: price != null
      ? `Listed $${price.toLocaleString()} + estimated $${lo}-$${hi} immediate = effective $${(price + lo).toLocaleString()}-$${(price + hi).toLocaleString()} (estimates)`
      : `Estimated immediate costs $${lo}-$${hi} (estimates)`,
  };
}

/* ─────────────────── DEAL SCORE ─────────────────── */

/**
 * 1-10. Starts at a neutral 5 and moves on evidence.
 * Risk is subtracted LAST and is uncapped downward, so a bargain-priced
 * high-risk listing cannot float to the top.
 */
function dealScore(ctx) {
  const { listing, market, pvm, title, mods, photo, scam, distance } = ctx;
  let score = 5;
  const reasons = [];

  // Price vs market — capped at +2. A 60%-under price is a red flag, not a win.
  if (pvm.pct != null) {
    if (pvm.pct <= -25) { score += 1.5; reasons.push('Well under estimated market'); }
    else if (pvm.pct <= -10) { score += 2; reasons.push('Meaningfully under market'); }
    else if (pvm.pct <= -3) { score += 1; reasons.push('Slightly under market'); }
    else if (pvm.pct >= 15) { score -= 1.5; reasons.push('Above estimated market'); }
    else if (pvm.pct >= 5) { score -= 0.5; reasons.push('Slightly above market'); }
  }

  // Mileage
  const m = listing.mileage.value;
  if (m != null) {
    if (m < 5000) { score += 1.5; reasons.push('Very low mileage'); }
    else if (m < 10000) { score += 1; reasons.push('Low mileage'); }
    else if (m > 18000) { score -= 1; reasons.push('Higher mileage'); }
  } else { score -= 0.5; reasons.push('Mileage unknown'); }

  // Year
  const y = listing.year.value;
  if (y) {
    if (y >= 2021) { score += 0.75; reasons.push('Recent model year'); }
    else if (y <= 2015) { score -= 0.25; }
  }

  // Title
  if (title.status.value === 'Clean') { score += 1; reasons.push('Clean title stated'); }
  else if (title.reject) { score -= 4; reasons.push(`Title problem: ${title.status.value}`); }
  else { score -= 0.75; reasons.push('Title status unstated'); }

  // Modifications
  if (mods.major.length) { score -= 3; reasons.push(`Heavily modified: ${mods.major.join(', ')}`); }
  else if (mods.minor.length <= 2) { score += 0.5; reasons.push('Stock or lightly modified'); }

  // Visible condition
  const dmg = (photo?.damageFound || []).length;
  const poss = (photo?.possibleIssues || []).length;
  if (dmg) { score -= Math.min(dmg * 0.75, 2); reasons.push('Visible damage noted'); }
  else if (poss > 2) { score -= 0.5; reasons.push('Several possible condition issues'); }

  // Distance
  if (distance.used != null) {
    if (distance.used <= 30) { score += 0.5; reasons.push('Close by'); }
    else if (distance.used > 80) { score -= 0.75; reasons.push('Long drive'); }
  }

  // Seller
  if (listing.seller.type.value === 'Private') { score += 0.25; }

  // Risk last, and heavy.
  if (scam.level === 'HIGH') { score -= 3.5; reasons.push('High scam risk signals'); }
  else if (scam.level === 'MEDIUM') { score -= 1.5; reasons.push('Some scam risk signals'); }

  score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));

  let label;
  if (scam.level === 'HIGH' || title.reject || mods.major.length) label = 'Risky';
  else if (score >= 8.5) label = 'Great Deal';
  else if (score >= 7) label = 'Good Deal';
  else if (score >= 5) label = 'Fair';
  else label = 'Overpriced';
  if (label !== 'Risky' && scam.level === 'MEDIUM' && score < 7) label = 'Risky';

  return { score, label, reasons };
}

/* ─────────────── MATCH CLASSIFICATION ─────────────── */

function classify(ctx) {
  const { listing, title, mods, distance, isPart, isDonation, isRental } = ctx;
  const miss = [];
  const fail = [];

  const y = listing.year.value, p = listing.price.value, m = listing.mileage.value, d = distance.used;

  const P = cfg.criteria.perfect, N = cfg.criteria.near;

  // Checked against the real description now (see analyzeListing in
  // pipeline.js), ahead of every other disqualifier: a parts-out listing
  // ("Bonamici Rearsets Yamaha R3", an R7 frame sold piece by piece under a
  // vague title), a crowdfunding post ("Fund my dream with $1... Kawasaki
  // ninja 500", a Cash App link, no bike actually for sale), or a daily
  // rental (riders-share.com, a day rate stored as if it were a purchase
  // price) is never a match no matter what model it resolves to.
  //
  // isDonation/isRental checked BEFORE isPart deliberately: both are narrow,
  // specific signals (a payment-app domain, "daily rental" phrasing), while
  // PART_RE is broad and can incidentally fire on a genuine complete-bike
  // listing that happens to mention an included accessory ("comes with 2
  // seats, mirrors, a bike cover...") -- that real $4,300 listing is kept
  // safe by its price alone (the >=$900 co-gate on isPart), but if a rental
  // or donation listing ALSO happens to trip PART_RE, the more specific,
  // more informative reason should win rather than the generic one.
  if (isDonation) return { type: 'Rejected', reasons: ['Donation/crowdfunding post, not an actual motorcycle for sale'], missing: [] };
  if (isRental) return { type: 'Rejected', reasons: ['Rental listing, not an actual motorcycle for sale'], missing: [] };
  if (isPart) return { type: 'Rejected', reasons: ['Description indicates this is a part, not a complete motorcycle'], missing: [] };

  /**
   * HARD disqualifiers come FIRST -- before the unconfirmed-model branch and
   * before the missing-info check.
   *
   * Ordering is the whole point here and has been got wrong twice.
   *
   * A bike 190 miles away is out on distance alone; unknown mileage does not
   * earn it a place in Needs Review. More importantly, these limits must apply
   * even when the model is still unconfirmed -- an earlier version returned
   * 'Needs Review' for any ambiguous listing before reaching this point, which
   * filled the review queue with things like a $199 item 221 miles away whose
   * only qualification was the word "Yamaha".
   *
   * A listing that fails a hard limit cannot become a match no matter what the
   * model turns out to be, so resolving the model is pointless.
   */
  if (d != null && d > N.maxDistance) return { type: 'Rejected', reasons: [`${d} mi exceeds ${N.maxDistance} mi limit`], missing: [] };
  if (p != null && p > N.maxPrice)     return { type: 'Rejected', reasons: [`Price $${p} exceeds $${N.maxPrice}`], missing: [] };
  if (y != null && y < N.minYear)      return { type: 'Rejected', reasons: [`Year ${y} older than ${N.minYear}`], missing: [] };
  if (m != null && m > N.maxMiles)     return { type: 'Rejected', reasons: [`${m.toLocaleString()} mi exceeds ${N.maxMiles.toLocaleString()}`], missing: [] };

  // A bad title also disqualifies regardless of which model it is.
  if (title.reject) return { type: 'Rejected', reasons: [`Title is ${title.status.value}`], missing: [] };

  // A listing that only reached us via an ambiguous title ("2021 Kawasaki
  // ninja") and still has no confirmed model after opening goes to review, not
  // the bin -- it may well be one of ours, we just cannot prove it yet. It has
  // already cleared every hard limit above to get here.
  if (!listing.modelKey && listing.ambiguous) {
    return {
      type: 'Needs Review',
      reasons: [`Model unconfirmed. ${listing.ambiguous.note}. Open the listing to check the displacement.`],
      missing: ['model'],
    };
  }
  if (!listing.modelKey) fail.push('Not one of the tracked models');
  if (mods.major.length) fail.push(`Heavily modified: ${mods.major.join(', ')}`);
  if (fail.length) return { type: 'Rejected', reasons: fail, missing: [] };

  if (!y) miss.push('year');
  if (p == null) miss.push('price');
  if (m == null) miss.push('mileage');
  if (d == null) miss.push('distance');

  /**
   * TITLE POLICY — relaxed deliberately.
   *
   * Bad titles (salvage / rebuilt / flood / parts-only / explicitly no title)
   * are still rejected outright further up. That has not changed.
   *
   * What changed: an UNSTATED title no longer blocks Near Match. On real data
   * 22 of 47 listings never mention the title at all, so the strict reading
   * left Perfect Match permanently empty and buried good bikes in Needs Review.
   *
   * Perfect Match still REQUIRES an explicitly stated clean title, so that tier
   * keeps its meaning. Unstated titles reach Near Match carrying a loud flag,
   * and "Do you have the title in hand?" is already the first generated
   * question on every listing.
   */
  const titleStated  = title.status.value === 'Clean';
  const titleUnknown = !title.status.value;

  const fitsPerfect = y >= P.minYear && m <  P.maxMiles && p <  P.maxPrice && d <= P.maxDistance && titleStated;
  const fitsNear    = y >= N.minYear && m <= N.maxMiles && p <= N.maxPrice && d <= N.maxDistance && (titleStated || titleUnknown);

  // Missing critical info never silently discards a bike.
  if (miss.length) {
    return {
      type: 'Needs Review',
      reasons: [`Cannot confirm: ${miss.join(', ')}`],
      missing: miss,
    };
  }

  if (fitsPerfect) return { type: 'Perfect Match', reasons: ['Meets every criterion'], missing: [] };
  if (fitsNear) {
    const why = [];
    if (p >= P.maxPrice) why.push(`price $${p} over $${P.maxPrice}`);
    if (m >= P.maxMiles) why.push(`${m.toLocaleString()} mi over ${P.maxMiles.toLocaleString()}`);
    if (d > P.maxDistance) why.push(`${d} mi away`);
    if (y < P.minYear) why.push(`${y} older than ${P.minYear}`);
    if (titleUnknown) why.push('TITLE NOT STATED — confirm before viewing');
    return {
      type: 'Near Match',
      reasons: why.length ? why : ['Just outside perfect criteria'],
      missing: titleUnknown ? ['title status'] : [],
    };
  }

  const why = [];
  if (p > N.maxPrice) why.push(`Price $${p} exceeds $${N.maxPrice}`);
  if (m > N.maxMiles) why.push(`${m.toLocaleString()} mi exceeds ${N.maxMiles.toLocaleString()}`);
  if (d > N.maxDistance) why.push(`${d} mi exceeds ${N.maxDistance}`);
  if (y < N.minYear) why.push(`Year ${y} older than ${N.minYear}`);
  return { type: 'Rejected', reasons: why, missing: [] };
}

/* ─────────────────── PROS / CONS ─────────────────── */

/** Max 3 each. Blends listing facts with model knowledge. */
function prosCons(ctx) {
  const { listing, market, pvm, title, mods, photo, scam, distance } = ctx;
  const k = knowledge[listing.modelKey];
  const pros = [], cons = [];

  if (pvm.delta != null && pvm.delta < -150) pros.push(`$${Math.abs(pvm.delta).toLocaleString()} below estimated market`);
  const m = listing.mileage.value;
  if (m != null && m < 10000) pros.push(`Low mileage at ${m.toLocaleString()} mi`);
  if (title.status.value === 'Clean') pros.push('Clean title stated by seller');
  if (!mods.major.length && mods.minor.length <= 2) pros.push('Stock or lightly modified');
  if (distance.used != null && distance.used <= 35) pros.push(`Only about ${distance.used} mi away`);
  if (k?.resaleNotes && /strong/i.test(k.resaleNotes)) pros.push('Model holds resale value well');

  if (m != null && m > 10000) cons.push('Tires and chain likely due soon');
  if (!listing.mileage.value) cons.push('Mileage not stated in the listing');
  if (!title.status.value) cons.push('Title status not mentioned');
  if (scam.flags.length) cons.push(scam.flags[0]);
  if (mods.minor.length > 2) cons.push(`Several modifications: ${mods.minor.slice(0, 2).join(', ')}`);
  if (distance.used != null && distance.used > 70) cons.push(`Long trip at about ${distance.used} mi`);
  if (k?.knownIssues?.length) cons.push(`Known for this model: ${String(k.knownIssues[0]).slice(0, 80)}`);
  if (k?.budgetNote) cons.push(k.budgetNote);

  return { pros: pros.slice(0, 3), cons: cons.slice(0, 3) };
}

module.exports = { estimateMarketValue, priceVsMarket, estimateRealCost, dealScore, classify, prosCons, knowledge };
