// Readability-style main-content extraction, dependency-free.
//
// Same principle as Mozilla Readability / newspaper3k: strip chrome, then score
// candidate blocks by text density and link density — navigation and footers
// are link-dense and word-poor, article bodies are the opposite. Regex-based
// rather than DOM-based because we parse untrusted pages under a deadline and
// a full DOM parse costs far more than it buys for this job.
import { decodeEntities, normalizeWhitespace } from './text.js';

const DROP_BLOCKS = /<(script|style|noscript|svg|template|iframe|form|nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const BLOCK_TAGS = 'p|li|td|th|h1|h2|h3|h4|h5|h6|blockquote|dd|dt|figcaption|pre';

export function extractArticle(html, url = '') {
  if (!html || typeof html !== 'string') {
    return { title: '', text: '', publishedAt: null, updatedAt: null, siteName: '', canonical: url };
  }

  const meta = readMeta(html);
  const cleaned = html.replace(COMMENTS, ' ').replace(DROP_BLOCKS, ' ');

  // Prefer an explicit article container when the page provides one.
  const scoped = firstMatch(cleaned, /<article\b[^>]*>([\s\S]*?)<\/article>/i)
    || firstMatch(cleaned, /<main\b[^>]*>([\s\S]*?)<\/main>/i)
    || firstMatch(cleaned, /<div\b[^>]*(?:id|class)=["'][^"']*(?:article|post|story|content|entry)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    || cleaned;

  const blocks = [];
  for (const m of scoped.matchAll(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi'))) {
    const inner = m[2];
    const text = stripTags(inner);
    if (!text) continue;
    const words = text.split(/\s+/).length;
    const linkChars = [...inner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
      .reduce((sum, a) => sum + stripTags(a[1]).length, 0);
    const linkDensity = text.length ? linkChars / text.length : 1;
    // Navigation lists are short and link-saturated; prose is neither.
    if (words < 6 && linkDensity > 0.3) continue;
    if (linkDensity > 0.6) continue;
    blocks.push({ text, words, linkDensity });
  }

  let text = normalizeWhitespace(blocks.map((b) => b.text).join('\n\n'));

  // Fallback for pages whose body is one big div soup.
  if (text.split(/\s+/).length < 40) {
    const raw = stripTags(scoped);
    if (raw.split(/\s+/).length > text.split(/\s+/).length) text = normalizeWhitespace(raw);
  }

  return {
    title: meta.title,
    text,
    publishedAt: meta.publishedAt,
    updatedAt: meta.updatedAt,
    siteName: meta.siteName,
    canonical: meta.canonical || url,
  };
}

function readMeta(html) {
  const head = html.slice(0, 60000); // metadata always lives near the top
  // For elements that also occur in body content we need the real boundary:
  // a 60KB prefix still swallows the whole body of a short page.
  const headEnd = html.search(/<\/head\s*>/i);
  const headOnly = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 4000);
  const title =
    metaContent(head, 'property', 'og:title') ||
    metaContent(head, 'name', 'twitter:title') ||
    decodeEntities(stripTags(firstMatch(head, /<title\b[^>]*>([\s\S]*?)<\/title>/i) || '')).trim();

  const rawDate =
    metaContent(head, 'property', 'article:published_time') ||
    metaContent(head, 'name', 'article:published_time') ||
    metaContent(head, 'itemprop', 'datePublished') ||
    metaContent(head, 'name', 'pubdate') ||
    metaContent(head, 'name', 'date') ||
    // Scoped to the head: a <time> in the body belongs to the CONTENT (a date
    // inside a table or infobox), not to the page, and reading it as the
    // publication date silently corrupts recency scoring.
    firstMatch(headOnly, /<time\b[^>]*datetime=["']([^"']+)["']/i) ||
    firstMatch(head, /"datePublished"\s*:\s*"([^"]+)"/i);

  // When the content was last current — a different question from when the page
  // was first created. Living documents report creation as datePublished:
  // Wikipedia's "Unemployment" article says 2001 while its figures are current.
  // Treating that as the age of the evidence penalizes the freshest sources
  // hardest, which is exactly backwards.
  const rawUpdated =
    metaContent(head, 'property', 'article:modified_time') ||
    metaContent(head, 'property', 'og:updated_time') ||
    metaContent(head, 'itemprop', 'dateModified') ||
    metaContent(head, 'name', 'lastmod') ||
    firstMatch(html, /"dateModified"\s*:\s*"([^"]+)"/i);

  return {
    title: title || '',
    publishedAt: normalizeDate(rawDate),
    updatedAt: normalizeDate(rawUpdated),
    siteName: metaContent(head, 'property', 'og:site_name') || '',
    canonical:
      firstMatch(head, /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ||
      metaContent(head, 'property', 'og:url') ||
      '',
  };
}

function metaContent(html, attr, value) {
  const direct = new RegExp(`<meta\\b[^>]*${attr}=["']${escapeRe(value)}["'][^>]*content=["']([^"']*)["']`, 'i');
  const reversed = new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${escapeRe(value)}["']`, 'i');
  const found = firstMatch(html, direct) || firstMatch(html, reversed);
  return found ? decodeEntities(found).trim() : '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1] : '';
}

function stripTags(html) {
  return decodeEntities(
    (html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function normalizeDate(raw) {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  // Guard against nonsense dates from bad metadata.
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return parsed.toISOString();
}
