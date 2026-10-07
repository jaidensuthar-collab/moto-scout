'use strict';
/**
 * Distance. Two independent numbers are kept:
 *   1. marketplaceDistance — whatever Facebook printed
 *   2. calculatedDistance  — our own figure from the listing's city
 * When they disagree materially we flag it rather than silently picking one.
 *
 * We deliberately geocode to CITY level only. The reference point is the
 * Steiner Ranch area centroid, not a street address, and no exact home address
 * is ever stored or transmitted.
 */
const cfg = require('./config');

/** Offline gazetteer of the Central Texas cities Marketplace actually returns.
 *  Offline on purpose: no API key, no rate limit, no outbound call per listing. */
const CITIES = {
  'austin, tx': [30.2672, -97.7431],          'round rock, tx': [30.5083, -97.6789],
  'cedar park, tx': [30.5052, -97.8203],      'leander, tx': [30.5788, -97.8531],
  'georgetown, tx': [30.6333, -97.6778],      'pflugerville, tx': [30.4394, -97.6200],
  'hutto, tx': [30.5427, -97.5467],           'taylor, tx': [30.5705, -97.4094],
  'kyle, tx': [29.9892, -97.8772],            'buda, tx': [30.0855, -97.8403],
  'san marcos, tx': [29.8833, -97.9414],      'new braunfels, tx': [29.7030, -98.1245],
  'seguin, tx': [29.5688, -97.9647],          'san antonio, tx': [29.4241, -98.4936],
  'schertz, tx': [29.5522, -98.2697],         'converse, tx': [29.5180, -98.3161],
  'universal city, tx': [29.5480, -98.2908],  'boerne, tx': [29.7947, -98.7320],
  'canyon lake, tx': [29.8766, -98.2622],
  'dripping springs, tx': [30.1902, -98.0867],'lakeway, tx': [30.3646, -97.9797],
  'spicewood, tx': [30.4752, -98.1586],       'wimberley, tx': [29.9974, -98.0989],
  'marble falls, tx': [30.5782, -98.2728],    'burnet, tx': [30.7582, -98.2283],
  'johnson city, tx': [30.2766, -98.4111],    'blanco, tx': [30.0974, -98.4211],
  'fredericksburg, tx': [30.2752, -98.8720],  'bastrop, tx': [30.1105, -97.3153],
  'elgin, tx': [30.3496, -97.3706],           'smithville, tx': [30.0088, -97.1591],
  'la grange, tx': [29.9052, -96.8769],       'giddings, tx': [30.1824, -96.9372],
  'lockhart, tx': [29.8844, -97.6700],        'luling, tx': [29.6816, -97.6478],
  'gonzales, tx': [29.5016, -97.4522],        'killeen, tx': [31.1171, -97.7278],
  'temple, tx': [31.0982, -97.3428],          'belton, tx': [31.0563, -97.4647],
  'harker heights, tx': [31.0785, -97.6594],  'copperas cove, tx': [31.1246, -97.9031],
  'lampasas, tx': [31.0638, -98.1817],        'salado, tx': [30.9471, -97.5372],
  'jarrell, tx': [30.8249, -97.6039],         'florence, tx': [30.8402, -97.7978],
  'granite shoals, tx': [30.5905, -98.3772],  'horseshoe bay, tx': [30.5346, -98.3714],
  'caldwell, tx': [30.5305, -96.6964],        'brenham, tx': [30.1669, -96.3977],
  'cameron, tx': [30.8541, -96.9761],         'rockdale, tx': [30.6549, -97.0014],
  'waco, tx': [31.5493, -97.1467],            'houston, tx': [29.7604, -95.3698],
  'dallas, tx': [32.7767, -96.7970],          'fort worth, tx': [32.7555, -97.3308],
  'katy, tx': [29.7858, -95.8245],            'college station, tx': [30.6280, -96.3344],
  'corpus christi, tx': [27.8006, -97.3964],  'laredo, tx': [27.5306, -99.4803],
  // Far cities that showed up when the Marketplace radius filter failed to
  // apply. Having them here means the DISTANCE check still rejects them even
  // when Facebook hands back statewide results -- a deliberate safety net so a
  // flaky UI filter cannot leak 200-mile listings into the match tabs.
  'cypress, tx': [29.9691, -95.6972],         'aledo, tx': [32.6957, -97.6028],
  'burleson, tx': [32.5421, -97.3209],        'spring, tx': [30.0799, -95.4172],
  'sugar land, tx': [29.6197, -95.6349],      'rosenberg, tx': [29.5572, -95.8085],
  'galveston, tx': [29.3013, -94.7977],       'lufkin, tx': [31.3382, -94.7291],
  'grand prairie, tx': [32.7459, -96.9978],   'mckinney, tx': [33.1972, -96.6397],
  'celina, tx': [33.3248, -96.7847],          'plano, tx': [33.0198, -96.6989],
  'frisco, tx': [33.1507, -96.8236],          'arlington, tx': [32.7357, -97.1081],
  'denton, tx': [33.2148, -97.1331],          'hockley, tx': [30.0305, -95.8438],
  'weimar, tx': [29.7025, -96.7814],
  'harlingen, tx': [26.1906, -97.6961],       'cleveland, tx': [30.3416, -95.0855],
  'rogers, tx': [30.9335, -97.2283],          'euless, tx': [32.8371, -97.0820],
  'the hills, tx': [30.3616, -97.9627],       'irving, tx': [32.8140, -96.9489],
  'balch springs, tx': [32.7287, -96.6228],   'garland, tx': [32.9126, -96.6389],
  'little elm, tx': [33.1626, -96.9375],      'abilene, tx': [32.4487, -99.7331],
  'sandia, tx': [27.9939, -97.8744],          'grand prairie, tx2': [32.7459, -96.9978],
  'burkeville, tx': [31.0010, -93.6577],
  'victoria, tx': [28.8053, -97.0036],        'manor, tx': [30.3402, -97.5569],
  'granbury, tx': [32.4421, -97.7942],        'huntsville, tx': [30.7235, -95.5508],
  'conroe, tx': [30.3119, -95.4561],          'bryan, tx': [30.6744, -96.3700],
  'pipe creek, tx': [29.7016, -98.9361],      'hamilton, tx': [31.7032, -98.1234],
  'franklin, tx': [31.0266, -96.4852],        'axtell, tx': [31.6774, -96.9472],
  'fort hood, tx': [31.1350, -97.7769],       'nolanville, tx': [31.0802, -97.6042],
  'marion, tx': [29.5705, -98.1403],          'dale, tx': [29.8896, -97.5750],
  'pleasanton, tx': [28.9672, -98.4786],      'beeville, tx': [28.4008, -97.7483],
  'boerne park, tx': [29.7947, -98.7320],     'riomedina, tx': [29.4452, -98.8872],
  'mansfield, tx': [32.5632, -97.1417],       'weatherford, tx': [32.7593, -97.7972],
  'league city, tx': [29.5075, -95.0949],     'temple heights, tx': [31.0982, -97.3428],
  // Houston and DFW suburbs. Added when the generic (car) profile let Humble /
  // Porter / Tomball through the card-level distance prefilter: an unknown
  // city passes on purpose, and these were unknown. Cars are listed across a
  // far wider area than Central Texas motorcycles, so the net is wider now.
  'humble, tx': [29.9988, -95.2622],          'porter, tx': [30.1044, -95.2363],
  'tomball, tx': [30.0972, -95.6161],         'kingwood, tx': [30.0536, -95.1858],
  'the woodlands, tx': [30.1658, -95.4613],   'magnolia, tx': [30.2094, -95.7508],
  'pearland, tx': [29.5636, -95.2860],        'pasadena, tx': [29.6911, -95.2091],
  'baytown, tx': [29.7355, -94.9774],         'friendswood, tx': [29.5294, -95.2010],
  'missouri city, tx': [29.6186, -95.5377],   'stafford, tx': [29.6161, -95.5577],
  'channelview, tx': [29.7761, -95.1146],     'deer park, tx': [29.7052, -95.1238],
  'la porte, tx': [29.6658, -95.0194],        'humble heights, tx': [29.9988, -95.2622],
  'mesquite, tx': [32.7668, -96.5992],        'carrollton, tx': [32.9756, -96.8900],
  'lewisville, tx': [33.0462, -96.9942],      'allen, tx': [33.1032, -96.6706],
  'richardson, tx': [32.9483, -96.7299],      'rowlett, tx': [32.9029, -96.5639],
  'waxahachie, tx': [32.3865, -96.8483],      'keller, tx': [32.9346, -97.2514],
  'southlake, tx': [32.9412, -97.1342],       'grapevine, tx': [32.9343, -97.0781],
  'flower mound, tx': [33.0146, -97.0970],    'cedar hill, tx': [32.5885, -96.9561],
  'desoto, tx': [32.5896, -96.8570],          'duncanville, tx': [32.6518, -96.9083],
  'rockwall, tx': [32.9312, -96.4597],        'wylie, tx': [33.0151, -96.5389],
  'north richland hills, tx': [32.8343, -97.2289], 'haltom city, tx': [32.7996, -97.2692],
  'beaumont, tx': [30.0802, -94.1266],        'tyler, tx': [32.3513, -95.3011],
  'midland, tx': [31.9974, -102.0779],        'odessa, tx': [31.8457, -102.3676],
  'lubbock, tx': [33.5779, -101.8552],        'amarillo, tx': [35.2220, -101.8313],
  'el paso, tx': [31.7619, -106.4850],        'mcallen, tx': [26.2034, -98.2300],
  'brownsville, tx': [25.9017, -97.4975],     'edinburg, tx': [26.3017, -98.1633],
};

