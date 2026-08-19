// Search engine tests. Everything runs offline: a local HTTP server plays the
// role of the web, and fake backends play the role of the retrievers, so the
// full pipeline (plan -> fuse -> fetch -> extract -> rank) is exercised
// deterministically and we can assert real quality outcomes, not just wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { planQueries } from '../src/search/queryPlanner.js';
import { rrfFuse, capPerDomain } from '../src/search/fusion.js';
import { extractArticle, normalizeDate } from '../src/search/extract.js';
import { chunkPassages, evidenceDate, rankPassages, recencyFactor } from '../src/search/rank.js';
import { canonicalUrl, dedupeKey, domainAuthority, extractEntities, extractNumbers, fold } from '../src/search/text.js';
import { createSearchEngine } from '../src/search/engine.js';
import { createRateLimiter, QuotaSkip } from '../src/search/rateLimiter.js';
import { createBraveBackend, _resetBraveLimiterForTests } from '../src/search/backends/brave.js';
import { createExaBackend } from '../src/search/backends/exa.js';
import { cacheKey, _clearMemoryCache } from '../src/search/cache.js';
import { _resetStoreForTests } from '../src/state/store.js';
import { createMemoryStore } from '../src/state/memoryStore.js';
import { config } from '../src/config.js';

// ---------------------------------------------------------------- primitives

test('canonical URLs collapse the same page seen different ways', () => {
  const a = canonicalUrl('https://www.Example.com/path/?utm_source=x&b=2&a=1#frag');
  assert.equal(a, 'https://example.com/path?a=1&b=2', 'tracking params, case, www, slash and fragment normalized');
  assert.equal(canonicalUrl('https://example.com/'), 'https://example.com/');
  // Protocol is preserved so the URL stays fetchable...
  assert.equal(canonicalUrl('http://example.com/p'), 'http://example.com/p');
  // ...but http and https are one document for deduplication.
  assert.equal(dedupeKey('http://www.example.com/path/'), dedupeKey('https://example.com/path'));
});

test('domain authority ranks primary sources above blogs', () => {
  assert.ok(domainAuthority('bls.gov') > domainAuthority('reuters.com'));
  assert.ok(domainAuthority('reuters.com') > domainAuthority('someguy.medium.com'));
  assert.ok(domainAuthority('iea.org') > domainAuthority('randomsite.net'));
});

test('claim primitives pull out what a factual claim turns on', () => {
  const claim = 'Global EV sales tripled between 2020 and 2023, according to the International Energy Agency.';
  assert.deepEqual(extractNumbers('80 percent and 14 million in 2023'), ['80', '14', '2023']);
  const entities = extractEntities(claim).map((e) => e.toLowerCase());
  assert.ok(entities.some((e) => e.includes('international energy agency')));
  assert.equal(fold('emissions'), 'emission');
});

// ------------------------------------------------------------- query planner

test('query planner compresses a rambling claim and hunts contradictions', () => {
  const plan = planQueries(
    'I believe electric vehicles actually emit more carbon dioxide than gasoline cars over their lifetime, once you count the battery.',
    { maxQueries: 3 },
  );
  const intents = plan.queries.map((q) => q.intent);
  assert.ok(intents.includes('core'));
  assert.ok(intents.includes('contradiction'), 'always looks for counter-evidence');
  assert.ok(!plan.queries[0].q.includes('i believe'), 'hedging filler stripped');
  assert.ok(/emissions data|comparison data/.test(plan.queries.find((q) => q.intent === 'evidence')?.q || ''));
  assert.ok(plan.queries.every((q) => q.q.length <= 200));
});

test('query planner flags time-sensitive claims for recency weighting', () => {
  assert.equal(planQueries('Unemployment is at its lowest level in history.').timeSensitive, true);
  assert.equal(planQueries('Water boils at 100 degrees celsius at sea level.').timeSensitive, false);
  assert.deepEqual(planQueries('EV sales tripled between 2020 and 2023.').years, ['2020', '2023']);
});

// -------------------------------------------------------------------- fusion

test('reciprocal rank fusion rewards cross-backend agreement', () => {
  const fused = rrfFuse([
    { backend: 'brave', results: [{ title: 'A', url: 'https://a.com/1' }, { title: 'B', url: 'https://b.com/2' }] },
    { backend: 'wikipedia', results: [{ title: 'B', url: 'https://b.com/2' }, { title: 'C', url: 'https://c.com/3' }] },
  ]);
  assert.equal(fused[0].url, 'https://b.com/2', 'found by both backends wins');
  assert.deepEqual(fused[0].backends.sort(), ['brave', 'wikipedia']);
});

