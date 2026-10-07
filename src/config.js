'use strict';
/**
 * Config loader. Reads .env (no dotenv dependency) and normalises types.
 * Every tunable in the system comes from here so nothing is hardcoded deep
 * inside logic.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile();

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const list = (v, d = []) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : d);

const cfg = {
  root: ROOT,
  port: num(process.env.PORT, 8477),
  host: process.env.HOST || '127.0.0.1',
  apiKey: process.env.SCOUT_API_KEY || '',

  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',
  reuseExistingTab: bool(process.env.REUSE_EXISTING_TAB, true),

  home: {
    lat: num(process.env.HOME_LAT, 30.3799),
    lon: num(process.env.HOME_LON, -97.9028),
    label: process.env.HOME_LABEL || 'Steiner Ranch, Austin, TX',
  },
  // Search centroids. Was five cities at 80 mi each, which is mostly overlap:
  // the acceptance region is a 100 mi circle around home (cfg.criteria.near),
  // and San Marcos / New Braunfels / Killeen all sit inside an Austin-centred
  // 100 mi search. Two centroids at 100 mi cover the same region in 12
  // searches instead of 30 -- roughly 7 fewer minutes of fixed delays per
  // sweep -- and stop pulling in statewide results that only get rejected
  // on distance anyway. SEARCH_CITIES / SEARCH_RADIUS_MILES override this.
  cities: list(process.env.SEARCH_CITIES, ['austin', 'sanantonio']),
  searchRadiusMiles: num(process.env.SEARCH_RADIUS_MILES, 100),
  // newest | relevance | alternate. Facebook returns at most ~66 cards per
  // search however far you scroll, so WHICH 66 matters.
  //
  // DEFAULT IS 'relevance' (2026-10-07). Forcing sortBy=creation_time_descend
  // makes Facebook rank the whole marketplace by recency and essentially
  // ignore the query: a "kawasaki ninja" search came back as sourdough
  // starter, LOL dolls, Nike shorts and an iPhone, with not one motorcycle on
  // the first three rows. Newest-first does surface fresh postings, but they
  // are fresh postings of ANYTHING, so the 66-card budget gets spent on junk
  // the filters then throw away. Relevance order keeps the 66 on-topic.
  //
  // 'newest' and 'alternate' are kept for one reason: if a sweep ever needs to
  // catch brand-new listings of a model that already ranks well, newest-first
  // on a narrow query still works. Do not make either the default again
  // without checking the first page of real results.
  searchSort: (process.env.SEARCH_SORT || 'relevance').toLowerCase(),
  searchMaxPrice: num(process.env.SEARCH_MAX_PRICE, 4500),

  delays: {
    betweenSearches: num(process.env.DELAY_BETWEEN_SEARCHES_MS, 9000),
    betweenListings: num(process.env.DELAY_BETWEEN_LISTINGS_MS, 6000),
    jitter: num(process.env.DELAY_JITTER_MS, 4000),
  },
  maxListingsPerRun: num(process.env.MAX_LISTINGS_PER_RUN, 25),
  maxConsecutiveFailures: num(process.env.MAX_CONSECUTIVE_FAILURES, 4),
  // Circuit breaker for the whole sweep. Added after a run hung 52 minutes
  // writing nothing: a blocked renderer (JS dialog) made navigate()'s retry
  // loop take minutes per call with no exception thrown, so nothing in the
  // per-attempt error handling ever caught it. This is a backstop independent
  // of that specific cause -- whatever makes a future sweep run long, it can
  // no longer run unbounded.
  //
  // 22 min, not a smaller number, because stage 1 alone (5 cities x 5 models
  // x 1 query in test mode = 25 searches) measured 16.2-16.4 minutes on ITS
  // OWN in two completed, non-wedged runs -- before stage 2 opens a single
  // listing. The n8n workflow's Configuration node also passes limit:25
  // (not test mode's default of 3), so a full run realistically needs
  // 18-25 minutes end to end. A tighter deadline would silently truncate
  // stage 1 on every single hourly run and never reach stage 2 at all. The
  // n8n HTTP Request node calling /run must have its own timeout raised to
  // comfortably clear this (see the n8n workflow itself, node "5. Run
  // Marketplace Sweep" -- its timeout was 900000ms / 15 min, already tighter
  // than observed normal-case duration even before this circuit breaker
  // existed; the README's troubleshooting table flagged this tension).
  maxSweepMinutes: num(process.env.MAX_SWEEP_MINUTES, 22),

  sheetId: process.env.SHEET_ID || '',
  googleSaJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',

  ai: {
    provider: (process.env.AI_PROVIDER || '').toLowerCase(),
    apiKey: process.env.AI_API_KEY || '',
    visionModel: process.env.AI_VISION_MODEL || 'gpt-4o-mini',
    maxVisionCalls: num(process.env.MAX_VISION_CALLS_PER_RUN, 10),
  },

  testMode: bool(process.env.TEST_MODE, true),
  enableFacebookSave: bool(process.env.ENABLE_FACEBOOK_SAVE, false),
  enableNotifications: bool(process.env.ENABLE_NOTIFICATIONS, false),

  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/scout.db'),
  logPath: path.resolve(ROOT, process.env.LOG_PATH || './logs'),
  modelCacheTtlHours: num(process.env.MODEL_CACHE_TTL_HOURS, 336),
};

/** Models we hunt for. `match` must be anchored enough to avoid "CBR300" → "R3". */
cfg.models = [
  {
    key: 'yamaha_r3',
    label: 'Yamaha R3',
    match: /(^|[^a-z0-9])(yzf[\s-]?r[\s-]?3|yamaha[^|]{0,14}\br\s?3\b|\br3\b)(?![0-9])/i,
    firstYear: 2015,
  },
  {
    key: 'ninja_400',
    label: 'Kawasaki Ninja 400',
    match: /(ninja\s*400|400\s*ninja|\bex\s?400\b)/i,
    firstYear: 2018,
  },
  {
    key: 'ninja_500',
    label: 'Kawasaki Ninja 500',
    // EX500 "Ninja 500R" is a 1987-2009 bike; the year filter rejects it anyway.
    match: /(ninja\s*500|500\s*ninja|\bex\s?500\b)/i,
    firstYear: 2024,
  },
  {
    // The 300 that preceded the 400 (2013-2017). Same reasoning as 500 above:
    // a stale EX300 could theoretically collide with something ancient, but
    // cfg.criteria's year floor handles that regardless of this match.
    key: 'ninja_300',
    label: 'Kawasaki Ninja 300',
    match: /(ninja\s*300|300\s*ninja|\bex\s?300\b)/i,
    firstYear: 2013,
  },
  {
    key: 'aprilia_rs457',
    label: 'Aprilia RS 457',
    match: /(rs[\s-]?457|aprilia[^|]{0,12}457)/i,
    firstYear: 2024,
  },
  /**
   * CFMoto sells three distinct 450cc models -- SS (sportbike), NK (naked),
   * SR (adventure-ish) -- and one regex used to catch all three trims under
   * the single label "CFMoto 450SS". Found by auditing a real listing titled
   * "2026 CFMOTO 450nk" that was stored and shown to Jaiden as a "450SS": a
   * genuinely for-sale bike, correctly priced, just the WRONG MODEL NAME,
   * which is exactly the kind of mismatch this audit exists to catch. Split
   * into three entries, each requiring its own trim letters explicitly
   * stated; a bare "450" with no trim letter falls through to
   * maybe_cfmoto450 below instead of guessing.
   */
  {
    key: 'cfmoto_450ss',
    label: 'CFMoto 450SS',
    // Bare "CFMOTO ss" with no displacement number is still the 450SS -- it
    // is the only SS CFMoto sells in this price range, and real listings
    // write it that way (see the 2023 CFMOTO ss case this was built for).
    match: /(cf\s?moto[^|]{0,12}\b(450\s?ss|ss)\b|450\s?ss\b)/i,
    firstYear: 2023,
  },
  {
    key: 'cfmoto_450nk',
    label: 'CFMoto 450NK',
    match: /(cf\s?moto[^|]{0,12}450\s?nk|450\s?nk\b)/i,
    firstYear: 2023,
  },
  {
    key: 'cfmoto_450sr',
    label: 'CFMoto 450SR',
    match: /(cf\s?moto[^|]{0,12}450\s?sr|450\s?sr\b)/i,
    firstYear: 2024,
  },
  {
    key: 'cfmoto_300',
    label: 'CFMoto 300 (NK/SR)',
    match: /(cf\s?moto[^|]{0,12}300|300\s?(nk|sr|ss)\b)/i,
    firstYear: 2018,
  },
  {
    key: 'cfmoto_500',
    label: 'CFMoto 500 (NK/SR/SS)',
    match: /(cf\s?moto[^|]{0,12}500|500\s?(nk|sr|ss)\b)/i,
    firstYear: 2021,
  },
  {
    // Same 321cc engine as the R3, naked instead of faired. Was previously
    // excluded outright by the ambiguous-title exclusion list (mt-?\d+) with
    // no rule to catch it, so every MT-03 listing was silently dropped.
    key: 'yamaha_mt03',
    label: 'Yamaha MT-03',
    match: /\bmt-?03\b/i,
    firstYear: 2016,
  },
  {
    key: 'honda_cbr300',
    label: 'Honda CBR300R',
    match: /(cbr\s?300|honda[^|]{0,12}cbr[^|]{0,6}300)/i,
    firstYear: 2015,
  },
  {
    key: 'honda_cbr500',
    label: 'Honda CBR500R',
    match: /(cbr\s?500|honda[^|]{0,12}cbr[^|]{0,6}500)/i,
    firstYear: 2013,
  },
  {
    // Deliberately stops at 600, not 650 -- CBR650R/F are a different,
    // heavier platform and outside the 300-600 range actually asked for.
    key: 'honda_cbr600',
    label: 'Honda CBR600RR',
    match: /(cbr\s?600|honda[^|]{0,12}cbr[^|]{0,6}600)/i,
    firstYear: 2007,
  },
];