const R_MILES = 3958.8;
const toRad = d => (d * Math.PI) / 180;

/** Great-circle distance in miles. */
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Straight-line distance understates driving distance. 1.22 is a standard
 * Texas-grid circuity factor and is applied so thresholds mean road miles.
 */
const CIRCUITY = 1.22;

function lookupCity(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  if (CITIES[key]) return CITIES[key];
  const city = key.split(',')[0].trim();
  for (const [k, v] of Object.entries(CITIES)) if (k.split(',')[0].trim() === city) return v;
  return null;
}

/**
 * Returns { calculated, marketplace, used, confidence, mismatch, note }.
 * `used` is the figure thresholds are applied against: the more conservative
 * (larger) of the two when both exist, so we never let a listing in on an
 * optimistic number.
 */
function distanceFor(listing) {
  const mkt = listing.marketplaceDistance?.value ?? null;
  const coords = lookupCity(listing.location?.value);
  let calculated = null;
  if (coords) {
    calculated = Math.round(haversine(cfg.home.lat, cfg.home.lon, coords[0], coords[1]) * CIRCUITY);
  }

  let used = null, confidence = 'unknown', note = null, mismatch = false;
  if (calculated != null && mkt != null) {
    used = Math.max(calculated, mkt);
    confidence = 'stated+calculated';
    if (Math.abs(calculated - mkt) > Math.max(15, 0.35 * Math.max(calculated, mkt))) {
      mismatch = true;
      note = `Marketplace says ${mkt} mi but ${listing.location.value} computes to ~${calculated} mi`;
    }
  } else if (calculated != null) {
    used = calculated; confidence = 'calculated';
    note = `Estimated from city "${listing.location.value}", not a street address`;
  } else if (mkt != null) {
    used = mkt; confidence = 'marketplace-only';
    note = 'City not in gazetteer; using Marketplace distance';
  } else {
    note = 'No location or distance available';
  }

  return { calculated, marketplace: mkt, used, confidence, mismatch, note };
}

module.exports = { distanceFor, haversine, lookupCity, CITIES, CIRCUITY };
