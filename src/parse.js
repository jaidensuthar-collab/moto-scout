'use strict';
/**
 * Turns raw Marketplace text into structured fields.
 *
 * Core principle for this whole project: every field carries a `confidence` of
 * 'stated' | 'inferred' | 'unknown'. We never let an inferred value masquerade
 * as something the seller actually wrote. Downstream, anything 'unknown' on a
 * decision-critical field routes the listing to NEEDS REVIEW rather than being
 * silently dropped.
 */
const cfg = require('./config');

const CURRENT_YEAR = new Date().getFullYear();

function field(value, confidence, source) {
  return { value, confidence, source: source || null };
}

/** Facebook item id out of the URL — our stable primary key. */
function listingId(url) {
  const m = String(url || '').match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}

/** Price. Card text often shows "$2,800 | $3,500" (current | struck-through was). */
function parsePrice(text) {
  if (!text) return field(null, 'unknown');
  const all = [...String(text).matchAll(/\$\s?([\d][\d,]{1,8})/g)].map(m => Number(m[1].replace(/,/g, '')));
  const sane = all.filter(n => n >= 100 && n <= 60000);
  if (!sane.length) return field(null, 'unknown');
  // Facebook renders the live price first, the old price second.
  return field(sane[0], 'stated', 'listing');
}

/** Model year. Must not swallow mileage ("2016 miles") or prices. */
function parseYear(text) {
  if (!text) return field(null, 'unknown');
  const hits = [...String(text).matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)]
    .map(m => Number(m[1]))
    .filter(y => y >= 1980 && y <= CURRENT_YEAR + 1);
  if (!hits.length) return field(null, 'unknown');
  return field(hits[0], 'stated', 'listing');
}

/**
 * Mileage. Handles "9,930 miles", "12k miles", "under 10k", "10000mi".
 * Rejects matches that are really a year or a price.
 */
/**
 * Mileage is the field that bites hardest, because a listing is full of other
 * numbers followed by "miles":
 *   "New Dunlops Q5A less than 500 miles"   ← tire age, NOT the odometer
 *   "$4,500"                                 ← price, matched if you're sloppy
 *   "Ninja 400"                              ← model name
 * So: gather every candidate, discard ones whose surrounding words show they
 * describe a consumable or a price, then prefer the one with odometer context.
 */
// Consumables must allow suffixes: "Dunlops", "Q5A", "tires" all need to match.
const CONSUMABLE_CTX = /(tires?|tyres?|dunlops?|pirellis?|michelins?|bridgestones?|metzelers?|q5\w*|chains?|sprockets?|oil|pads?|brakes?|batter\w*|warrant\w*|serviced?|valve)/i;
// These override a consumable hit — they name the odometer explicitly.
const ODO_CTX = /(odometer|mileage|original|actual|showing|currently has|has only|clocks?)/i;

function parseMileage(text) {
  if (!text) return field(null, 'unknown');
  const s = String(text);
  const cands = [];

  const push = (n, idx, raw, weight) => {
    if (!(n >= 50 && n <= 200000)) return;
    // Narrow windows. A wide one caught "new chain at 12,000 miles, odometer
    // shows 18,400 miles" and threw away the real odometer reading.
    const before = s.slice(Math.max(0, idx - 26), idx);
    // Only look at the REST OF THIS CLAUSE after the match. Without the clause
    // cut, "12k miles, new tires at 11k miles" let the tyre wording poison the
    // odometer figure that came before it.
    const after = s.slice(idx + raw.length, idx + raw.length + 24).split(/[,.;\n]/)[0];
    if (/\$\s*[\d,]*\s*$/.test(before)) return;        // it's a price

    // "original"/"actual" often sit INSIDE the match ("3,000 original miles"),
    // so the raw match itself has to count as odometer context.
    const odo = ODO_CTX.test(before) || ODO_CTX.test(after) || ODO_CTX.test(raw);
    if (!odo && CONSUMABLE_CTX.test(before + ' ' + after)) return;

    let w = weight;
    if (odo) w += 3;
    if (/\bonly\b/i.test(before)) w += 1;
    cands.push({ n, w, idx });
  };

  // "12k miles"
  for (const m of s.matchAll(/\b(\d{1,3}(?:\.\d)?)\s*k\s*(?:miles|mi)\b/gi)) {
    push(Math.round(parseFloat(m[1]) * 1000), m.index, m[0], 2);
  }
  // "9,930 miles" / "9930 mi"  — and allow a qualifier between number and unit,
  // e.g. "3,000 original miles" / "8,200 actual miles".
  for (const m of s.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d{3,6})\s*(?:original|actual|real|true|documented)?\s*(?:miles|mi)\b/gi)) {
    push(Number(m[1].replace(/,/g, '')), m.index, m[0], 2);
  }
  // "mileage: 9930" / "odometer 9930"
  for (const m of s.matchAll(/\b(?:mileage|odometer)\s*[:\-]?\s*(\d{1,3}(?:,\d{3})+|\d{3,6})/gi)) {
    push(Number(m[1].replace(/,/g, '')), m.index, m[0], 5);
  }

  if (!cands.length) return field(null, 'unknown');
  // Highest context weight wins; ties break toward the LARGER number, because an
  // odometer reading is almost always bigger than an incidental figure.
  cands.sort((a, b) => b.w - a.w || b.n - a.n);
  const best = cands[0];
  const confident = best.w >= 4 || cands.length === 1;
  return field(best.n, confident ? 'stated' : 'inferred',
    confident ? 'listing' : `one of ${cands.length} mileage-like figures in the listing`);
}