/**
 * Facebook searches actually run, decoupled from cfg.models on purpose.
 *
 * The original design ran one Marketplace search PER MODEL, which worked
 * fine at 5 models (25 searches/sweep) but does not scale: at 12 models that
 * is 60 searches/sweep, and stage 1 alone was already measured at ~16
 * minutes for 25 -- 60 would blow well past MAX_SWEEP_MINUTES before a
 * single listing got opened, every run, forever.
 *
 * Facebook's search is fuzzy text matching, not an exact filter, and
 * cheapGate() re-validates every card against every tracked model
 * regardless of which query surfaced it. So one broad "kawasaki ninja"
 * search already surfaces Ninja 300/400/500 listings together -- running
 * three separate narrow searches for the same family buys nothing but
 * triples the cost. Broader queries here, not more of them, is what makes
 * adding models later not re-trigger this.
 */
cfg.searchQueries = [
  'yamaha r3',
  'yamaha mt-03',
  'kawasaki ninja',
  'honda cbr',
  'cfmoto',
  'aprilia rs 457',
];

/** Thresholds. Perfect is the strict bar; near is the wider net. */
cfg.criteria = {
  perfect: { minYear: 2015, maxMiles: 15000, maxPrice: 4100, maxDistance: 80 },
  near:    { minYear: 2014, maxMiles: 18000, maxPrice: 4500, maxDistance: 100 },
};

