// Passage retrieval and ranking.
//
// The judge should never be handed a whole article — it should get the few
// paragraphs that actually bear on the claim. That is a passage-retrieval
// problem, so: chunk documents into overlapping passages, score them with BM25
// (the strong lexical baseline that hybrid search systems still build on), then
// apply claim-aware boosts. Numbers and years are weighted heavily because a
// factual claim usually turns on exactly those tokens.
import { foldedTerms, fold, contentTerms, splitSentences, extractNumbers, extractYears, domainAuthority } from './text.js';

const K1 = 1.2; // term-frequency saturation
const B = 0.75; // length normalization

export function chunkPassages(text, { targetWords = 90, overlapSentences = 1 } = {}) {
  const sentences = splitSentences(text || '');
  const passages = [];
  let current = [];
  let words = 0;

  for (const sentence of sentences) {
    const n = sentence.split(/\s+/).length;
    current.push(sentence);
    words += n;
    if (words >= targetWords) {
      passages.push(current.join(' '));
      current = overlapSentences > 0 ? current.slice(-overlapSentences) : [];
      words = current.reduce((sum, s) => sum + s.split(/\s+/).length, 0);
    }
  }
  if (current.length) {
    const tail = current.join(' ');
    // Avoid emitting a fragment that is purely the overlap of the previous one.
    if (!passages.length || tail.split(/\s+/).length > 12) passages.push(tail);
  }
  return passages.filter((p) => p.split(/\s+/).length >= 6);
}

// Classic BM25 over a passage collection.
export function buildBm25(passages) {
  const docs = passages.map((text) => {
    const terms = foldedTerms(text);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    return { text, terms, tf, length: terms.length };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1);
  const df = new Map();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = docs.length || 1;

  return {
    docs,
    score(doc, queryTerms) {
      let score = 0;
      for (const term of queryTerms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const n = df.get(term) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (doc.length / (avgLength || 1)))));
      }
      return score;
    },
  };
}

/**
 * Rank passages drawn from fetched documents against the claim.
 * @param {Array<{url,title,domain,text,publishedAt,authority?,fusedScore?}>} docs
 * @param {{claim: string, plan: object}} ctx
 */
