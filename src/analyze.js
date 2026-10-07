'use strict';
/**
 * Title status, modification profile, scam risk, and photo analysis.
 *
 * Language discipline enforced here:
 *   - Nothing is asserted as damage unless the evidence supports it.
 *   - Photo findings are always phrased "appears to show" / "possible" /
 *     "cannot confirm from photo".
 *   - Scam output is always "risk", never an accusation that someone IS a
 *     scammer. A cheap bike is a *risk signal*, not proof of fraud.
 */
const cfg = require('./config');
const { field } = require('./parse');

/* ───────────────────────── TITLE ───────────────────────── */

const TITLE_PATTERNS = [
  { status: 'Salvage',    re: /\bsalvage\b|\bsalvaged\b/i,                     reject: true },
  { status: 'Rebuilt',    re: /\brebuilt\b|\breconstructed\b|\brebuild title/i, reject: true },
  { status: 'Flood',      re: /\bflood(ed)?\s*(title|damage)\b/i,              reject: true },
  { status: 'Parts Only', re: /\bparts?\s*(only|bike)\b|\bbill of sale only\b/i, reject: true },
  { status: 'No Title',   re: /\bno\s*title\b|\btitle\s*(is\s*)?(lost|missing)\b|\bwithout\s*(a\s*)?title\b/i, reject: true },
  { status: 'Clean',      re: /\bclean\s*(and\s*clear\s*)?title\b|\btitle\s*in\s*hand\b|\bclear\s*title\b|\btítulo\s*limpio\b/i, reject: false },
];

function analyzeTitle(text) {
  const s = String(text || '');
  for (const p of TITLE_PATTERNS) {
    if (p.re.test(s)) {
      return {
        status: field(p.status, 'stated', 'title keyword in listing'),
        reject: p.reject,
      };
    }
  }
  return { status: field(null, 'unknown', 'no title language found in listing'), reject: false };
}

/* ─────────────────────── MODIFICATIONS ─────────────────── */

/** Acceptable, common, generally reversible. Never a reason to reject alone. */
const MINOR_MODS = [
  { k: 'Slip-on exhaust',   re: /\bslip[\s-]?on\b|\bakrapovic\b|\byoshimura\b|\bm4 exhaust\b|\btwo brothers\b|\bexhaust\b/i },
  { k: 'Fender eliminator', re: /\bfender\s*eliminator\b|\btail\s*tidy\b/i },
  { k: 'Frame sliders',     re: /\bframe\s*sliders?\b|\bcrash\s*(bobbins|protect)/i },
  { k: 'Adjustable levers', re: /\badjustable\s*levers?\b|\bcnc\s*levers?\b/i },
  { k: 'Windscreen',        re: /\bwind(screen|shield)\b|\bdouble\s*bubble\b/i },
  { k: 'Phone mount',       re: /\bphone\s*mount\b|\bquad\s*lock\b|\bram\s*mount\b/i },
  { k: 'Cosmetic/LED',      re: /\bled\s*(lights?|signals?)\b|\bgraphics\s*kit\b|\bvinyl\s*wrap\b/i },
];

