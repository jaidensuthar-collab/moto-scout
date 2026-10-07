'use strict';
/**
 * Facebook Marketplace driver.
 *
 * Every selector and dialog flow in here was derived by driving the real site,
 * not guessed. The notes explain *why* each odd-looking workaround exists so
 * that when Facebook changes something you know what the code was defending
 * against.
 */
const cfg = require('./config');
const { openPage, newPage, listTargets, sleep } = require('./cdp');

const FB = 'https://www.facebook.com';

/** Random-ish wait so we don't hit Facebook on a metronome. */
function politeDelay(base) {
  return sleep(base + Math.floor(Math.random() * cfg.delays.jitter));
}

/**
 * Get the scout's OWN tab.
 *
 * Previously this grabbed whatever Facebook tab you had open and navigated it
 * around under you. Now the scout keeps a dedicated background tab, tagged via
 * a sentinel on window, so your browsing is never hijacked. It is created once
 * and reused across runs.
 *
 * Nothing here touches credentials; the tab inherits your existing session
 * cookies exactly like any other tab in the same profile.
 */
const SCOUT_TAG = '__motoScoutTab';

/**
 * Set window.__motoScoutTab on the CURRENT page. Must be called after every
 * real navigation, not just once at tab creation.
 *
 * A full navigation (page.navigate() setting location.href to a new listing
 * or search URL -- not an in-page SPA route change) reloads the JS context
 * and wipes every window.* property, the tag included. getPage() is called
 * once per run, so within a single sweep this is harmless -- the same `page`
 * connection is reused throughout. But across separate runs (the hourly n8n
 * schedule, hitting the same long-lived helper process) the tab's last
 * navigation was to some listing URL, the tag is already gone by the time
 * the NEXT run calls getPage(), and it can't find a tagged tab to reattach
 * to -- so it creates a brand new one. Found by auditing Opera's own tab
 * count: 13 Facebook tabs open, not one of them tagged. Left unfixed, this
 * would mean roughly one new tab accumulating per hour forever, not just
 * during manual testing.
 */
async function tagPage(page) {
  await page.eval(`(()=>{window.${SCOUT_TAG}=true;})()`, 6000).catch(() => {});
}

async function getPage() {
  const { listTargets, openPage } = require('./cdp');
  const targets = await listTargets(cfg.cdpUrl);

  // Re-attach to our own tab if it is still around.
  for (const t of targets) {
    if (!(t.url || '').includes('facebook.com')) continue;
    try {
      const cand = await openPage(cfg.cdpUrl, u => u === t.url);
      if (!cand) continue;
      // Short timeout deliberately. The default 20s made a tab that was mid-
      // navigation when probed look untagged (its own navigate() poll was
      // occupying the renderer), which spawned a NEW scout tab instead of
      // reattaching -- Opera went from 21 to 28 open tabs in one session
      // before this was caught. A busy tab answering a trivial window.* read
      // slowly is itself a signal something is off; don't wait it out.
      const tagged = await cand.eval(`(()=>!!window.${SCOUT_TAG})()`, 4000).catch(() => false);
      if (tagged) {
        // Focus emulation is per-target and does not survive a reconnect, so it
        // must be re-asserted every time we reattach -- otherwise a reused tab
        // silently falls back to throttled background behaviour.
        await enableQuietMode(cand);
        return cand;
      }
      cand.close();
    } catch {}
  }

  // Otherwise open a fresh background tab and tag it.
  const page = await newPage(cfg.cdpUrl, FB + '/marketplace/');
  await sleep(3500);
  await tagPage(page);
  await enableQuietMode(page);
  return page;
}

/**
 * QUIET MODE -- the whole reason this scout can run while you work.
 *
 * A genuinely backgrounded tab is throttled: Facebook's infinite scroll is
 * driven by IntersectionObserver, which never fires when the document is
 * hidden. Measured: a hidden tab stalls at scrollY 447 and 31 cards no matter
 * how many times you scroll, and forcing a 12000px viewport does not help
 * because visibility, not layout, is the gate.
 *
 * Emulation.setFocusEmulationEnabled makes the RENDERER believe the page is
 * focused and visible while the tab stays behind whatever you are actually
 * looking at. Same measurement with it on: 68 cards, scrollY 8690.
 *
 * So: full results, zero focus stealing. This is what replaced every
 * Page.bringToFront() call in the search path.
 */
async function enableQuietMode(page) {
  try {
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return true;
  } catch {
    // Older browsers lack it; we still work, just with fewer cards per search.
    return false;
  }
}

/**
 * Detect the states where we must stop rather than retry.
 * Hammering a blocked session is how accounts get restricted.
 */