export function rankPassages(docs, { claim, plan, maxPassages = 6, maxPerDomain = 2 } = {}) {
  const queryTerms = [...new Set(foldedTerms(`${claim} ${plan?.queries?.[0]?.q || ''}`))];
  const claimNumbers = new Set(plan?.numbers?.length ? plan.numbers : extractNumbers(claim));
  const claimYears = new Set(plan?.years?.length ? plan.years : extractYears(claim));
  const claimEntities = (plan?.entities || []).map((e) => e.toLowerCase()).filter((e) => e.length > 2);
  const entityTokens = [...new Set(claimEntities.flatMap((e) => e.split(/\s+/)).filter((t) => t.length > 3))];
  const phrases = keyPhrases(claim);
  // The handful of terms a passage really must touch to be about this claim.
  const topicTerms = [...new Set(foldedTerms(claim))].slice(0, 8);

  // Pool every passage from every document into ONE BM25 corpus. Scoring each
  // document separately would compute IDF within that document's own passages,
  // making scores incomparable across sources — the ranking would then be
  // decided by document length rather than relevance.
  const pooled = [];
  for (const doc of docs) {
    for (const text of chunkPassages(doc.text)) pooled.push({ text, doc });
  }
  if (!pooled.length) return [];

  const bm25 = buildBm25(pooled.map((p) => p.text));
  const candidates = [];

  pooled.forEach((entry, i) => {
    const scored = bm25.docs[i];
    const base = bm25.score(scored, queryTerms);
    if (base <= 0) return;
    const lower = entry.text.toLowerCase();
    const folded = new Set(scored.terms);

    // Topical coverage. A passage that mentions none of the claim's entities,
    // numbers or core terms is not evidence about this claim, however well its
    // vocabulary happens to overlap — this is what stopped a Norway EV claim
    // being "answered" by an article about New Zealand social spending.
    const entityHits = entityTokens.filter((t) => lower.includes(t)).length;
    const numberHits = [...claimNumbers].filter((n) => lower.includes(n)).length;
    const yearHits = [...claimYears].filter((y) => lower.includes(y)).length;
    const termHits = topicTerms.filter((t) => folded.has(t)).length;
    const termCoverage = topicTerms.length ? termHits / topicTerms.length : 0;

    const onTopic = entityHits > 0 || numberHits > 0 || termCoverage >= 0.4;
    if (!onTopic) return;

    const coverage = Math.min(
      1,
      (entityTokens.length ? (entityHits / entityTokens.length) * 0.45 : 0) +
        termCoverage * 0.45 +
        (numberHits ? 0.1 : 0),
    );

    let boost = 1;
    if (numberHits) boost += 0.35 * Math.min(numberHits, 3);
    if (yearHits) boost += 0.2 * Math.min(yearHits, 2);
    const phraseHits = phrases.filter((p) => lower.includes(p)).length;
    if (phraseHits) boost += 0.25 * Math.min(phraseHits, 2);
    // Passages that state a relation ("X% higher than", "compared with") are
    // what settle comparative claims.
    if (/\b(compared|versus|vs\.?|than|whereas|however|in contrast|according to)\b/.test(lower)) boost += 0.1;
    // Explicit verification language is gold for a fact-checker.
    if (/\b(debunk|myth|false|incorrect|contrary to|in fact|actually|confirms?)\b/.test(lower)) boost += 0.15;

    const doc = entry.doc;
    const authority = doc.authority ?? domainAuthority(doc.domain);
    const recency = recencyFactor(doc.publishedAt, plan?.timeSensitive);

    candidates.push({
      text: entry.text,
      url: doc.url,
      title: doc.title,
      domain: doc.domain,
      publishedAt: doc.publishedAt || null,
      score: base * boost * (0.35 + 0.9 * coverage) * (0.55 + 0.45 * authority) * recency,
      signals: {
        bm25: +base.toFixed(3),
        coverage: +coverage.toFixed(2),
        boost: +boost.toFixed(2),
        authority,
        recency: +recency.toFixed(2),
      },
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  // Diversity first: never let one domain fill the evidence set...
  const perDomain = new Map();
  const chosen = [];
  const overflow = [];
  for (const c of candidates) {
    const n = perDomain.get(c.domain) || 0;
    if (n >= maxPerDomain) {
      overflow.push(c);
      continue;
    }
    perDomain.set(c.domain, n + 1);
    chosen.push(c);
    if (chosen.length >= maxPassages) break;
  }
  // ...but a thin evidence set is worse than a concentrated one. If diversity
  // left us short (one strong source, or only one backend configured), backfill
  // with the next best passages rather than handing the judge less to work with.
  for (const c of overflow) {
    if (chosen.length >= maxPassages) break;
    chosen.push(c);
  }
  return chosen;
}

function keyPhrases(claim) {
  const terms = contentTerms(claim);
  const out = [];
  for (let i = 0; i < terms.length - 1; i++) {
    if (terms[i].length > 3 && terms[i + 1].length > 3) out.push(`${terms[i]} ${terms[i + 1]}`);
  }
  return out.slice(0, 8);
}

// Fresh sources matter for "currently/record/latest" claims and matter much
// less for settled physical facts, so recency only bites when time-sensitive.
export function recencyFactor(publishedAt, timeSensitive) {
  if (!publishedAt) return timeSensitive ? 0.92 : 1;
  const ageYears = (Date.now() - new Date(publishedAt).getTime()) / (365.25 * 24 * 3600 * 1000);
  if (!Number.isFinite(ageYears) || ageYears < 0) return 1;
  if (!timeSensitive) return ageYears > 15 ? 0.95 : 1;
  if (ageYears <= 1) return 1.15;
  if (ageYears <= 3) return 1.05;
  if (ageYears <= 6) return 0.95;
  return 0.85;
}

// Fallback when a page could not be fetched: rank the SERP snippet itself so a
// slow or blocked site still contributes evidence rather than disappearing.
export function rankSnippets(results, { claim, plan, maxPassages = 4 } = {}) {
  return rankPassages(
    results
      .filter((r) => (r.snippet || '').split(/\s+/).length >= 6)
      .map((r) => ({
        url: r.url,
        title: r.title,
        domain: r.domain,
        text: r.snippet,
        publishedAt: r.publishedAt,
        authority: r.authority,
      })),
    { claim, plan, maxPassages, maxPerDomain: 1 },
  );
}
