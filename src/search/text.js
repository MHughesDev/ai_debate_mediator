// Text + URL primitives for the search engine. Deliberately dependency-free:
// every millisecond and every megabyte counts in the container.

export const STOPWORDS = new Set(
  ('a about above after again against all am an and any are as at be because been before being below between both but by ' +
    'can did do does doing down during each few for from further had has have having he her here hers him his how i if in ' +
    'into is it its just me more most my no nor not of off on once only or other our out over own same she should so some ' +
    'such than that the their them then there these they this those through to too under until up very was we were what ' +
    'when where which while who whom why will with would you your actually really simply just basically').split(' '),
);

// Hedges and debate filler that add no retrieval signal.
const FILLER = /\b(i (believe|think|feel|predict|would argue)|in my (opinion|view)|you can see|of course|frankly|honestly|let me be clear|the fact is)\b/gi;

export function stripFiller(text) {
  return (text || '').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
}

export function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9%.\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function contentTerms(text) {
  return tokenize(text).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// Very light suffix folding — enough to match plural/tense variants without a
// stemmer dependency, and conservative enough not to collide unrelated words.
export function fold(term) {
  if (term.length <= 4) return term;
  for (const suffix of ['ies', 'ing', 'ed', 'es', 's']) {
    if (term.endsWith(suffix) && term.length - suffix.length >= 4) {
      return suffix === 'ies' ? `${term.slice(0, -3)}y` : term.slice(0, -suffix.length);
    }
  }
  return term;
}

export function foldedTerms(text) {
  return contentTerms(text).map(fold);
}

// Numbers, percentages and years carry most of the truth value in a factual
// claim ("tripled", "80 percent", "2035"), so they get first-class treatment.
export function extractNumbers(text) {
  const out = new Set();
  for (const m of (text || '').matchAll(/\b\d[\d,]*(?:\.\d+)?%?\b/g)) {
    out.add(m[0].replace(/,/g, '').toLowerCase());
  }
  return [...out];
}

export function extractYears(text) {
  const out = new Set();
  for (const m of (text || '').matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) out.add(m[1]);
  return [...out];
}

// Capitalized runs, minus sentence-initial noise, approximate named entities.
export function extractEntities(text) {
  const entities = new Set();
  const sentences = (text || '').split(/(?<=[.?!])\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    let run = [];
    words.forEach((word, i) => {
      const clean = word.replace(/[^A-Za-z0-9'\-.]/g, '');
      const isCap = /^[A-Z][A-Za-z'\-.]*$/.test(clean) && clean.length > 1;
      const sentenceInitial = i === 0;
      if (isCap && !(sentenceInitial && STOPWORDS.has(clean.toLowerCase()))) {
        run.push(clean);
      } else {
        if (run.length) entities.add(run.join(' '));
        run = [];
      }
    });
    if (run.length) entities.add(run.join(' '));
  }
  // Acronyms (IEA, NASA, ICCT) even mid-sentence.
  for (const m of (text || '').matchAll(/\b[A-Z]{2,6}\b/g)) entities.add(m[0]);
  return [...entities].filter((e) => e.length > 1 && !/^\d+$/.test(e));
}

const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_|ref$|ref_|source$|cmpid|icid|ito$)/i;

// Canonical form: strip the noise that makes one page look like many, while
// keeping the URL FETCHABLE. Protocol is deliberately preserved — rewriting it
// would break any http-only source we then try to read.
export function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [k, v] of sorted) url.searchParams.append(k, v);
    return url.toString();
  } catch {
    return raw;
  }
}

// Identity for deduplication only: http and https serve the same document, so
// they must collapse — but never use this to make a request.
export function dedupeKey(raw) {
  return canonicalUrl(raw).replace(/^https?:\/\//i, '');
}

export function domainOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

// Authority tiers. A verdict shown on screen must be defensible, so official
// statistics and primary sources outrank aggregators, which outrank blogs.
const TIER_1 = /(^|\.)(gov|mil|int)$|(^|\.)(who|un|worldbank|imf|oecd|europa)\.(org|int|eu)$|(^|\.)edu$|(^|\.)ac\.[a-z]{2}$/i;
const TIER_2 = /(^|\.)(iea|icct|nasa|noaa|nih|cdc|ipcc|bls|ssb|eia|census|statista|ourworldindata|pewresearch|nature|science|springer|jstor|arxiv)\.[a-z.]+$/i;
const TIER_3 = /(^|\.)(reuters|apnews|bbc|ft|economist|nytimes|wsj|washingtonpost|guardian|bloomberg|npr|axios|politico|wikipedia|britannica)\.[a-z.]+$/i;
const TIER_LOW = /(^|\.)(medium|substack|blogspot|wordpress|tumblr|quora|reddit|facebook|x|twitter|tiktok|pinterest)\.[a-z.]+$/i;

export function domainAuthority(domain) {
  if (!domain) return 0.5;
  if (TIER_1.test(domain)) return 1.0;
  if (TIER_2.test(domain)) return 0.95;
  if (TIER_3.test(domain)) return 0.85;
  if (TIER_LOW.test(domain)) return 0.45;
  return 0.65;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', deg: '°', percnt: '%',
};

export function decodeEntities(text) {
  return (text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

export function splitSentences(text) {
  return (text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeWhitespace(text) {
  return (text || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
