// Search quality + latency bench against the LIVE web.
//
//   node --env-file-if-exists=.env scripts/searchBench.js
//
// Runs real debate claims through the engine and prints the evidence it would
// hand the judge, plus per-stage latency. This is how we tune ranking: read the
// passages and ask "would this settle the claim?" — the same question the judge
// is asked. Works with zero API keys (Wikipedia only); add BRAVE_API_KEY,
// SEARXNG_URL or Google CSE for full web coverage.
import { createSearchEngine } from '../src/search/engine.js';
import { createOwnSearchProvider } from '../src/providers/search/own.js';
import { config } from '../src/config.js';

const CLAIMS = process.argv.slice(2).length
  ? [process.argv.slice(2).join(' ')]
  : [
      'The Great Wall of China is visible from the Moon.',
      'Global electric vehicle sales tripled between 2020 and 2023.',
      'Electric vehicles emit more carbon dioxide than gasoline cars over their lifetime.',
      'In Norway, roughly eighty percent of new cars sold are already electric.',
      'Unemployment is at its lowest level in history.',
    ];

function bar(ms) {
  return '█'.repeat(Math.min(40, Math.round(ms / 100)));
}

async function main() {
  const provider = createOwnSearchProvider({ config });
  console.log(`\nSearch bench — backends: ${provider.backends.join(', ') || '(none configured!)'}`);
  console.log(`deadline=${config.searchDeadlineMs}ms  fetch=${config.searchFetchDeadlineMs}ms  candidates=${config.searchMaxCandidates}  fetchTop=${config.searchMaxFetch}\n`);

  const timings = [];
  for (const claim of CLAIMS) {
    const started = Date.now();
    let results = [];
    try {
      results = await provider.search(claim, { maxResults: 4 });
    } catch (err) {
      console.log(`✖ ${claim}\n   error: ${err.message}\n`);
      continue;
    }
    const ms = Date.now() - started;
    timings.push(ms);

    console.log(`\x1b[1m${claim}\x1b[0m`);
    console.log(`  ${ms}ms ${bar(ms)}  ${results.length} passages`);
    if (!results.length) console.log('  (no evidence — judge would return UNVERIFIED)');
    for (const r of results.slice(0, 3)) {
      const when = r.publishedAt ? new Date(r.publishedAt).toISOString().slice(0, 10) : 'undated';
      console.log(`   • [${r.domain}] ${when}  score=${r.score}`);
      console.log(`     ${r.snippet.replace(/\s+/g, ' ').slice(0, 190)}…`);
    }
    console.log('');
  }

  // Cache effectiveness: re-run the first claim.
  if (CLAIMS.length) {
    const t0 = Date.now();
    await provider.search(CLAIMS[0], { maxResults: 4 });
    console.log(`cache hit for claim #1: ${Date.now() - t0}ms`);
  }

  if (timings.length) {
    const sorted = [...timings].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted.at(-1);
    console.log(`\nlatency  p50=${p50}ms  worst=${worst}ms  budget=${config.searchDeadlineMs}ms`);
    console.log(worst <= config.searchDeadlineMs ? '✔ inside the deadline' : '✖ exceeded the deadline');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