test('per-domain cap keeps the evidence set diverse', () => {
  const capped = capPerDomain(
    [
      { url: 'https://x.com/1', domain: 'x.com' },
      { url: 'https://x.com/2', domain: 'x.com' },
      { url: 'https://x.com/3', domain: 'x.com' },
      { url: 'https://y.com/1', domain: 'y.com' },
    ],
    2,
  );
  assert.equal(capped.filter((r) => r.domain === 'x.com').length, 2);
  assert.equal(capped.length, 3);
});

// ------------------------------------------------------------------ extractor

const ARTICLE_HTML = `<!doctype html><html><head>
<title>Site — EV lifecycle emissions</title>
<meta property="og:title" content="EV lifecycle emissions explained" />
<meta property="article:published_time" content="2024-03-11T09:00:00Z" />
<meta property="og:site_name" content="ICCT" />
<link rel="canonical" href="https://theicct.org/report" />
</head><body>
<nav><a href="/a">Home</a><a href="/b">About</a><a href="/c">Contact</a></nav>
<script>var tracker = 'should never appear';</script>
<style>.x{color:red}</style>
<article>
<p>Lifecycle studies find that battery electric cars emit 60-70% less carbon dioxide than comparable gasoline cars over their lifetime, including battery manufacturing.</p>
<p>The gap widens as electricity grids decarbonize, and holds in every major market studied.</p>
</article>
<footer><a href="/x">Privacy</a><a href="/y">Terms</a></footer>
</body></html>`;

test('extractor keeps article prose and drops chrome, scripts and nav', () => {
  const article = extractArticle(ARTICLE_HTML, 'https://theicct.org/report?utm_source=x');
  assert.equal(article.title, 'EV lifecycle emissions explained');
  assert.equal(article.siteName, 'ICCT');
  assert.equal(article.canonical, 'https://theicct.org/report');
  assert.match(article.publishedAt, /^2024-03-11/);
  assert.match(article.text, /60-70% less carbon dioxide/);
  assert.ok(!/should never appear/.test(article.text), 'script contents excluded');
  assert.ok(!/Privacy|Terms|Home/.test(article.text), 'nav and footer links excluded');
});

test('extractor survives junk input', () => {
  assert.equal(extractArticle('', 'u').text, '');
  assert.equal(extractArticle(null).text, '');
  assert.equal(normalizeDate('not a date'), null);
  assert.equal(normalizeDate('1200-01-01'), null, 'implausible dates rejected');
});

// -------------------------------------------------------------------- ranking

