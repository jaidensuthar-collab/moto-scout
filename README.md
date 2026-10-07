# Moto Scout

Hourly Facebook Marketplace scout for five specific motorcycles, driving **your
already-logged-in Opera session**. No Facebook password is ever stored, typed,
or requested anywhere in this system.

---

## 1. Architecture

```
            ┌──────────────────────────────┐
            │  n8n  (local, 127.0.0.1:5678)│
            │  Schedule ▸ every 1 hour     │
            └───────────────┬──────────────┘
                            │  HTTP + X-Scout-Key
                            ▼
            ┌──────────────────────────────┐
            │  moto-scout helper           │
            │  Express on 127.0.0.1:8477   │
            │                              │
            │  pipeline.js  staged filter  │
            │  marketplace.js  FB driver   │
            │  analyze / scoring / dedupe  │
            └───┬───────────────┬──────────┘
                │ CDP :9222     │
                ▼               ▼
    ┌────────────────────┐  ┌──────────────────┐
    │  YOUR Opera        │  │  SQLite          │
    │  already logged in │  │  data/scout.db   │
    │  to Facebook       │  │  source of truth │
    └────────────────────┘  └────────┬─────────┘
                                     │ rebuilt each run
                                     ▼
                            ┌──────────────────┐
                            │  Google Sheets   │
                            │  (view layer)    │
                            └──────────────────┘
```

### Why these choices

**Raw CDP, not Playwright/Puppeteer.** Playwright's `connectOverCDP()` attaches to
*every* target in the browser. On a daily-driver Opera with 20+ tabs that times
out, and one hung renderer kills the whole connection — I hit exactly that while
building this. Talking to a single page target over a WebSocket is far more
reliable, needs no native dependency, and never downloads its own browser.

**Your existing session, not a fresh login.** Browserless or a clean Playwright
profile would need Facebook credentials and would trip login challenges
constantly. Attaching to the browser you already use means **zero credential
handling** and a session Facebook already trusts.

**HTTP helper, not n8n's Execute Command.** The browser connection and DB handle
stay warm between runs, n8n's HTTP node gives retries/timeouts/error branches for
free, Execute Command is unavailable in several n8n setups, and every stage
becomes independently testable with `curl`.

**SQLite is the source of truth; Sheets is a view.** Price history, repost
detection and liveness checks need row identity and transactions. Sheets is a
poor database but a great dashboard — so every tab is *regenerated* from SQLite
each run. A failed Sheets write can never lose data, and you can sort/filter/
colour the tabs by hand without breaking anything.

### Staged filtering (the cost control)

| Stage | What | Cost |
|---|---|---|
| 1 | Scrape search cards | free |
| 2 | Cheap gate: model / year / price / part-detection | free — kills ~95% |
| 3 | Open survivors, extract full detail | one page load each |
| 4 | Photos, market value, scoring, dedupe | may call a vision model |

A run that scans 300 cards typically opens fewer than 10 listings.

---

## 2. Install

```bash
cd ~/Projects/moto-scout

# Node 22 (n8n and this helper both want 20+)
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22

# better-sqlite3 compiles natively; macOS Python 3.13+ removed distutils,
# so point node-gyp at the system Python that still has it.
export npm_config_python=/usr/bin/python3

npm install
cp .env.example .env
chmod 600 .env

# Generate the shared secret and paste it into SCOUT_API_KEY in .env
openssl rand -hex 24

node src/selfcheck.js     # tells you exactly what is not ready yet
```

**Opera must be launched from `~/Applications/Opera.app`** — that wrapper passes
`--remote-debugging-port=9222`. Launching the raw binary silently disables CDP and
the helper cannot attach. (Drag that wrapper to your Dock and delete the other icon.)

Start the helper:

```bash
npm start          # respects TEST_MODE in .env
```

---

## 3. Google Sheets setup

1. Create a blank spreadsheet. Copy its ID from the URL
   (`docs.google.com/spreadsheets/d/<THIS_PART>/edit`) into `SHEET_ID` in `.env`.
2. Google Cloud Console → create a **service account** → create a **JSON key**.
3. Save that JSON **outside this repo**:
   ```bash
   mkdir -p ~/.config/moto-scout
   mv ~/Downloads/<key>.json ~/.config/moto-scout/google-sa.json
   chmod 600 ~/.config/moto-scout/google-sa.json
   ```
4. Open the JSON, copy `client_email`, and **share the spreadsheet with that
   address as Editor**. This is the step everyone forgets — without it you get a
   403 and nothing else explains why.
5. `npm run init-sheets` — creates every tab with headers.

**Tabs created automatically:** Master Listings · Price History · Logs (in
TEST_MODE each gets a ` _TEST` suffix so production views are untouched).
Master Listings is fully materialised from SQLite every sync — no formulas,
safe to overwrite.