/** Disqualifying. These correlate with abuse or reliability loss. */
const MAJOR_MODS = [
  { k: 'Stunt build',        re: /\bstunt(er|ing)?\b|\bwheelie\s*(bar|machine)\b|\b12\s*o'?clock\b|\bcage\b|\bsubcage\b|\bstunt\s*cage\b/i },
  { k: 'Dedicated track bike', re: /\btrack\s*(bike|only|prepped?|day\s*bike)\b|\brace\s*(bike|only|prepped?)\b|\bno\s*lights?\b.*\btrack\b|\bsafety\s*wire[d]?\b|\blockwire/i },
  { k: 'Engine modified',    re: /\bbig\s*bore\b|\bstroker\b|\bported\b|\bcams?\s*(swap|upgrade)\b|\bturbo\b|\bsupercharg/i,  },
  { k: 'Stripped',           re: /\bstripped\b|\bno\s*(fairings?|bodywork)\b|\bstreet\s*fighter(ed)?\b|\bnaked\s*conversion\b/i },
  { k: 'Wiring altered',     re: /\brewired\b|\bwiring\s*(harness\s*)?(cut|spliced|modified|hacked)\b|\bbutchered\s*wiring\b/i },
  { k: 'Race ECU/tune',      re: /\brace\s*ecu\b|\bflashed?\s*ecu\b|\bpower\s*commander\b|\bbazzaz\b|\bquick\s*shifter\b/i },
];

function analyzeMods(text) {
  const s = String(text || '');
  const minor = MINOR_MODS.filter(m => m.re.test(s)).map(m => m.k);
  const major = MAJOR_MODS.filter(m => m.re.test(s)).map(m => m.k);
  const reject = major.length > 0;
  return {
    minor,
    major,
    reject,
    summary: [...major.map(m => `MAJOR: ${m}`), ...minor].join('; ') || 'None mentioned',
    // A bike can be rejected for mods even if everything else is perfect.
    rejectReason: reject ? `Heavily modified: ${major.join(', ')}` : null,
  };
}

/* ───────────────────────── PHOTOS ──────────────────────── */

/**
 * Photo analysis.
 *
 * Two modes:
 *   1. AI_PROVIDER configured → real vision analysis of the listing images.
 *   2. No provider → text-derived observations ONLY, clearly labelled as such.
 *
 * Mode 2 does NOT claim to have looked at pictures. That distinction matters:
 * calling a keyword scan "photo analysis" would be a lie that could cost money.
 */
const PHOTO_CHECKLIST = [
  'scratches', 'cracked fairings', 'missing fairings', 'mismatched fairing colors',
  'bent levers', 'broken or missing mirrors', 'missing turn signals',
  'aftermarket exhaust', 'frame sliders', 'engine case damage', 'bar-end damage',
  'crash damage', 'denting', 'rust', 'corrosion', 'fluid leaks', 'tire condition',
  'chain condition', 'sprocket condition', 'fork seal leakage', 'missing bodywork',
  'track-prep clues', 'stunt-bike clues', 'aftermarket engine components',
  'wiring modifications', 'suspicious cosmetic repairs',
];

const VISION_PROMPT = `You are inspecting photos of a used motorcycle for a careful buyer.
Report ONLY what the images reasonably support. For anything uncertain use
"possible", "appears to show", or "cannot confirm from photo".
Never state damage as fact unless it is clearly visible.

Check for: ${PHOTO_CHECKLIST.join(', ')}.

Return strict JSON:
{
 "observations": ["short phrases, each hedged if uncertain"],
 "damageFound": ["only items clearly visible"],
 "possibleIssues": ["items that are uncertain"],
 "modsVisible": ["aftermarket parts visible"],
 "trackOrStuntClues": ["evidence of track prep or stunt use, else empty"],
 "stockPhotoSuspected": true|false,
 "photoQuality": "good|fair|poor",
 "confidence": "high|medium|low"
}`;

async function analyzePhotosWithAI(images, budget) {
  if (!cfg.ai.provider || !cfg.ai.apiKey) return null;
  if (!images || !images.length) return null;
  if (budget && budget.used >= cfg.ai.maxVisionCalls) {
    return { skipped: true, reason: 'vision_budget_exhausted' };
  }
  const urls = images.slice(0, 4);
  try {
    let res;
    if (cfg.ai.provider === 'openai' || cfg.ai.provider === 'groq') {
      const base = cfg.ai.provider === 'groq'
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
      res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.ai.apiKey}` },
        body: JSON.stringify({
          model: cfg.ai.visionModel,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              ...urls.map(u => ({ type: 'image_url', image_url: { url: u } })),
            ],
          }],
          max_tokens: 700,
        }),
      });
    } else if (cfg.ai.provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.ai.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.ai.visionModel,
          max_tokens: 700,
          messages: [{ role: 'user', content: [{ type: 'text', text: VISION_PROMPT + '\n\nImage URLs:\n' + urls.join('\n') }] }],
        }),
      });
    } else {
      return null;
    }
    if (!res.ok) return { error: `vision_http_${res.status}` };
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content || j.content?.[0]?.text || '';
    if (budget) budget.used++;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'vision_unparseable' };
    return { ...JSON.parse(m[0]), source: 'vision-model' };
  } catch (e) {
    return { error: 'vision_exception', detail: String(e.message).slice(0, 160) };
  }
}

/** Heuristic fallback. Honest about being text-only. */
function analyzePhotosFromText(text, imageCount) {
  const s = String(text || '');
  const obs = [];
  const hit = (re, msg) => { if (re.test(s)) obs.push(msg); };
  hit(/\bscratch(es|ed)?\b/i, 'Seller mentions scratches');
  hit(/\bcrack(ed)?\b/i, 'Seller mentions cracked part');
  hit(/\bdrop(ped)?\b|\blaid (it )?down\b|\btip(ped)? over\b/i, 'Seller mentions a drop or tip-over');
  hit(/\bcrash(ed)?\b|\bwreck(ed)?\b/i, 'Seller mentions a crash');
  hit(/\brust|corros/i, 'Seller mentions rust or corrosion');
  hit(/\bleak(s|ing|ed)?\b/i, 'Seller mentions a leak');
  hit(/\bnew tires?\b/i, 'Seller states new tires');
  hit(/\btires? (need|are worn|low)\b/i, 'Seller indicates tires need replacement');
  hit(/\bneeds?\s+(work|repair|tlc|fixing)\b/i, 'Seller states the bike needs work');
  return {
    observations: obs.length ? obs : ['No condition details stated in the listing text'],
    damageFound: [],
    possibleIssues: obs,
    modsVisible: [],
    trackOrStuntClues: [],
    stockPhotoSuspected: imageCount === 1,
    photoQuality: 'unknown',
    confidence: 'low',
    source: 'text-heuristic',
    note: 'No vision model configured. These come from the listing TEXT only; the photos were not examined.',
  };
}

async function analyzePhotos(listing, budget) {
  const ai = await analyzePhotosWithAI(listing.images, budget);
  if (ai && !ai.error && !ai.skipped) return ai;
  const fallback = analyzePhotosFromText(
    `${listing.description || ''}\n${listing.rawCardText || ''}`,
    (listing.images || []).length
  );
  if (ai?.error) fallback.aiError = ai.error;
  if (ai?.skipped) fallback.aiSkipped = ai.reason;
  return fallback;
}

/* ──────────────────────── SCAM RISK ────────────────────── */

function analyzeScamRisk(listing, marketValue) {
  const flags = [];
  const desc = `${listing.description || ''} ${listing.rawCardText || ''}`;
  const price = listing.price.value;

  if (price != null && marketValue?.estimate) {
    const ratio = price / marketValue.estimate;
    if (ratio < 0.45) flags.push('Price is dramatically below comparable listings');
    else if (ratio < 0.65) flags.push('Price is well below comparable listings');
  }
  if (!listing.description || listing.description.replace(/\s/g, '').length < 40) {
    flags.push('Description is empty or nearly empty');
  }
  if (/\b(shipping|ship it|deliver(y)? only|freight)\b/i.test(desc) && /\bdeposit\b/i.test(desc)) {
    flags.push('Shipping plus deposit arrangement mentioned');
  }
  if (/\bdeposit\b.*\b(before|prior to)\b.*\b(see|view|look)/i.test(desc)) {
    flags.push('Deposit requested before viewing');
  }
  if (/\b(zelle|cashapp|cash app|venmo|wire transfer|gift card|western union)\b/i.test(desc)) {
    flags.push('Specific non-reversible payment method requested up front');
  }
  if (/\bcan'?t meet\b|\bunable to meet\b|\bout of (town|state|country)\b/i.test(desc)) {
    flags.push('Seller indicates they cannot meet in person');
  }
  if (/\burgent|must go today|first come first served|asap\b/i.test(desc)) {
    flags.push('Unusual urgency language');
  }
  if ((listing.images || []).length === 1) {
    flags.push('Only one photo available');
  }
  if (listing.year.value && listing.mileage.value != null) {
    const age = Math.max(1, new Date().getFullYear() - listing.year.value);
    const perYear = listing.mileage.value / age;
    if (perYear > 20000) flags.push('Stated mileage is unusually high for the model year');
    if (listing.mileage.value < 100 && age > 2) flags.push('Stated mileage is implausibly low for the model year');
  }

  let level = 'LOW';
  if (flags.length >= 4) level = 'HIGH';
  else if (flags.length >= 2) level = 'MEDIUM';

  const questions = [
    'Do you have the title in hand, and is it in your name?',
    'Can I see the VIN and a photo of the title?',
    'Why are you selling it, and what maintenance has been done?',
    'Has it ever been dropped, crashed, or tracked?',
    'Can we meet somewhere public and can I start it cold?',
  ];
  if (flags.some(f => /below comparable/i.test(f))) questions.unshift('The price is well below similar bikes. Is there anything wrong with it I should know about?');
  if (!listing.mileage.value) questions.unshift('What is the exact current mileage?');

  return {
    level,
    // Deliberately framed as risk, not accusation.
    reason: flags.length ? `${flags.length} risk signal(s) present` : 'No notable risk signals found',
    flags,
    questions: questions.slice(0, 6),
  };
}

module.exports = {
  analyzeTitle, analyzeMods, analyzePhotos, analyzePhotosFromText,
  analyzeScamRisk, PHOTO_CHECKLIST,
};