test('passage chunking produces overlapping, sentence-aligned passages', () => {
  const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} with several additional words to add length.`).join(' ');
  const passages = chunkPassages(text, { targetWords: 30 });
  assert.ok(passages.length >= 3);
  assert.ok(passages.every((p) => p.split(/\s+/).length >= 8));
});

test('ranking surfaces the passage that actually settles the claim', () => {
  const claim = 'Electric vehicles emit more carbon dioxide than gasoline cars over their lifetime.';
  const plan = planQueries(claim);
  const docs = [
    {
      url: 'https://theicct.org/report',
      title: 'ICCT lifecycle analysis',
      domain: 'theicct.org',
      publishedAt: '2024-03-11T00:00:00Z',
      text:
        'Our newsletter covers transport policy across many regions and publishes updates every month for subscribers everywhere. ' +
        'Lifecycle studies find battery electric cars emit 60-70% less carbon dioxide than gasoline cars, including battery manufacturing emissions. ' +
        'Readers can subscribe to the mailing list for future editions and events.',
    },
    {
      url: 'https://randomblog.medium.com/post',
      title: 'My take on EVs',
      domain: 'randomblog.medium.com',
      publishedAt: '2019-01-01T00:00:00Z',
      text: 'I think electric cars are probably worse for the planet but I have not checked any of the numbers myself honestly.',
    },
  ];
  const ranked = rankPassages(docs, { claim, plan, maxPassages: 3 });
  assert.ok(ranked.length > 0);
  assert.match(ranked[0].text, /60-70% less carbon dioxide/, 'the decisive sentence ranks first');
  assert.equal(ranked[0].domain, 'theicct.org', 'authoritative source beats the blog');
});

test('recency only bites for time-sensitive claims', () => {
  const old = new Date(Date.now() - 8 * 365.25 * 24 * 3600 * 1000).toISOString();
  assert.ok(recencyFactor(old, true) < recencyFactor(old, false));
  assert.equal(recencyFactor(null, false), 1);
});

test('cache key ignores wording, not meaning', () => {
  const a = cacheKey('EV sales tripled between 2020 and 2023');
  const b = cacheKey('Between 2020 and 2023, EV sales tripled!');
  const c = cacheKey('The Great Wall is visible from the Moon');
  assert.equal(a, b, 'same claim, different phrasing -> same cache entry');
  assert.notEqual(a, c);
});

// --------------------------------------------------- end-to-end against a fake web

function pageFor(title, body, published) {
  return `<!doctype html><html><head><title>${title}</title>
  <meta property="article:published_time" content="${published}" />
  </head><body><nav><a href="/">Home</a></nav><article>${body}</article></body></html>`;
}

async function startFakeWeb() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/slow') {
      setTimeout(() => res.end('too late'), 5000); // never answers in budget
      return;
    }
    if (req.url === '/huge') {
      res.setHeader('content-type', 'text/html');
      res.end(pageFor('Huge', `<p>${'filler word '.repeat(200000)}</p>`, '2024-01-01'));
      return;
    }
    if (req.url === '/pdf') {
      res.setHeader('content-type', 'application/pdf');
      res.end('%PDF-1.4');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/nasa') {
      res.end(pageFor(
        'Great Wall from space',
        '<p>NASA confirms that the Great Wall of China is not visible from the Moon. No human structures are visible at that distance, and even from low Earth orbit the wall is extremely difficult to discern.</p>',
        '2023-06-01',
      ));
    } else if (req.url === '/blog') {
      res.end(pageFor(
        'My space blog',
        '<p>People often repeat that you can see the wall from the Moon and I have always wondered about that claim personally.</p>',
        '2015-01-01',
      ));
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

test('engine end-to-end: retrieves, fetches, extracts and ranks real evidence', async (t) => {
  _resetStoreForTests(createMemoryStore());
  _clearMemoryCache();
  const web = await startFakeWeb();
  t.after(async () => {
    await web.close();
    _resetStoreForTests(null);
  });

  const backends = [
    {
      name: 'fakeA',
      enabled: true,
      async search() {
        return [
          { title: 'NASA — Great Wall', url: `${web.base}/nasa`, snippet: 'NASA on visibility from space' },
          { title: 'Space blog', url: `${web.base}/blog`, snippet: 'a personal blog post' },
        ];
      },
    },
    {
      name: 'fakeB',
      enabled: true,
      async search() {
        return [
          { title: 'NASA — Great Wall', url: `${web.base}/nasa`, snippet: 'NASA on visibility' },
          { title: 'Missing page', url: `${web.base}/missing`, snippet: 'gone' },
        ];
      },
    },
  ];

  const engine = createSearchEngine({ config, backends });
  const started = Date.now();
  const results = await engine.search('The Great Wall of China is visible from the Moon.', { maxResults: 4 });
  const elapsed = Date.now() - started;

  assert.ok(results.length > 0, 'evidence returned');
  assert.match(results[0].snippet, /not visible from the Moon/, 'the decisive passage ranks first');
  assert.equal(results[0].url, `${web.base}/nasa`);
  assert.ok(results[0].publishedAt, 'publication date extracted for recency weighting');
  assert.ok(elapsed < config.searchDeadlineMs, `inside the deadline (${elapsed}ms)`);

  // Second identical search is served from cache — no further HTTP.
  const hitsBefore = web.hits.length;
  const cached = await engine.search('The Great Wall of China is visible from the Moon.', { maxResults: 4 });
  assert.deepEqual(cached, results);
  assert.equal(web.hits.length, hitsBefore, 'cache hit made zero requests');
});

test('engine degrades gracefully: slow pages, wrong content types, dead backends', async (t) => {
  _resetStoreForTests(createMemoryStore());
  _clearMemoryCache();
  const web = await startFakeWeb();
  t.after(async () => {
    await web.close();
    _resetStoreForTests(null);
  });

  const backends = [
    {
      name: 'brokenBackend',
      enabled: true,
      async search() {
        throw new Error('backend down');
      },
    },
    {
      name: 'okBackend',
      enabled: true,
      async search() {
        return [
          { title: 'Slow site', url: `${web.base}/slow`, snippet: 'this page never responds in time' },
          { title: 'A PDF', url: `${web.base}/pdf`, snippet: 'binary content, not html' },
          { title: 'NASA', url: `${web.base}/nasa`, snippet: 'NASA confirms it is not visible' },
        ];
      },
    },
  ];

  const engine = createSearchEngine({
    config: { ...config, searchFetchDeadlineMs: 900, searchDeadlineMs: 2500 },
    backends,
  });
  const started = Date.now();
  const results = await engine.search('Great Wall visible from the Moon', { maxResults: 4 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2500, `one dead backend and one hanging page do not stall the verdict (${elapsed}ms)`);
  assert.ok(results.length > 0, 'still produced evidence from the sources that worked');
  assert.ok(results.some((r) => /not visible/i.test(r.snippet)));
});

test('engine returns nothing rather than guessing when no backend answers', async (t) => {
  _resetStoreForTests(createMemoryStore());
  _clearMemoryCache();
  t.after(() => _resetStoreForTests(null));

  const engine = createSearchEngine({
    config,
    backends: [{ name: 'dead', enabled: true, async search() { throw new Error('nope'); } }],
  });
  const results = await engine.search('some claim nobody can check');
  assert.deepEqual(results, [], 'empty evidence -> the judge will return UNVERIFIED');
});

// ------------------------------------------------- quota metering (Brave)
//
// Brave is the primary general-web backend and its free tier is ~1 query/sec.
// The failure mode being guarded against is indirect: naive parallelism earns
// 429s, 429s look like backend failures, failures trip the circuit breaker, and
// a perfectly healthy backend goes dark for a whole cooldown window. So both
// the metering and the "a skip is not a failure" rule are load-bearing.

test('rate limiter hands out distinct slots to concurrent callers', () => {
  const limiter = createRateLimiter({ minIntervalMs: 1000 });
  // Slots are reserved synchronously, so callers racing on the same tick
  // cannot be handed the same instant.
  assert.equal(limiter.reserve(), 0, 'first caller goes immediately');
  assert.ok(Math.abs(limiter.reserve() - 1000) < 20, 'second waits one interval');
  assert.ok(Math.abs(limiter.reserve() - 2000) < 20, 'third waits two');
});

test('rate limiter tells a caller to skip rather than blow its deadline', async () => {
  const limiter = createRateLimiter({ minIntervalMs: 5000 });
  limiter.reserve(); // consume the immediate slot
  // The next slot lands 5s out, but this claim's verdict is due in 200ms.
  assert.equal(limiter.reserve({ deadlineAt: Date.now() + 200 }), null, 'reports skip');
  assert.equal(await limiter.acquire({ deadlineAt: Date.now() + 200 }), false);
});

test('rate limiter waits out its interval, and backs off further after a 429', async () => {
  const limiter = createRateLimiter({ minIntervalMs: 60 });
  const started = Date.now();
  assert.equal(await limiter.acquire({ deadlineAt: Date.now() + 5000 }), true);
  assert.equal(await limiter.acquire({ deadlineAt: Date.now() + 5000 }), true);
  assert.ok(Date.now() - started >= 55, 'second acquire waited for its slot');

  limiter.penalize(4000);
  assert.equal(limiter.reserve({ deadlineAt: Date.now() + 500 }), null, 'vendor backoff hint respected');
});

test('brave backend normalizes results and reports auth failure actionably', async () => {
  const cfg = { ...config, braveApiKey: 'test-key', searchUserAgent: 'test-agent' };
  let seenUrl = null;
  let seenHeaders = null;
  const ok = async (url, opts) => {
    seenUrl = url;
    seenHeaders = opts.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            {
              title: 'EV sales',
              url: 'https://iea.org/ev',
              description: 'Global EV sales <strong>tripled</strong>   since 2020.',
              page_age: '3 days ago',
            },
            { title: 'No date', url: 'https://example.com/x', description: 'Plain text.' },
          ],
        },
      }),
    };
  };

  // Inject a free-running limiter: this test is about parsing, not metering.
  const fast = createRateLimiter({ minIntervalMs: 1 });
  const backend = createBraveBackend(cfg, { fetchImpl: ok, limiter: fast });
  assert.equal(backend.enabled, true, 'enabled by the presence of a key');
  const results = await backend.search('global EV sales', { limit: 3, deadlineAt: Date.now() + 5000 });

  assert.equal(seenHeaders['X-Subscription-Token'], 'test-key');
  assert.equal(seenHeaders['user-agent'], 'test-agent', 'we identify ourselves honestly');
  assert.match(seenUrl, /q=global%20EV%20sales/);
  assert.equal(results.length, 2);
  assert.equal(results[0].snippet, 'Global EV sales tripled since 2020.', 'markup stripped, whitespace collapsed');
  // Relative ages become absolute so recency scoring can actually use them.
  const ageMs = Date.now() - new Date(results[0].publishedAt).getTime();
  assert.ok(ageMs > 2.5 * 864e5 && ageMs < 3.5 * 864e5, 'relative age resolved to about three days');
  assert.equal(results[1].publishedAt, null, 'a missing date stays null rather than being invented');

  const unauthorized = createBraveBackend(cfg, {
    limiter: fast,
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(
    () => unauthorized.search('x', { deadlineAt: Date.now() + 5000 }),
    /BRAVE_API_KEY/,
    'auth failure names the variable to fix',
  );
});

test('brave backend backs off on 429 and skips when out of quota', async () => {
  const cfg = { ...config, braveApiKey: 'test-key' };
  const limiter = createRateLimiter({ minIntervalMs: 10 });
  const throttled = createBraveBackend(cfg, {
    limiter,
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '3' } }),
  });

  await assert.rejects(() => throttled.search('x', { deadlineAt: Date.now() + 5000 }), /rate limited/);
  // The vendor's own retry-after hint now shapes our scheduling.
  assert.equal(limiter.reserve({ deadlineAt: Date.now() + 500 }), null, 'backed off by about three seconds');

  // With no slot available before the deadline, the backend declines instead
  // of stalling the claim.
  let called = false;
  const starved = createBraveBackend(cfg, {
    limiter,
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await assert.rejects(
    () => starved.search('x', { deadlineAt: Date.now() + 100 }),
    (err) => err.skip === true && err.name === 'QuotaSkip',
    'a starved backend raises a skip, not a failure',
  );
  assert.equal(called, false, 'and never spends the HTTP request');
});

test('engine spends Brave quota only on the highest-value query', async () => {
  _clearMemoryCache();
  const asked = { brave: [], wikipedia: [] };
  const mk = (name, extra = {}) => ({
    name,
    enabled: true,
    ...extra,
    async search(q) {
      asked[name].push(q);
      return [{ title: `${name} result`, url: `https://${name}.example/${asked[name].length}`, snippet: 'x' }];
    },
  });
  // maxQueries of 1 is what the real Brave backend declares on the free tier.
  const engine = createSearchEngine({
    config: { ...config, searchesPerClaim: 3 },
    backends: [mk('brave', { maxQueries: 1 }), mk('wikipedia')],
    fetchImpl: async () => {
      throw new Error('no network in this test');
    },
  });
  await engine.search('Global EV sales tripled between 2020 and 2023 according to the IEA.', { useCache: false });

  assert.equal(asked.brave.length, 1, 'the metered backend spends exactly one query');
  assert.ok(asked.wikipedia.length > 1, 'the keyless backend still runs the full plan');
  assert.equal(asked.brave[0], asked.wikipedia[0], 'and it gets the core query, not a speculative one');
});

