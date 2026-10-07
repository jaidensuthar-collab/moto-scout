'use strict';
/**
 * CLI for testing each stage in isolation, without n8n in the picture.
 *   node src/cli.js search austin "yamaha r3"
 *   node src/cli.js listing https://www.facebook.com/marketplace/item/123/
 *   node src/cli.js analyze https://www.facebook.com/marketplace/item/123/
 *   node src/cli.js sweep [limit]
 *   node src/cli.js removed
 *   node src/cli.js sheets
 *   node src/cli.js dump
 */
const cfg = require('./config');
const mp = require('./marketplace');
const parse = require('./parse');
const pipeline = require('./pipeline');
const db = require('./db');

const [, , cmd, ...args] = process.argv;
const pretty = o => console.log(JSON.stringify(o, null, 2));

(async () => {
  switch (cmd) {
    case 'search': {
      const [city = 'austin', ...q] = args;
      const query = q.join(' ') || 'yamaha r3';
      const page = await mp.getPage();
      const r = await mp.search(page, { city, query, radius: 80 });
      console.log(`city=${city} query="${query}" radius=${JSON.stringify(r.radius)}`);
      console.log(`cards=${r.cards.length} blocked=${r.blocked} empty=${!!r.emptyResults}`);
      r.cards.slice(0, 25).forEach((c, i) => {
        const g = pipeline.cheapGate(c);
        console.log(`${String(i).padStart(3)} [${g.pass ? 'PASS' : 'skip'}] ${c.raw.slice(0, 78)}`);
        if (!g.pass) console.log(`      ↳ ${g.why}`);
      });
      page.close();
      break;
    }
    case 'listing': {
      const page = await mp.getPage();
      pretty(await mp.openListing(page, args[0]));
      page.close();
      break;
    }
    case 'analyze': {
      const page = await mp.getPage();
      const detail = await mp.openListing(page, args[0]);
      page.close();
      const listing = parse.normalize({ url: args[0], raw: detail.head || '' }, detail);
      const a = await pipeline.analyzeListing(listing, { used: 0 });
      pretty({ listing, record: pipeline.toRecord(listing, a) });
      break;
    }
    case 'sweep': {
      const out = await pipeline.runSweep({ limit: args[0] ? Number(args[0]) : undefined });
      pretty(out.stats);
      console.log(`\n${out.records.length} record(s):`);
      out.records.forEach(r =>
        console.log(` ${r.matchType.padEnd(14)} score ${String(r.dealScore).padStart(4)}  $${r.price}  ${r.year} ${r.model}  ${r.location}`));
      break;
    }
    case 'removed': pretty(await pipeline.checkRemoved({ max: Number(args[0]) || 10 })); break;
    case 'sheets':  pretty(await require('./sheets').syncAll()); break;
    case 'dump': {
      const rows = db.allListings();
      console.log(`${rows.length} listing(s) in ${cfg.dbPath}`);
      rows.forEach(r => console.log(
        ` ${(r.match_type || '?').padEnd(14)} ${String(r.deal_score ?? '').padStart(4)}  $${String(r.price ?? '?').padStart(5)}  ` +
        `${r.year ?? '????'} ${(r.model || '?').padEnd(20)} ${r.status}  ${r.url}`));
      break;
    }
    default:
      console.log(`moto-scout CLI

  search <city> <query>   run one search, show which cards pass the cheap gate
  listing <url>           open one listing, dump raw extraction
  analyze <url>           full analysis of one listing (no DB write)
  sweep [limit]           full staged run (writes to DB)
  removed [max]           re-check active listings for sold/removed
  sheets                  rebuild all Google Sheets tabs from the DB
  dump                    print everything in the local DB

TEST_MODE is currently ${cfg.testMode}`);
  }
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