**Brand tabs are different and NOT code-owned.** As of 2026-10-05 the sheet
also has one tab per brand (Kawasaki, Yamaha, CFMoto, Honda) that Jaiden built
by hand: each is a single live `FILTER`/`SORT` formula in cell A2 reading off
Master Listings, not pasted values. `syncAll()` never writes to them — doing
so would clear the formula. Add a new brand's tab the same way (copy an
existing tab's A2 formula and swap the `REGEXMATCH` brand name) and it starts
updating itself immediately; nothing in this codebase needs to know it exists
except `POST /sheets/colorize`, which re-applies the Deal Score / Risk color
scale to it (see below).

**Color scale:** `POST /sheets/colorize` puts a red→green gradient on Deal
Score and LOW/MEDIUM/HIGH badges on Scam Risk, on Master Listings and every
brand tab. Not run automatically on every sync (conditional-format rules are
a standing sheet property, not something to regenerate hourly) — call it once,
or again after adding a new brand tab by hand. Idempotent: clears its own
rules before re-adding them, so re-running never stacks duplicates.

---

## 4. Import into n8n

Already done for you if the canvas shows *Moto Scout — Facebook Marketplace (hourly)*.
To re-import: workflow menu **⋯ → Import from File →**
`~/Projects/moto-scout/n8n/moto-scout.workflow.json`

Then create the credential the HTTP nodes need:

1. n8n → **Credentials → New → Header Auth**
2. Name: `Moto Scout Helper`
3. **Name:** `X-Scout-Key`  **Value:** the `SCOUT_API_KEY` from your `.env`
4. Open each of the four HTTP Request nodes and select that credential.

First run: click **Execute workflow** manually. Only click **Publish** (which
arms the hourly schedule) once a manual run looks right.

---

## 5. Test mode

`TEST_MODE=true` (the default) means:

- **No Facebook saves** — double-gated with `ENABLE_FACEBOOK_SAVE`
- Writes to `_TEST` sheet tabs only
- Opens at most **3** listings per run instead of 25
- Everything logged

A search typically turns up a few hundred gate-passing candidates, far more than
the open budget, so candidates are **ordered before opening**: never-seen
listings first, then known ones oldest-check-first. Without that ordering a run
burns every slot re-checking listings it already has and reports
`newListings: 0` while new bikes sit unopened. The oldest-first tail also
re-extracts records whose fields predate a parser fix. `stats.candidates`,
`stats.candidatesUnseen` and `stats.openBudget` are returned on every run so a
low `opened` count is explainable rather than looking like a failure.

Go live by setting `TEST_MODE=false` **and** `ENABLE_FACEBOOK_SAVE=true`, then
restarting the helper.

---

## 6. Testing each piece independently

```bash
node src/selfcheck.js                     # every dependency and connection

curl localhost:8477/health                # helper + browser reachability
curl -H "X-Scout-Key: $KEY" localhost:8477/facebook/status   # session alive?

node src/cli.js search austin "ninja 400" # search + which cards pass the gate
node src/cli.js listing <listingUrl>      # raw extraction from one listing
node src/cli.js analyze <listingUrl>      # full scoring, no DB write
node src/cli.js sweep 3                   # staged run, 3 listings
node src/cli.js removed 5                 # sold/removed detection
node src/cli.js sheets                    # rebuild all tabs
node src/cli.js dump                      # everything in the local DB
```

`cli.js search` prints a PASS/skip verdict **and the reason** for every card, which
is the fastest way to see why something you expected was filtered out.

---

## 6b. Sweep tuning (what makes a run fast, and why)

A sweep is 2 cities x 6 queries = 12 searches, then up to 25 listing opens.
These are the levers, in order of how much they matter:

- **`SEARCH_CITIES` / `SEARCH_RADIUS_MILES`** (default `austin,sanantonio` @ 100).
  Five cities at 80 mi was mostly overlap and pulled in statewide results
  that only got rejected on distance. Two centroids at 100 mi cover the same
  acceptance region in 12 searches instead of 30.
- **Card-level distance prefilter.** The search card names the city; the
  gazetteer resolves it. Anything over the near-match limit is rejected before
  it costs one of the 25 opens. In one audit 39 of 70 rejects were this.
- **Scroll early-stop.** Scrolling stops after two scrolls add no new cards
  instead of always doing six. Measured: a search went from ~24 s of fixed
  waits to ~9-10 s including scrolling.
- **`SEARCH_SORT=alternate`.** Facebook caps a search at ~66 cards no matter
  how far you scroll, so *which* 66 matters. Even hours search newest-first
  (every fresh posting is seen), odd hours use relevance (older never-seen
  listings get a turn). `newest` or `relevance` pins it.
- **Never-seen-first open ordering**, then known listings oldest-check-first,
  so the open budget goes to new bikes and stale records get repaired.
