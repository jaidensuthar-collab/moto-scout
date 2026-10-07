'use strict';
/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Why raw CDP instead of Playwright/Puppeteer:
 *   Playwright's connectOverCDP() attaches to EVERY target in the browser. On a
 *   real daily-driver Opera with 20+ tabs that routinely times out, and one hung
 *   renderer takes the whole connection down. Talking to a single page target
 *   over a WebSocket is dramatically more reliable here, has no native
 *   dependency, and never needs its own browser download.
 *
 * Hard-won behaviours baked in:
 *   - Input events need a focused renderer: a backgrounded tab silently swallows
 *     Input.dispatchKeyEvent (it returns success and nothing is typed). The old
 *     fix was Page.bringToFront(), which yanks the user's window to this tab.
 *     Emulation.setFocusEmulationEnabled achieves the same thing WITHOUT
 *     fronting, so bringToFront() is now opt-in only (page.allowFocus = true)
 *     and nothing on the scheduled-sweep path ever sets it.
 *   - insertText() for bulk text (fast, reliable); typeKeys() when a framework
 *     needs genuine per-key events to mark a field dirty.
 *   - Every send() is bounded by a timeout so a hung renderer can't wedge a run.
 */
const http = require('http');
const { URL } = require('url');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 8000 },
      res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('CDP HTTP timeout')); });
    req.on('error', reject);
  });
}