test('a quota skip does not trip the circuit breaker, but real failures do', async () => {
  _clearMemoryCache();
  const backends = [
    {
      name: 'brave',
      enabled: true,
      search: async () => {
        throw new QuotaSkip('brave: no rate-limit slot before deadline');
      },
    },
    {
      name: 'broken',
      enabled: true,
      search: async () => {
        throw new Error('HTTP 500');
      },
    },
  ];
  const engine = createSearchEngine({
    config: { ...config, searchesPerClaim: 1 },
    backends,
    fetchImpl: async () => {
      throw new Error('no network in this test');
    },
  });

  for (let i = 0; i < 3; i += 1) {
    await engine.search(`unrelated claim number ${i} about something`, { useCache: false });
  }

  const state = engine.breakerState();
  assert.ok(!state.brave?.openUntil, 'skipping for quota never penalizes a healthy backend');
  assert.ok(state.broken?.openUntil > Date.now(), 'a genuinely failing backend is switched off');
});

test('Brave quota is metered per process, not per session', async () => {
  // Engines are built per debate session, but the quota belongs to the account.
  // Two sessions' backends must therefore draw on one meter.
  _resetBraveLimiterForTests();
  const cfg = { ...config, braveApiKey: 'test-key', braveQps: 1 };
  const sessionA = createBraveBackend(cfg, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const sessionB = createBraveBackend(cfg, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });

  await sessionA.search('claim one', { deadlineAt: Date.now() + 5000 });
  // Session B now has no slot inside a tight deadline, because session A just
  // spent it. With a per-engine limiter both would have fired at once.
  await assert.rejects(
    () => sessionB.search('claim two', { deadlineAt: Date.now() + 100 }),
    (err) => err.skip === true,
    'the second session sees what the first session already spent',
  );
  _resetBraveLimiterForTests();
});