cfg.modelByKey = Object.fromEntries(cfg.models.map(m => [m.key, m]));

/**
 * Words that mean "not one of our sportbikes". Kawasaki, Yamaha and CFMoto all
 * sell ATVs, side-by-sides, cruisers and watercraft in the same price band, and
 * every one we open burns a slot out of maxListingsPerRun that a real candidate
 * could have used.
 */
const NOT_SPORTBIKE = [
  'grizzly','raptor','banshee','kodiak','wolverine','viking','yfz','blaster',
  'waverunner','wave\\s?runner','jet\\s?ski','seadoo','sea\\s?doo','pwc',
  'mule','brute\\s?force','teryx','bayou','prairie','ridge',
  'v\\s?star','vstar','bolt','raider','stratoliner','road\\s?star','virago',
  't-?max','zuma','x-?max','majesty','vino','smax','golf\\s?cart','generator',
  'outboard','atv','utv','side\\s?by\\s?side','dirt\\s?bike','four\\s?wheeler',
  // Honda's non-CBR lineup. Added alongside honda_cbr300/500/600 so a bare
  // "2021 Honda" (no displacement stated) doesn't burn an open-budget slot
  // on a Rebel, an ATV, or a Gold Wing.
  'rebel','shadow','africa\\s?twin','grom','monkey','ruckus',
  'gold\\s?wing','goldwing','foreman','rancher','rincon','pioneer',
  'fury','vtx','magna','interceptor','\\bvfr\\b',
];

