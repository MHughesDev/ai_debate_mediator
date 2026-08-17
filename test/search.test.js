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
import { chunkPassages, rankPassages, recencyFactor } from '../src/search/rank.js';
import { canonicalUrl, dedupeKey, domainAuthority, extractEntities, extractNumbers, fold } from '../src/search/text.js';
import { createSearchEngine } from '../src/search/engine.js';
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