// ------------------------------------------------------- evidence currency
//
// Regression cover for a defect found by benchmarking, not by testing: living
// documents report their CREATION date as datePublished. Wikipedia's
// "Unemployment" article advertises 2001 while carrying current figures, so
// judging its age by that date penalized the freshest sources hardest — and a
// page with no date at all scored better than one we parsed correctly.

test('a body <time> is content, not a publication date', () => {
  // The date in this table belongs to the subject matter. Reading it as the
  // page date is how an article about 2016 ends up stamped 2012.
  const html = `<html><head><title>Unemployment</title></head><body>
    <article><p>${'Employment statistics and analysis. '.repeat(12)}</p>
    <table><tr><td><time datetime="2012-06-16">16 June 2012</time></td><td>4.1%</td></tr></table>
    </article></body></html>`;
  const article = extractArticle(html, 'https://example.org/unemployment');
  assert.equal(article.publishedAt, null, 'a date inside the content is not claimed as the page date');
});

test('extractor reads when a living document was last updated', () => {
  const html = `<html><head><title>Unemployment</title>
    <script type="application/ld+json">
      {"datePublished":"2001-03-19T19:13:03Z","dateModified":"2026-08-10T16:45:16Z"}
    </script></head>
    <body><article><p>${'Current unemployment figures and analysis. '.repeat(12)}</p></article></body></html>`;
  const article = extractArticle(html, 'https://example.org/unemployment');
  assert.match(article.publishedAt, /^2001-03-19/, 'creation date still reported');
  assert.match(article.updatedAt, /^2026-08-10/, 'and so is the date the content was last current');
});