/**
 * A model or displacement is stated, so a more specific rule should own the
 * listing rather than the catch-all brand-only rule.
 *
 * Split in two deliberately. Displacement NUMBERS cannot be matched as bare
 * substrings: "400" appears inside the price of "$4,400" and inside "4,400
 * miles", which silently excluded genuine brand-only listings and silently
 * included a Kawasaki jet ski. They get a lookbehind rejecting a preceding
 * digit, comma, dollar sign or period; the word-based entries do not need it.
 */
const MODEL_WORDS = [
  'ninja','yzf','r3','vulcan','versys','concours','drz','klr','tenere',
  'fjr','fz','mt-?\\d+','r6','r1','z\\d{3,4}','cbr',
];
const DISPLACEMENTS = ['400','450','500','457','650','600','300','250'];

/** Bare number, but never one that is part of a price or a mileage figure. */
const DISPLACEMENT_RE = new RegExp(
  '(?<![\\d,$.])\\b(' + DISPLACEMENTS.join('|') + ')\\b(?!\\s*(?:miles|mi\\b|k\\b))', 'i');

const MODEL_WORDS_RE = new RegExp('\\b(?:' + MODEL_WORDS.join('|') + ')\\b', 'i');

/** True when the text names a model or a displacement. */
const modelStated = t => MODEL_WORDS_RE.test(t) || DISPLACEMENT_RE.test(t);

const NOT_SPORTBIKE_RE = new RegExp(NOT_SPORTBIKE.join('|'), 'i');

/**
 * CBR displacements outside the tracked 300/500/600 range. Needs its OWN
 * check rather than relying on modelStated(): real listings write the model
 * glued directly to the number with no space ("CBR650R"), and \b fails to
 * match between two word characters (the letter "R" and the digit "6"), so
 * the shared MODEL_WORDS_RE/DISPLACEMENT_RE boundary checks silently missed
 * it. That let a specific, explicitly out-of-range model ("CBR650R") slip
 * through maybe_brand_only as if it were still unresolved.
 */
// No trailing \b: "CBR650R" has a trim letter glued directly to the number
// with no space, and \b cannot match between two word characters (the digit
// "0" and the letter "R"). The same mistake was caught once already in the
// honda_cbr300/500/600 match patterns above -- same fix applies here.
const CBR_OUT_OF_RANGE_RE = /\bcbr\s?(650|750|900|919|929|954|1000|1100|1300)/i;