/** City/state from a card or listing ("... | San Antonio, TX"). */
function parseLocation(text) {
  if (!text) return field(null, 'unknown');
  const m = String(text).match(/([A-Z][A-Za-z .'\-]{2,30}),\s*(TX|Texas|OK|LA|NM|AR)\b/);
  if (!m) return field(null, 'unknown');
  return field(`${m[1].trim()}, ${m[2] === 'Texas' ? 'TX' : m[2]}`, 'stated', 'listing');
}

/**
 * Marketplace sometimes prints its own distance ("· 42 mi").
 *
 * CAREFUL: the page chrome also contains the location FILTER ("Austin, Texas ·
 * Within 80 mi"). Matching that made Dallas-area bikes look 40 miles away,
 * which is exactly the kind of error that wastes a 200-mile round trip. So any
 * match preceded by "Within" is rejected outright.
 */
function parseMarketplaceDistance(text) {
  if (!text) return field(null, 'unknown');
  const s = String(text);

  for (const m of s.matchAll(/·\s*(\d{1,3})\s*mi\b/gi)) {
    const before = s.slice(Math.max(0, m.index - 20), m.index);
    if (/within\s*$/i.test(before)) continue;        // that's the search radius
    return field(Number(m[1]), 'stated', 'marketplace');
  }
  const away = s.match(/\b(\d{1,3})\s*miles?\s+away\b/i);
  if (away) return field(Number(away[1]), 'stated', 'marketplace');

  return field(null, 'unknown');
}

/** "Listed 7 weeks ago in San Antonio, TX" → ISO-ish age. */
function parseListedAge(text) {
  if (!text) return field(null, 'unknown');
  const m = String(text).match(/Listed\s+(?:about\s+)?(a|an|\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return field(null, 'unknown');
  const n = /^(a|an)$/i.test(m[1]) ? 1 : Number(m[1]);
  const unitDays = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
  const days = Math.round(n * unitDays);
  const d = new Date(Date.now() - days * 86400000);
  return field(d.toISOString().slice(0, 10), 'inferred', `"${m[0]}"`);
}

/** Seller name + dealer/private signal. */
function parseSeller(sellerText, descText) {
  const blob = `${sellerText || ''}\n${descText || ''}`;
  let name = null;
  const nm = String(sellerText || '').match(/Seller information\s*\n?\s*(?:Seller details\s*\n?\s*)?([A-Z][A-Za-z .'\-]{1,40})/);
  if (nm) name = nm[1].trim();

  const dealerSignals = /\b(dealer|dealership|motorsports?|powersports?|inc\.?|llc|financing available|apply today|out the door|doc fee|we finance|trade-?ins? welcome)\b/i;
  const isDealer = dealerSignals.test(blob);
  // Many identical vehicles from one seller is a dealer tell (and a scam tell).
  return {
    name: name ? field(name, 'stated', 'listing') : field(null, 'unknown'),
    type: field(isDealer ? 'Dealer' : 'Private', isDealer ? 'inferred' : 'inferred',
      isDealer ? 'dealer keywords in listing' : 'no dealer keywords found'),
  };
}

/** Variant hints ("ABS", "SE", "KRT", "Monster Energy"). */
function parseVariant(text) {
  if (!text) return field(null, 'unknown');
  const bits = [];
  if (/\babs\b/i.test(text)) bits.push('ABS');
  if (/\bkrt\b|ninja\s*krt/i.test(text)) bits.push('KRT Edition');
  if (/\bse\b(?!\w)/i.test(text)) bits.push('SE');
  if (/monster energy/i.test(text)) bits.push('Monster Energy');
  if (/\bsp\b(?!\w)/i.test(text)) bits.push('SP');
  return bits.length ? field(bits.join(', '), 'inferred', 'title/description keywords') : field(null, 'unknown');
}

/** Build a normalised listing from a search card plus (optional) detail page. */
function normalize(card, detail, ambiguous) {
  const url = card.url || detail?.url;
  const cardText = card.raw || '';
  const head = detail?.head || '';
  const desc = detail?.desc || '';
  // Facebook's own structured "Driven X miles / Manual transmission" facts
  // block. Extracted separately from `head` in marketplace.js specifically
  // because it is NOT page chrome -- unlike the rest of `head`, it is safe to
  // trust for mileage. Missed entirely before this: a real $4,300 listing
  // whose free-text description never restated the mileage was landing in
  // Needs Review as "mileage unconfirmed" despite the figure sitting right
  // there in Facebook's own vehicle-details UI.
  const aboutVehicle = detail?.aboutVehicle || '';
  const sellerRaw = detail?.seller || '';
  // Order matters: title/head is most authoritative, then card, then description.
  const blob = [head, cardText, desc].filter(Boolean).join('\n');

  /**
   * MODEL IDENTIFICATION reads the page TITLE first, not the body blob.
   *
   * The body is not safe to match a model against. `head` is sliced from the
   * raw page text, so when a detail page has not fully rendered it contains
   * Facebook's left nav and -- critically -- the search box still holding the
   * query that found the listing. A "yamaha r3" search therefore injects "r3"
   * into the blob, and a real listing titled "2023 CFMOTO ss" was stored as a
   * Yamaha R3 and surfaced as the second-best find at 8.3/10.
   *
   * document.title is the listing's own name ("Marketplace - 2023 CFMOTO ss"),
   * is set from the listing record rather than the surrounding page, and cannot
   * carry the search term. Strip Facebook's wrapper and match that first; fall
   * back to the card text, which is also listing-scoped, and only then the blob.
   */
  const pageTitle = String(detail?.title || '')
    .replace(/^\(\d+\)\s*/, '')            // unread-notification counter
    .replace(/\s*\|\s*Facebook\s*$/i, '')
    .replace(/^\s*Marketplace\s*-\s*/i, '')
    .trim();

  // Only listing-SCOPED text is eligible: the page title, the search card, and
  // the description (sliced between the Details and Seller headings). `head`
  // and therefore `blob` are deliberately NOT consulted -- that is where the
  // nav and the retained search query live, and matching them is the bug above.
  const model = cfg.identifyModel(pageTitle)
             || cfg.identifyModel(cardText)
             || cfg.identifyModel(desc);
  const modelSource = cfg.identifyModel(pageTitle) ? 'listing title'
                    : cfg.identifyModel(cardText) ? 'search card'
                    : model ? 'description' : null;

  return {
    listingId: listingId(url),
    url,
    // The blob includes the full detail page, so a vague card title like
    // "2021 Kawasaki ninja" usually resolves here once the description is in.
    model: model ? field(model.label, 'inferred', modelSource) : field(null, 'unknown'),
    modelKey: model ? model.key : null,
    ambiguous: model ? null : (ambiguous || null),
    variant: parseVariant([pageTitle, cardText, desc].filter(Boolean).join('\n')),
    year: parseYear(pageTitle || head || cardText || blob),
    price: parsePrice(cardText || head),
    mileage: parseMileage([pageTitle, cardText, aboutVehicle, desc].filter(Boolean).join('\n')),
    location: parseLocation(cardText || head),
    marketplaceDistance: parseMarketplaceDistance(blob),
    datePosted: parseListedAge(head || blob),
    seller: parseSeller(sellerRaw, desc),
    description: desc || null,
    images: detail?.images || (card.thumb ? [card.thumb] : []),
    rawCardText: cardText,
    fetchedAt: new Date().toISOString(),
  };
}

/** Which decision-critical fields are still unknown. Drives NEEDS REVIEW. */
function missingCritical(listing) {
  const miss = [];
  if (!listing.model.value) miss.push('model');
  if (!listing.year.value) miss.push('year');
  if (listing.price.value == null) miss.push('price');
  if (listing.mileage.value == null) miss.push('mileage');
  if (!listing.location.value && listing.marketplaceDistance.value == null) miss.push('location/distance');
  return miss;
}

module.exports = {
  field, listingId, parsePrice, parseYear, parseMileage, parseLocation,
  parseMarketplaceDistance, parseListedAge, parseSeller, parseVariant,
  normalize, missingCritical,
};
