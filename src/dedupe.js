'use strict';
/**
 * Duplicate and repost detection.
 *
 * Two distinct cases:
 *   1. SAME listing id  → not a duplicate at all, just an update. Handled by the
 *      DB upsert; the row is updated in place and never appended.
 *   2. REPOST → seller deleted and relisted, so Facebook issued a NEW id/URL for
 *      the same physical motorcycle. That is what this file is for.
 *
 * We never auto-merge on a weak signal. Below the high-confidence bar the pair
 * is flagged "Possible repost" and left for a human to judge.
 */
const crypto = require('crypto');

/** Stable-ish fingerprint of the image set. Facebook rewrites CDN query strings
 *  constantly, so we hash only the stable path portion of each URL. */
function imageSignature(images = []) {
  const parts = images
    .map(u => { try { return new URL(u).pathname.split('/').pop().split('.')[0]; } catch { return null; } })
    .filter(Boolean)
    .sort()
    .slice(0, 8);
  if (!parts.length) return null;
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** Cheap token-overlap similarity (Jaccard). Good enough for copy-paste reposts. */
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const norm = s => new Set(
    String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  );
  const A = norm(a), B = norm(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Score a candidate pair 0..1.
 * Weighted so that image identity and an exact seller+spec match dominate;
 * price alone is deliberately weak because prices drift on reposts.
 */
function repostConfidence(listing, cand) {
  let score = 0;
  const why = [];

  if (listing.imageSignature && cand.image_signature && listing.imageSignature === cand.image_signature) {
    score += 0.55; why.push('identical image set');
  }
  if (listing.sellerName && cand.seller_name &&
      listing.sellerName.toLowerCase() === String(cand.seller_name).toLowerCase()) {
    score += 0.15; why.push('same seller name');
  }
  if (listing.year && cand.year && listing.year === cand.year) { score += 0.08; why.push('same year'); }
  if (listing.mileage != null && cand.mileage != null) {
    const diff = Math.abs(listing.mileage - cand.mileage);
    if (diff === 0) { score += 0.12; why.push('identical mileage'); }
    else if (diff <= 300) { score += 0.07; why.push('mileage within 300 mi'); }
  }
  if (listing.city && cand.city && listing.city === cand.city) { score += 0.07; why.push('same city'); }

  const sim = textSimilarity(listing.description, cand.description);
  if (sim > 0.75) { score += 0.2; why.push(`description ${Math.round(sim * 100)}% similar`); }
  else if (sim > 0.5) { score += 0.1; why.push(`description ${Math.round(sim * 100)}% similar`); }

  if (listing.price != null && cand.price != null) {
    const d = Math.abs(listing.price - cand.price);
    if (d === 0) { score += 0.05; why.push('same price'); }
    else if (d <= 300) { score += 0.02; }
  }

  return { confidence: Math.min(1, Math.round(score * 100) / 100), signals: why };
}

/**
 * @returns {status, of, confidence, signals}
 *   status: 'Unique' | 'Possible repost' | 'Repost'
 * Only >= 0.80 is treated as a confirmed repost.
 */
function detectRepost(listing, candidates) {
  let best = null;
  for (const c of candidates) {
    const r = repostConfidence(listing, c);
    if (!best || r.confidence > best.confidence) best = { ...r, of: c.listing_id };
  }
  if (!best || best.confidence < 0.45) {
    return { status: 'Unique', of: null, confidence: best ? best.confidence : 0, signals: [] };
  }
  return {
    status: best.confidence >= 0.80 ? 'Repost' : 'Possible repost',
    of: best.of,
    confidence: best.confidence,
    signals: best.signals,
  };
}

module.exports = { imageSignature, textSimilarity, repostConfidence, detectRepost };