/**
 * AMBIGUOUS titles. Plenty of sellers write "2021 Kawasaki ninja" or
 * "2017 Yamaha yzf" with no displacement at all — Facebook's own vehicle form
 * encourages that. Those were being dropped at the cheap gate, which means
 * genuinely matching bikes never got looked at.
 *
 * These patterns deliberately DO NOT confirm a model. They only say "this is
 * worth opening" so the detail page can settle it, which is exactly what the
 * staged pipeline is for.
 */
cfg.ambiguous = [
  {
    // "Kawasaki ninja" / "ninja" with NO number following
    key: 'maybe_ninja',
    candidates: ['ninja_400', 'ninja_500'],
    match: /\bninja\b(?!\s*[-]?\s*\d)/i,
    minYear: 2018,                       // Ninja 400 launched 2018
    note: 'Title says Ninja with no displacement',
  },
  {
    // "Yamaha yzf" / "yzfr" with no model number. Could be R1/R6/R3, but R1/R6
    // almost never land under $4,500, so a cheap one is worth a look.
    key: 'maybe_yzf',
    candidates: ['yamaha_r3'],
    match: /\byzf\s?r?\b(?!\s*[-]?\s*\d)|yamaha[^|]{0,10}\byzf\b(?!\s*[-]?\s*\d)/i,
    minYear: 2015,
    note: 'Title says YZF with no model number',
  },
  {
    // Bare "CBR" with no displacement, same shape as maybe_ninja above --
    // could be the 300, 500 or 600, worth opening to check.
    key: 'maybe_cbr',
    candidates: ['honda_cbr300', 'honda_cbr500', 'honda_cbr600'],
    match: /\bcbr\b(?!\s*[-]?\s*\d)/i,
    minYear: 2007,
    note: 'Title says CBR with no displacement',
  },
  {
    // "CFMoto 450" with NO trim letter -- could be SS, NK or SR, same shape
    // as maybe_cbr above. A bare number must still be guarded against price
    // digits the same way maybe_400 is, hence the lookbehind.
    key: 'maybe_cfmoto450',
    candidates: ['cfmoto_450ss', 'cfmoto_450nk', 'cfmoto_450sr'],
    match: /cf\s?moto[^|]{0,12}(?<![\d,$.])\b450\b(?!\s*(?:miles|mi\b|k\b))/i,
    minYear: 2023,
    note: 'Title says CFMoto 450 with no trim letter (SS/NK/SR)',
  },
  {
    // JUST a year and a brand: "2021 Kawasaki", "2019 Yamaha". Facebook's own
    // vehicle form produces these constantly -- the seller picks a make from a
    // dropdown and never types the model. Worth opening: the description or the
    // detail page almost always names the actual bike.
    key: 'maybe_brand_only',
    candidates: [
      'ninja_400', 'ninja_500', 'ninja_300', 'yamaha_r3', 'yamaha_mt03',
      'aprilia_rs457', 'cfmoto_450ss', 'cfmoto_450nk', 'cfmoto_450sr', 'cfmoto_300', 'cfmoto_500',
      'honda_cbr300', 'honda_cbr500', 'honda_cbr600',
    ],
    match: /\b(kawasaki|yamaha|aprilia|cf\s?moto|honda)\b/i,
    // Only when NO model word is present (a more specific rule owns those) and
    // the listing is not obviously an ATV, cruiser, watercraft, or a CBR
    // displacement we don't track (650+).
    excludeIf: t => modelStated(t) || NOT_SPORTBIKE_RE.test(t) || CBR_OUT_OF_RANGE_RE.test(t),
    minYear: 2015,
    // The premise of this rule is "a year AND a brand", so a stated year is
    // mandatory. Without it the minYear floor silently does not apply (the
    // matcher skips the check when year is null) and the rule degrades into
    // "mentions a brand", which pulled in $199 accessories 200 miles away.
    requiresYear: true,
    note: 'Only a year and a brand were given, model not stated',
  },
  {
    // Bare "Kawasaki 400" / "400" alongside a sportbike word.
    //
    // The lookbehind is essential: a plain /\b400\b/ also matches the tail of
    // every price containing 400, so "$2,400 | 2019 Kawasaki jet ski" was being
    // opened as a possible Ninja 400. Rejecting a preceding digit, comma or
    // dollar sign keeps real displacements and drops price digits.
    key: 'maybe_400',
    candidates: ['ninja_400'],
    match: /(?<![\d,$.])\b400\b(?!\s*(?:miles|mi\b|k\b))/i,
    requires: /kawasaki|ninja|sport|sportbike/i,
    excludeIf: t => NOT_SPORTBIKE_RE.test(t),
    minYear: 2018,
    note: 'Mentions 400 near Kawasaki/sportbike wording',
  },
];