test('a kept-current source is not aged out by its creation date', () => {
  const living = { publishedAt: '2001-03-19T00:00:00Z', updatedAt: new Date(Date.now() - 30 * 864e5).toISOString() };
  const stale = { publishedAt: '2001-03-19T00:00:00Z', updatedAt: null };

  assert.equal(evidenceDate(living), living.updatedAt, 'the freshest signal wins');
  assert.equal(evidenceDate(stale), '2001-03-19T00:00:00.000Z');
  assert.equal(evidenceDate({}), null, 'no dates at all stays null rather than guessing');

  // On a time-sensitive claim this is the difference between a boost and a penalty.
  const boosted = recencyFactor(evidenceDate(living), true);
  const penalized = recencyFactor(evidenceDate(stale), true);
  assert.ok(boosted > 1, 'a page updated last month reads as current evidence');
  assert.ok(penalized < 1, 'a genuinely stale page is still discounted');
  // The bug being guarded against: an undated page used to outrank a correctly
  // parsed, freshly updated one.
  assert.ok(boosted > recencyFactor(null, true), 'and it beats a page with no date at all');
});

// ------------------------------------------------ Exa backend + cache terms

test('exa backend keeps the publication date, which is why it is worth having', async () => {
  const calls = [];
  const backend = createExaBackend(
    { ...config, exaApiKey: 'exa-key', searchUserAgent: 'test-agent' },
    {
      fetchImpl: async (url, opts) => {
        calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              { title: 'IEA', url: 'https://iea.org/ev', text: 'Sales   tripled.', publishedDate: '2024-04-23T00:00:00.000Z' },
              { title: 'Undated', url: 'https://example.com/x', text: 'No date here.' },
              { title: 'Nonsense date', url: 'https://example.com/y', text: 'Bad date.', publishedDate: 'not-a-date' },
            ],
          }),
        };
      },
    },
  );

  assert.equal(backend.enabled, true);
  const results = await backend.search('global EV sales', { limit: 5 });
  assert.equal(calls[0].headers['x-api-key'], 'exa-key');
  assert.equal(calls[0].body.numResults, 5);
  assert.equal(results[0].publishedAt, '2024-04-23T00:00:00.000Z', 'the date survives');
  assert.equal(results[0].snippet, 'Sales tripled.', 'whitespace collapsed');
  assert.equal(results[1].publishedAt, null, 'missing date stays null');
  assert.equal(results[2].publishedAt, null, 'an unparseable date is dropped, not passed on');
});

