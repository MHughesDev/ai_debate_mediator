// Query planning: a debate claim is not a search query. "Electric vehicles
// actually emit more carbon dioxide than gasoline cars over their lifetime,
// once you count the battery" should become a couple of tight, high-recall
// queries around the entities and numbers that decide its truth.
//
// This is the cheapest quality lever in the whole engine: better queries beat
// better ranking. Rule-based and sub-millisecond — no LLM round trip in the
// hot path (the verdict latency budget is 8-20s end to end).
import { stripFiller, contentTerms, extractEntities, extractNumbers, extractYears, STOPWORDS } from './text.js';

// Words that signal the claim is about measurement — pulling the matching
// vocabulary into the query surfaces primary statistics rather than opinion.
const EVIDENCE_HINTS = [
  [/\b(emit|emission|co2|carbon|greenhouse)\b/i, 'lifecycle emissions data'],
  [/\b(sales|sold|market share|adoption)\b/i, 'sales statistics'],
  [/\b(unemploy|inflation|gdp|wage|poverty)\b/i, 'official statistics'],
  [/\b(percent|%|rate|per capita)\b/i, 'data'],
  [/\b(study|studies|research|evidence)\b/i, 'peer reviewed study'],
];

const COMPARATIVE = /\b(more|less|fewer|greater|higher|lower|worse|better|than|tripled|doubled|halved|increased|decreased|fastest|largest|lowest|highest)\b/i;

/**
 * @returns {{
 *   queries: {q: string, intent: string}[],
 *   entities: string[], numbers: string[], years: string[],
 *   mustTerms: string[], timeSensitive: boolean
 * }}
 */
export function planQueries(claimText, { motion = '', maxQueries = 3 } = {}) {
  const claim = stripFiller(claimText);
  const entities = extractEntities(claim);
  const numbers = extractNumbers(claim);
  const years = extractYears(claim);
  const terms = contentTerms(claim);

  // Core query: the claim minus filler, capped so engines don't dilute it.
  // Long claims get compressed to their most informative terms (entities and
  // numbers first, then remaining content words in original order).
  const entityTerms = new Set(entities.flatMap((e) => e.toLowerCase().split(/\s+/)));
  const ranked = [];
  for (const t of terms) {
    const weight = entityTerms.has(t) ? 3 : /\d/.test(t) ? 2.5 : COMPARATIVE.test(t) ? 1.5 : 1;
    ranked.push({ t, weight });
  }
  const kept = new Set(
    [...ranked]
      .map((r, i) => ({ ...r, i }))
      .sort((a, b) => b.weight - a.weight || a.i - b.i)
      // Keyword engines lose precision on long queries — keep the query tight
      // around the terms that actually decide the claim.
      .slice(0, 10)
      .map((r) => r.t),
  );
  const core = terms.filter((t) => kept.has(t)).join(' ');

  const queries = [{ q: core || claim.slice(0, 200), intent: 'core' }];

  // Evidence query: entities + the vocabulary of the underlying measurement.
  const hint = EVIDENCE_HINTS.find(([re]) => re.test(claim))?.[1];
  const entityHead = entities.slice(0, 3).join(' ');
  if (hint) {
    const q = `${entityHead || core} ${hint}`.trim();
    queries.push({ q, intent: 'evidence' });
  } else if (COMPARATIVE.test(claim)) {
    queries.push({ q: `${entityHead || core} comparison data`.trim(), intent: 'evidence' });
  }

  // Contradiction query: claims are checked, not confirmed. Explicitly hunting
  // for the counter-evidence is what stops the judge seeing only agreement.
  const subject = entityHead || terms.slice(0, 6).join(' ');
  if (subject) queries.push({ q: `${subject} fact check`.trim(), intent: 'contradiction' });

  const timeSensitive =
    years.length > 0 || /\b(current|currently|today|now|latest|record|ever|history|so far)\b/i.test(claim);

  // Terms a passage really ought to contain to be considered on-topic.
  const mustTerms = [
    ...new Set([
      ...entities.map((e) => e.toLowerCase()),
      ...numbers,
      ...years,
      ...terms.filter((t) => !STOPWORDS.has(t)).slice(0, 6),
    ]),
  ];

  return {
    queries: dedupeQueries(queries).slice(0, Math.max(1, maxQueries)),
    entities,
    numbers,
    years,
    mustTerms,
    timeSensitive,
    motion,
  };
}

function dedupeQueries(queries) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const key = q.q.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...q, q: key });
  }
  return out;
}