/** Identify which tracked model a piece of text refers to, or null. */
cfg.identifyModel = function identifyModel(text) {
  if (!text) return null;
  for (const m of cfg.models) if (m.match.test(text)) return m;
  return null;
};

/**
 * Could this vague listing be one of ours? Returns the ambiguity record or null.
 * Never returns a confirmed model — resolution happens after the listing opens.
 */
cfg.identifyAmbiguous = function identifyAmbiguous(text, year) {
  if (!text) return null;
  for (const a of cfg.ambiguous) {
    if (!a.match.test(text)) continue;
    if (a.requires && !a.requires.test(text)) continue;
    // `excludeIf` keeps the broad brand-only rule from swallowing listings that
    // a more specific pattern should own, and drops this brand's ATVs/watercraft.
    if (a.excludeIf && a.excludeIf(text)) continue;
    if (a.requiresYear && year == null) continue;
    if (year != null && a.minYear && year < a.minYear) continue;
    return a;
  }
  return null;
};


/**
 * Marketplace URL parameters, learned empirically against the live site.
 *
 * THE BIG ONE: `radius` is in KILOMETRES, not miles. radius=80 renders as
 * "Within 50 mi" which is what made every earlier attempt look broken. Verified
 * exactly across 6 values: 2->1mi, 32->20mi, 64->40mi, 97->60mi, 129->80mi,
 * 161->100mi.
 *
 * Why this matters beyond correctness: setting the radius by URL removes the
 * whole click-the-dialog routine, which in turn removes every synthetic mouse
 * and keyboard event. No input events means no Page.bringToFront(), which means
 * the scout never steals focus from whatever you are actually doing.
 */
cfg.url = {
  milesToKm: mi => Math.round(mi * 1.60934),
  /** Build a search URL. Pure navigation, no UI interaction required. */
  search({ city = 'austin', query, maxPrice, minPrice, radiusMiles = 80,
           sortBy, daysSinceListed, exact = false, lat, lon } = {}) {
    const p = new URLSearchParams();
    if (query) p.set('query', query);
    if (minPrice != null) p.set('minPrice', String(minPrice));
    if (maxPrice != null) p.set('maxPrice', String(maxPrice));
    if (radiusMiles != null) p.set('radius', String(cfg.url.milesToKm(radiusMiles)));
    // NOT YET VERIFIED against the live site, unlike query/maxPrice/radius
    // above. Values below are the ones Facebook's own UI emits, but nothing in
    // this repo has confirmed they still take effect, so do not trust a run
    // that depends on them until someone checks the rendered page.
    if (sortBy) p.set('sortBy', sortBy);               // creation_time_descend | price_ascend | distance_ascend
    if (daysSinceListed) p.set('daysSinceListed', String(daysSinceListed));
    if (exact) p.set('exact', 'true');
    // lat/lon narrows further and overrides the city slug's centroid
    if (lat != null && lon != null) { p.set('latitude', String(lat)); p.set('longitude', String(lon)); }
    return `https://www.facebook.com/marketplace/${city}/search?${p.toString()}`;
  },
};

module.exports = cfg;