test('results from a vendor that forbids caching get a short TTL', async (t) => {
  _clearMemoryCache();
  const base = createMemoryStore();
  const ttls = [];
  const spy = {
    ...base,
    set: (k, v, ttlSec) => {
      ttls.push(ttlSec);
      return base.set(k, v, ttlSec);
    },
  };
  _resetStoreForTests(spy);
  t.after(() => _resetStoreForTests(null));

  const web = await startFakeWeb();
  t.after(() => web.close());

  const mk = (name, extra = {}) => ({
    name,
    enabled: true,
    ...extra,
    search: async () => [{ title: 'NASA', url: `${web.base}/nasa`, snippet: 'Great Wall not visible from the Moon.' }],
  });
  const cfg = { ...config, searchCacheTtlSec: 21600, searchRestrictedCacheTtlSec: 300 };

  // Brave's terms permit only transient storage, so a set it contributed to
  // must not be held for hours.
  const restricted = createSearchEngine({ config: cfg, backends: [mk('brave', { cacheRestricted: true })] });
  await restricted.search('Great Wall visible from the Moon', { maxResults: 3 });
  assert.equal(ttls.at(-1), 300, 'restricted vendor caps the whole answer');

  _clearMemoryCache();
  // Wikipedia has no such restriction, so the normal TTL applies.
  const open = createSearchEngine({ config: cfg, backends: [mk('wikipedia')] });
  await open.search('Great Wall seen from orbit myth', { maxResults: 3 });
  assert.equal(ttls.at(-1), 21600, 'unrestricted vendors keep the long TTL');
});

// ---------------------------------------------- resilience under our own load

test('a timeout does not disable a healthy backend, but real errors do', async () => {
  const { createBreaker } = await import('../src/search/backends/index.js');
  const breaker = createBreaker({ failureThreshold: 3, softFailureThreshold: 8, cooldownMs: 60000 });

  // Timeouts are usually OUR fault (CPU contention), so they must take far more
  // evidence before we stop calling a vendor.
  for (let i = 0; i < 7; i++) breaker.failure('exa', { soft: true });
  assert.equal(breaker.allow('exa'), true, 'still calling exa after 7 timeouts');
  breaker.failure('exa', { soft: true });
  assert.equal(breaker.allow('exa'), false, 'opens once timeouts are clearly systemic');

  // A hard failure (auth rejected, 5xx) is real evidence the vendor is broken.
  for (let i = 0; i < 3; i++) breaker.failure('brave');
  assert.equal(breaker.allow('brave'), false, 'opens quickly on real errors');
});

test('retrieval retries once with a wider timeout when every backend times out', async (t) => {
  _resetStoreForTests(createMemoryStore());
  _clearMemoryCache();
  t.after(() => _resetStoreForTests(null));

  const attempts = [];
  // Slow enough to blow the first (narrow) timeout, fast enough for the retry.
  const slowBackend = {
    name: 'slow',
    enabled: true,
    async search(q, { signal } = {}) {
      const attempt = attempts.length + 1;
      attempts.push(attempt);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 95);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
      return [{ title: 'Recovered source', url: 'https://example.gov/report', snippet: 'NASA confirms the wall is not visible from the Moon at that distance.' }];
    },
  };

  const engine = createSearchEngine({
    config: {
      ...config,
      searchBackendTimeoutMs: 70, // first pass (70ms) aborts; retry (140ms) succeeds
      searchRetrieveMs: 400,
      searchDeadlineMs: 3000,
      searchFetchDeadlineMs: 200,
    },
    backends: [slowBackend],
  });

  const results = await engine.search('The Great Wall of China is visible from the Moon.', { maxResults: 3 });
  assert.ok(attempts.length >= 2, `retried after total failure (attempts: ${attempts.length})`);
  assert.ok(results.length > 0, 'recovered evidence instead of forcing UNVERIFIED');
});