- **Politeness delays** (`DELAY_*`) are deliberately NOT a lever. Lowering
  them is how accounts get restricted.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `browser: UNREACHABLE` | Opera not launched from `~/Applications/Opera.app`. Quit fully (⌘Q) and relaunch from there. |
| `blocked: logged_out` | Log back into Facebook in Opera by hand. The helper never does this. |
| `blocked: captcha` / `temp_blocked` | **Stop.** The run aborts on purpose. Leave it alone for several hours and raise the delay values in `.env`. Retrying a block is how accounts get restricted. |
| `radius_did_not_apply` | Facebook resets the radius on every search, and the dialog may already be open. `setRadius()` handles both — if it regresses, run `cli.js search` and read the `radius` object it prints. |
| Sheets 403 | The spreadsheet isn't shared with the service account's `client_email` as Editor. |
| `better-sqlite3` build fails | `export npm_config_python=/usr/bin/python3` then `npm install` again. Python 3.13+ removed `distutils`. |
| Selectors stop working | Facebook changed its DOM. `src/marketplace.js` is the only file with selectors; each one has a comment explaining what it defends against. |
| Workflow times out | `/run` can take minutes. Node 5's timeout is already 900 000 ms; lower `MAX_LISTINGS_PER_RUN` if needed. |
| A run hangs for many minutes writing nothing | Traced once to a blocked JS dialog (`confirm()`/`beforeunload`) freezing the tab's renderer, which froze every CDP eval silently — no exception, no error log, just a very slow `navigate()`. `cdp.js` now auto-dismisses dialogs on sight and bounds every `navigate()` call to ~30s regardless. `MAX_SWEEP_MINUTES` (default 22) is also a hard backstop on the whole run, independent of the root cause — if a future sweep still runs long for any reason, it returns what it found instead of hanging. Keep the n8n HTTP Request node's own timeout on `/run` comfortably above this (30+ min) — a tighter node timeout aborts the n8n side while the server keeps working regardless. |
| Sold/removed listings never leave the sheet | `checkRemoved()` iterates `db.activeIds()` -- that query must be `ORDER BY last_checked ASC`. Without it the same first 15 rows were re-checked every hour and nothing past row 15 ever was. `selfcheck` asserts this. |
| Sweep opens far-away listings | The city on the search card should reject them before opening (`cheapGate` distance prefilter). If a city is missing from `geo.js`'s gazetteer it passes through and is rejected after opening instead -- add the city. |
| Vision calls cost too much | `MAX_VISION_CALLS_PER_RUN` caps it. Leave `AI_PROVIDER` empty to disable entirely. |
| Duplicate rows | Can't happen — `listing_id` is the primary key and repeats become updates. Reposts under a *new* URL are flagged, not merged, unless confidence ≥ 0.80. |

---

## 8. Where every secret lives

| Secret | Location | Never |
|---|---|---|
| Facebook session | Your Opera profile, untouched by this code | Never stored or transmitted by moto-scout |
| `SCOUT_API_KEY` | `.env` (chmod 600) + n8n Header Auth credential | Not in any source file |
| Google service account | `~/.config/moto-scout/google-sa.json` (chmod 600), outside the repo | Not in `.env`, not in git |
| AI API key | `.env` only | Not in the workflow JSON |

`.env` is gitignored. `.env.example` contains no real values.

---

## 9. Future notifications (currently off)

Node **10. NOTIFICATION GATE — DISABLED** already receives the full payload a
notifier would need:

```json
{ "notable": [ { "model","year","price","mileage","distance",
                 "score","label","matchType","scamRisk","url",
                 "pros":[],"cons":[] } ] }
```

To enable: set `ENABLE_NOTIFICATIONS=true`, then connect that node's output to a
Discord / Telegram / Gmail / Twilio node. Nothing upstream changes.

**Seller messaging is deliberately not implemented.** `/message-seller` returns
501. Contacting a seller is an irreversible outward action and belongs behind an
explicit per-listing human approval step, never a schedule trigger.

---

## 10. Honest limitations

- **Photo analysis needs a vision model.** With `AI_PROVIDER` empty, the system
  analyses the listing **text** and says so explicitly in every row
  (`source: "text-heuristic"`). It does not pretend to have looked at pictures.
- **Market values are estimates.** Below 4 local comparables it falls back to a
  knowledge-base range adjusted for year and mileage. Every value is labelled.
- **Distance is city-level**, multiplied by 1.22 for road circuity. Your exact
  address is never used or stored.
- **Scraping Facebook is against their Terms of Service.** Running this carries
  some risk to your account. The delays, caps and fail-safe blocking exist to
  keep that risk low, but it is not zero — that's your call to make knowingly.
- **Ninja 500 / RS 457 / CFMoto 450 are 2023+ models.** Expect few or no matches
  under $4,100. Empty results for those are the market, not a bug.
