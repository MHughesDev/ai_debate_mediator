// Page fetching under a hard deadline.
//
// Latency rules everything here: the verdict budget is 8-20s end to end, and
// fetching is the slowest stage. So we fetch candidates in parallel, cap bytes,
// abort on the deadline, and return whatever arrived — a slow site loses its
// slot rather than stalling the verdict. Streaming with an explicit byte cap
// matters: some pages are tens of megabytes and would blow both the deadline
// and container memory.
import { logger } from '../logger.js';

const HTML_LIKE = /^(text\/html|application\/xhtml\+xml|text\/plain)/i;

export async function fetchPages(urls, {
  deadlineMs = 2500,
  maxBytes = 1_200_000,
  concurrency = 6,
  userAgent = 'DebateMediatorBot/1.0',
  fetchImpl = fetch,
} = {}) {
  const deadline = Date.now() + deadlineMs;
  const queue = [...urls];
  const out = [];

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      const remaining = deadline - Date.now();
      if (remaining <= 50) return; // out of time; leave the rest unfetched
      const page = await fetchOne(url, { remaining, maxBytes, userAgent, fetchImpl });
      if (page) out.push(page);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

async function fetchOne(url, { remaining, maxBytes, userAgent, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !HTML_LIKE.test(type)) return null;

    const html = await readCapped(res, maxBytes);
    if (!html) return null;
    return { url: res.url || url, html, ms: Date.now() - started };
  } catch (err) {
    // Aborts and network errors are expected and non-fatal — the engine simply
    // works with the sources that did arrive.
    logger.debug('page fetch skipped', { url, error: err.name === 'AbortError' ? 'timeout' : err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Read the body incrementally so we can stop at the cap instead of buffering a
// whole huge document.
async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return text.slice(0, maxBytes);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      break;
    }
  }
  html += decoder.decode();
  return html;
}