class Page {
  constructor(wsUrl, meta = {}) {
    this.meta = meta;
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    // OFF by default. Only a human-driven flow may front a tab; the hourly
    // sweep must never pull the user out of what they are doing.
    this.allowFocus = false;
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP websocket open timeout')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP websocket error')); });
    });
    this.ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
    this.ws.addEventListener('close', () => { this.closed = true; });

    // Auto-dismiss any JS dialog (confirm/alert/beforeunload). A dialog blocks
    // the page's main thread, which blocks Runtime.evaluate -- every eval()
    // call sits waiting for the dialog instead of failing, and each one only
    // gives up at its OWN timeout. This was traced as the likely cause of a
    // sweep that burned 52 minutes without writing a single record: Facebook
    // or Opera surfacing one unexpected dialog turns every subsequent probe
    // into a near-full-timeout wait, and a 20-16 retry loop (see navigate())
    // compounds that into minutes per call. Dismissing on sight prevents it
    // regardless of what triggers the dialog.
    // Chained after `ready`, not sent immediately: this.ws is freshly
    // constructed above and its handshake has not completed yet, so a send()
    // here would hit the socket while it is still CONNECTING. That throws
    // synchronously inside send()'s try/catch, rejects, and was being
    // silently swallowed -- Page.enable never actually ran, the dialog
    // listener below never received anything, and auto-dismiss silently did
    // nothing. Caught live: a simulated confirm() still blocked eval() for
    // the full timeout even with this handler "installed".
    this.ready.then(() => this.send('Page.enable')).catch(() => {});
    this.ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      }
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('CDP page closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); return reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, timeoutMs);
    });
  }

  /** Evaluate a function or expression string in the page, returned by value. */
  async eval(fnOrExpr, timeoutMs = 20000) {
    const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})()` : fnOrExpr;
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
      throw new Error('eval: ' + String(d).slice(0, 300));
    }
    return r.result.value;
  }

  /** Front this tab. Refuses unless explicitly permitted -- see allowFocus. */
  async bringToFront() {
    if (!this.allowFocus) return false;
    try { await this.send('Page.bringToFront', {}, 8000); return true; } catch { return false; }
  }

  /**
   * Make input events land without stealing the window.
   *
   * Focus emulation tells the renderer it is focused and visible, which is all
   * Input.dispatch* actually requires. We (re)assert it before input rather
   * than once at setup because it is per-target and does not survive a target
   * being recreated.
   */
  async ensureInputFocus() {
    if (this.allowFocus) return this.bringToFront();
    try { await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 6000); }
    catch { /* unsupported browser: input may no-op, caller sees the failure */ }
    return false;
  }

  /**
   * Navigate and WAIT FOR THE NEW PAGE.
   *
   * The naive version — set location.href, then poll until body text is long
   * enough — is silently broken on a single-page app: the OLD document already
   * satisfies the length check, so it returns instantly and every extraction
   * reads the PREVIOUS listing. That produced 15 different motorcycles all
   * reporting the same 863 miles before it was caught.
   *
   * So we wait on two things that actually change: the URL becoming the target,
   * and the body text differing from what was there before.
   *
   * TIMEOUT BUDGET is deliberate and bounded two ways, not one:
   *   - Each poll uses a SHORT eval timeout (pollTimeout), not eval()'s 20s
   *     default. We are already retrying every `settle` ms regardless, so a
   *     probe that takes seconds to answer is not worth waiting out at full
   *     length -- cut losses and poll again.
   *   - An explicit wall-clock deadline caps the WHOLE call independent of
   *     `tries`. Without it, `tries * (settle + eval timeout)` is the real
   *     ceiling, and at the old 20s-per-probe default that is 16 * ~21s =
   *     ~5.6 minutes for ONE navigate(). A sweep makes dozens of these, and a
   *     renderer that stays unresponsive (observed cause: a blocked JS
   *     dialog -- see the Page.javascriptDialogOpening handler above) turned
   *     that into a sweep that ran 52 minutes and wrote nothing.
   */
  async navigate(url, { waitChars = 1500, tries = 16, settle = 1200, pollTimeout = 4000, deadlineMs = 30000 } = {}) {
    const key = (url.match(/\/marketplace\/item\/(\d+)/) || [])[1] || null;
    const deadline = Date.now() + deadlineMs;
    const before = await this.eval(
      `(()=>document.body?document.body.innerText.slice(0,400):'')()`, pollTimeout
    ).catch(() => '');

    // Deliberately NOT caught: a genuinely dead connection rejects this
    // instantly (closed sockets reject with no wait at all, see send()), and
    // that fast failure should propagate to the caller rather than be padded
    // out to the full deadline below.
    await this.eval(`location.href=${JSON.stringify(url)}`, pollTimeout);

    for (let i = 0; i < tries; i++) {
      if (Date.now() >= deadline) return false;
      await sleep(settle);
      const st = await this.eval(`(()=>JSON.stringify({
        u: location.href,
        n: document.body ? document.body.innerText.length : 0,
        head: document.body ? document.body.innerText.slice(0,400) : ''
      }))()`, pollTimeout).catch(() => null);
      if (!st) continue;
      const { u, n, head } = JSON.parse(st);

      // URL must actually be where we asked to go.
      const urlOk = key ? u.includes(key) : u.includes(url.split('?')[0].slice(-40));
      if (!urlOk) continue;

      // ...and the content must have actually changed over.
      if (n >= waitChars && head !== before) return true;
      // Same text but correct URL can mean a genuinely identical page; accept
      // after a couple of confirmations rather than spinning forever.
      if (n >= waitChars && i >= 3) return true;
    }
    return false;   // caller decides: empty results vs genuine failure
  }

  async click(x, y, settleMs = 700) {
    await this.ensureInputFocus();
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(120);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(90);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(settleMs);
  }

  /** Fast bulk text entry. Fires real input events; good for search boxes. */
  async insertText(text) {
    await this.ensureInputFocus();
    await this.send('Input.insertText', { text });
  }

  /** Genuine per-key events. Needed when a framework only marks a field dirty
   *  on real keydown/keyup (some validation-gated forms ignore insertText). */
  async typeKeys(text, delay = 9) {
    await this.ensureInputFocus();
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
      await sleep(delay);
    }
  }

  async scrollBy(dy, times = 1, pause = 1600) {
    for (let i = 0; i < times; i++) {
      await this.eval(`window.scrollBy(0, ${dy})`);
      await sleep(pause);
    }
  }

  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000);
    return Buffer.from(r.data, 'base64');
  }

  close() { try { this.ws.close(); } catch {} this.closed = true; }
}

/** List page targets in the attached browser. */
async function listTargets(cdpUrl) {
  const all = await httpJson(cdpUrl.replace(/\/$/, '') + '/json/list');
  return all.filter(t => t.type === 'page');
}

/** Attach to the first page whose URL matches. */
async function openPage(cdpUrl, matcher) {
  const targets = await listTargets(cdpUrl);
  const t = targets.find(x => matcher(x.url || ''));
  if (!t) return null;
  const p = new Page(t.webSocketDebuggerUrl, { url: t.url, id: t.id });
  await p.ready;
  await p.send('Runtime.enable');
  return p;
}

/**
 * Create a tab WITHOUT bringing it to the foreground.
 *
 * The HTTP /json/new endpoint always fronts the new tab, which visibly yanks
 * you out of whatever you were doing. Target.createTarget over the browser
 * WebSocket accepts `background: true`, so the tab is created behind your
 * current one and you never see it appear.
 *
 * Falls back to /json/new if the browser rejects the background flag.
 */
async function newPage(cdpUrl, url, { background = true } = {}) {
  const ver = await browserVersion(cdpUrl);
  if (ver.webSocketDebuggerUrl) {
    try {
      const made = await browserCommand(ver.webSocketDebuggerUrl, 'Target.createTarget',
        { url, background });
      const targets = await listTargets(cdpUrl);
      const t = targets.find(x => x.id === made.targetId);
      if (t) {
        const p = new Page(t.webSocketDebuggerUrl, { url: t.url, id: t.id });
        await p.ready;
        await p.send('Runtime.enable');
        return p;
      }
    } catch { /* fall through to the HTTP route */ }
  }

  const u = cdpUrl.replace(/\/$/, '') + '/json/new?' + url;
  const made = await new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: 'PUT', timeout: 10000 },
      res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }
    );
    req.on('timeout', () => req.destroy(new Error('newPage timeout')));
    req.on('error', reject);
    req.end();
  });
  const p = new Page(made.webSocketDebuggerUrl, { url: made.url, id: made.id });
  await p.ready;
  await p.send('Runtime.enable');
  return p;
}

/** One-shot command against the BROWSER endpoint (not a page target). */
function browserCommand(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('browserCommand timeout')); }, 10000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      clearTimeout(t); try { ws.close(); } catch {}
      m.error ? reject(new Error(m.error.message || 'browserCommand failed')) : resolve(m.result);
    });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('browserCommand ws error')); });
  });
}

async function closeTarget(cdpUrl, id) {
  try { await httpJson(cdpUrl.replace(/\/$/, '') + '/json/close/' + id); } catch {}
}

async function browserVersion(cdpUrl) {
  return httpJson(cdpUrl.replace(/\/$/, '') + '/json/version');
}

module.exports = { Page, listTargets, openPage, newPage, closeTarget, browserVersion, browserCommand, sleep };