async function detectBlock(page) {
  // Bounded, but less aggressively than the other reads on this page: a
  // timeout here maps to blocked:true below, which makes runSweep() abort
  // the ENTIRE run (see search()/openListing() callers) -- too short a
  // timeout trades a real bug (an unbounded 20s default multiplied across
  // ~30 search iterations under a degraded connection, observed adding
  // 10+ minutes to one real run) for a worse one (false-positive aborts on
  // ordinary page-load variance). 8s is generous enough to absorb normal
  // slowness while still being 2.5x tighter than the old default.
  const s = await page.eval(`(()=>{
    var u = location.href;
    var t = (document.body ? document.body.innerText : '').slice(0, 4000);
    return JSON.stringify({ url: u, text: t });
  })()`, 8000).catch(() => null);
  if (!s) return { blocked: true, reason: 'page_unreadable' };
  const { url, text } = JSON.parse(s);

  if (/\/checkpoint\//i.test(url))                         return { blocked: true, reason: 'checkpoint' };
  if (/\/login|login\.php/i.test(url))                     return { blocked: true, reason: 'logged_out' };
  if (/log in to continue|log into facebook/i.test(text))  return { blocked: true, reason: 'logged_out' };
  if (/temporarily blocked|you're temporarily/i.test(text))return { blocked: true, reason: 'temp_blocked' };
  if (/confirm your identity|security check|captcha/i.test(text)) return { blocked: true, reason: 'captcha' };
  if (/suspicious activity/i.test(text))                   return { blocked: true, reason: 'suspicious_activity' };
  return { blocked: false };
}

/**
 * Set the Marketplace search radius.
 *
 * Facebook RESETS this to the account default on every search navigation, so it
 * has to be re-applied per search, not once per run.
 *
 * The control's label ("Austin, Texas  ·  Within 40 mi") is split across nested
 * spans, so a leaf-node text scan finds nothing. We instead take the SMALLEST
 * element whose full textContent contains "Within" — that lands on the real
 * clickable span.
 */
/**
 * RETIRED. The radius is now set by URL (`radius` in KILOMETRES, see cfg.url).
 *
 * The old implementation clicked through Facebook's location dialog, which was
 * timing-sensitive, intermittently failed, and required synthetic mouse clicks
 * that stole window focus. Kept as a shim so callers and tests do not break.
 */
async function setRadius(page, miles = 80) {
  const shown = await page.eval(`(()=>{
    var m=document.body.innerText.match(/Within\\s*(\\d+)\\s*mi/);
    return m ? Number(m[1]) : null;
  })()`, 5000).catch(() => null);
  return { ok: shown === miles, viaUrl: true, shows: shown == null ? null : shown + ' mi' };
}

/** Scrape the listing cards currently rendered on a search page. */
async function scrapeCards(page) {
  const raw = await page.eval(`(()=>{
    var out=[], seen={};
    document.querySelectorAll('a[href*="/marketplace/item/"]').forEach(function(a){
      var href=a.href.split('?')[0];
      if(seen[href]) return; seen[href]=1;
      var txt=(a.innerText||'').replace(/\\n+/g,' | ').trim();
      if(!txt) return;
      var img=a.querySelector('img');
      out.push({ url:href, raw:txt.slice(0,220), thumb: img?img.src:null });
    });
    return JSON.stringify(out);
  })()`, 6000);
  return JSON.parse(raw || '[]');
}

/**
 * Run one search. Returns {cards, blocked, emptyResults}.
 *
 * NOTE on "empty": a zero-result Marketplace search still renders ~1.1k chars of
 * chrome (filters, categories). Treating "short page" as a load failure made an
 * earlier version report false errors — genuinely empty results are normal and
 * are reported as emptyResults, not as a failure.
 */
async function search(page, { city, query, maxPrice = cfg.searchMaxPrice, radius = 80, scrolls = 6, sortBy, daysSinceListed }) {
  // Radius travels in the URL now -- no dialog, no clicks, no focus stealing.
  const url = cfg.url.search({ city, query, maxPrice, radiusMiles: radius, sortBy, daysSinceListed });
  await page.navigate(url, { waitChars: 900 });
  await tagPage(page); // re-tag: the navigation above just wiped it, see tagPage()'s own comment

  const blk = await detectBlock(page);
  if (blk.blocked) return { cards: [], blocked: true, reason: blk.reason };

  const rad = await setRadius(page, radius);   // verification only
  await sleep(1500);

  // Scrolling uses window.scrollBy via eval, not wheel events, so a background
  // tab loads more results without ever being fronted. Stop early once two
  // consecutive scrolls add no new cards -- a sparse search (most of them)
  // exhausts its results in 1-2 scrolls, and blindly doing all six cost
  // ~10s per search of scrolling into nothing.
  let cards = [];
  let stale = 0;
  for (let i = 0; i < scrolls; i++) {
    await page.scrollBy(2600, 1, 1400 + Math.random() * 900);
    const now = await scrapeCards(page);
    stale = now.length > cards.length ? 0 : stale + 1;
    cards = now;
    if (stale >= 2) break;
  }
  const bodyLen = await page.eval(`(()=>document.body?document.body.innerText.length:0)()`, 5000).catch(() => 0);
  return {
    cards,
    blocked: false,
    emptyResults: cards.length === 0 && bodyLen > 400,
    radius: rad,
    url,
    city, query,
  };
}

/** Open one listing and pull every field Facebook exposes. */
async function openListing(page, url) {
  await page.navigate(url, { waitChars: 900 });
  await tagPage(page); // re-tag: the navigation above just wiped it, see tagPage()'s own comment
  const blk = await detectBlock(page);
  if (blk.blocked) return { url, blocked: true, reason: blk.reason };

  // Separate from detectBlock() on purpose: that function means "our SESSION
  // is in trouble, stop the whole run" (checkpoint, logged out, captcha) and
  // runSweep() treats it that way -- aborting the sweep entirely. A single
  // dead listing is not that. Facebook redirects a removed/sold/expired item
  // to its own marketplace homepage with this exact query param; two
  // listings were found still stored as Active/Near Match weeks after they
  // redirected here, because nothing ever checked for it -- they just kept
  // getting silently skipped as "unreadable" on every re-check.
  const curUrl = await page.eval('location.href', 5000).catch(() => '');
  if (/[?&]unavailable_product=1\b/.test(curUrl)) return { url, gone: true, reason: 'unavailable_product' };

  const raw = await page.eval(`(()=>{
    var body = document.body ? document.body.innerText : '';
    // Description heading differs by listing template. Generic items use
    // "Details"; vehicle-category listings (the "Driven X miles / Manual
    // transmission" structured block every motorcycle posting has) use
    // "Seller's description" instead and have NO "Details" heading at all.
    // Checking only "Details" meant every vehicle-template listing's
    // description silently came back empty -- caught when a listing titled
    // "2023 Yamaha YZF-R" with an empty description got stored as a
    // confirmed Yamaha R3 match; its real description (only found once this
    // heading was added) was someone parting out an R7 frame piece by piece.
    var heading = 'Details';
    var a = body.indexOf(heading);
    if (a < 0) { heading = "Seller's description"; a = body.indexOf(heading); }
    var b = body.indexOf('Seller information');
    var desc = (a >= 0 && b > a) ? body.slice(a + heading.length, b) : '';
    var head = body.slice(Math.max(0, a - 400), a);

    // "About this vehicle" is Facebook's own structured facts block --
    // "Driven X miles", "Manual transmission", exterior color -- sitting
    // directly before the description heading. parse.js deliberately does
    // NOT read 'head' for mileage/model (head also contains nav chrome and
    // the retained search box query, which caused real contamination bugs),
    // but that meant this reliable, structured mileage figure was being
    // thrown out along with the chrome it shares a slice with. Pulled out
    // on its own so it survives that exclusion.
    var av = body.indexOf('About this vehicle');
    var aboutVehicle = (av >= 0 && a > av) ? body.slice(av, a) : '';

    // Images: the listing gallery. Filter out tiny avatars/sprites.
    var imgs = [];
    document.querySelectorAll('img').forEach(function(im){
      var w = im.naturalWidth || im.width || 0;
      if (w < 240) return;
      if (im.src && imgs.indexOf(im.src) < 0) imgs.push(im.src);
    });

    // Seller block: name + any "Joined Facebook in YYYY" / rating text.
    var seller = '';
    if (b >= 0) seller = body.slice(b, b + 420);

    return JSON.stringify({
      bodyLen: body.length,
      head: head.replace(/\\n{2,}/g,'\\n').trim(),
      desc: desc.replace(/\\n{2,}/g,'\\n').trim(),
      aboutVehicle: aboutVehicle.replace(/\\n{2,}/g,'\\n').trim(),
      seller: seller.replace(/\\n{2,}/g,'\\n').trim(),
      images: imgs.slice(0, 12),
      title: document.title || ''
    });
  })()`, 10000);

  const d = JSON.parse(raw || '{}');
  return { url, blocked: false, ...d };
}

/**
 * Click Facebook's Save button on the currently open listing.
 * Gated by both TEST_MODE and ENABLE_FACEBOOK_SAVE — two independent switches,
 * because an accidental mass-save is annoying to undo by hand.
 */
async function saveListing(page) {
  if (cfg.testMode) return { saved: false, reason: 'test_mode' };
  if (!cfg.enableFacebookSave) return { saved: false, reason: 'saving_disabled' };

  const btn = JSON.parse(await page.eval(`(()=>{
    var best=null;
    document.querySelectorAll('[role=button],button,[aria-label]').forEach(function(e){
      var lab=((e.getAttribute('aria-label')||'')+' '+(e.innerText||'')).trim();
      if(!/^save$|save to|^saved$/i.test(lab.trim())) return;
      var b=e.getBoundingClientRect(); if(b.width<=0) return;
      if(!best) best={x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),lab:lab.slice(0,30)};
    });
    return JSON.stringify(best);
  })()`, 6000) || 'null');

  if (!btn) return { saved: false, reason: 'save_button_not_found' };
  if (/saved/i.test(btn.lab)) return { saved: true, already: true };
  await page.click(btn.x, btn.y, 2200);
  return { saved: true };
}

module.exports = { getPage, search, openListing, saveListing, setRadius, detectBlock, politeDelay, scrapeCards, enableQuietMode };
