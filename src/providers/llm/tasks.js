// The three LLM tasks, written once and shared by every provider.
//
// Prompts and schemas are the product; the vendor is an implementation detail.
// Keeping them here means switching from Anthropic to a local Llama changes the
// transport and nothing about what we ask for — and it makes prompt changes
// (like the SCOPE rule in the judge) apply everywhere at once.
//
// A task returns its documented safe fallback when the model refuses, returns
// nothing, or returns unparseable output. Never a guess: an honest
// UNVERIFIABLE is a correct outcome, a fabricated verdict is not.

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          speaker: { type: 'string' },
          type: { type: 'string', enum: ['factual', 'opinion', 'prediction', 'question'] },
          checkable: { type: 'boolean' },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                relation: { type: 'string', enum: ['supports', 'rebuts'] },
                target_text: { type: 'string' },
              },
              required: ['relation', 'target_text'],
              additionalProperties: false,
            },
          },
        },
        required: ['text', 'speaker', 'type', 'checkable', 'links'],
        additionalProperties: false,
      },
    },
    fallacies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string' },
          label: { type: 'string' },
          detail: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['speaker', 'label', 'detail', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims', 'fallacies'],
  additionalProperties: false,
};

// Sources are cited by RESULT NUMBER, not by URL. Reproducing a long URL
// verbatim in JSON is exactly what a small model gets wrong, and getting it
// wrong is expensive: no sources means gateVerdict downgrades an otherwise
// correct verdict to UNVERIFIED. Measured on qwen2.5:7b, which returned a
// correct FALSE at 0.95 confidence with an empty sources array. Citing "[1],
// [3]" is trivial by comparison, and the mapping back to URLs is ours — so a
// source can never be invented.
export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE'] },
    confidence: { type: 'number' },
    evidence_summary: { type: 'string' },
    source_indices: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Numbers of the search results that informed the verdict, e.g. [1, 3]',
    },
  },
  required: ['verdict', 'confidence', 'evidence_summary', 'source_indices'],
  additionalProperties: false,
};

export const RECEIPTS_SCHEMA = {
  type: 'object',
  properties: {
    winner: { type: 'string' },
    headline: { type: 'string' },
    most_accurate: { type: 'string' },
    least_accurate: { type: 'string' },
  },
  required: ['headline'],
  additionalProperties: false,
};

const EXTRACT_SYSTEM =
  'You are the claim extractor for a live debate fact-checking system. Extract only substantive claims from the new transcript text. ' +
  'Types: factual (verifiable statement of fact), opinion (value judgment), prediction (about the future), question (posed to an opponent). ' +
  'checkable=true only for factual claims a web search could verify. Attribute each claim to the speaker who said it. ' +
  'links connect a new claim to a prior claim it directly supports or rebuts (match by target_text). ' +
  'Report fallacies only when unmistakable (ad hominem, strawman, false dilemma...) with confidence 0-1. Do not invent claims.';

const JUDGE_SYSTEM =
  'You are the verification judge for a live debate fact-checker. Judge the claim strictly against the provided search results — not prior knowledge. ' +
  'Verdicts: TRUE (results clearly support it), FALSE (results clearly contradict it), MISLEADING (technically partial truth that creates a wrong impression), ' +
  'UNVERIFIABLE (results cannot settle it). confidence is 0-1 and must reflect the strength of the evidence; a FALSE verdict shown on screen is the worst possible ' +
  'failure mode, so only assign FALSE with high confidence and contradicting sources. evidence_summary is ONE display-ready sentence. ' +
  'source_indices lists the NUMBERS of the results that actually informed the verdict, for example [1, 3]. ' +
  'Whenever the results settle the claim you must cite at least one; an uncited verdict cannot be shown and is wasted work. ' +
  'SCOPE: evidence about a different country, organisation, population or time period than the claim is NOT evidence for it. ' +
  'Search is keyword-based, so results often describe a similar-sounding but different subject - a claim about unemployment ' +
  'answered by statistics for a different country, for instance. Use the debate motion to resolve what an underspecified claim refers to. ' +
  'If the claim is too underspecified to pin down, or the results concern a different subject, return UNVERIFIABLE and say so ' +
  'in one sentence. Never stretch evidence to fit.';

const RECEIPTS_SYSTEM =
  'You write the post-debate "receipts" card. Base every statement strictly on the provided stats; short, punchy, neutral. headline is one sentence. ' +
  'Name a speaker or team only where the stats state it. Never add explanatory parentheticals, and never attribute a claim to someone the stats do not name — ' +
  'this card is shown to the people it describes, so a wrong attribution is as damaging as a wrong verdict.';

/**
 * Build the LlmProvider task surface on top of a `run` function.
 *
 * @param {(args: {task, model, system, prompt, schema, maxTokens, effort, sessionId}) => Promise<object|null>} run
 * @param {(task: string) => string} modelFor
 */
export function createTasks(run, modelFor, kind) {
  return {
    kind,

    async extractClaims({ sessionId, motion, speakers, chunkText, priorClaims }) {
      const result = await run({
        task: 'extractor',
        sessionId,
        model: modelFor('extractor'),
        maxTokens: 2500,
        system: EXTRACT_SYSTEM,
        prompt:
          `Debate motion: ${motion || '(none provided)'}\n` +
          `Speakers: ${(speakers || []).join(', ')}\n\n` +
          `Prior claims (for links/dedupe):\n${(priorClaims || []).map((c) => `- [${c.speaker}] ${c.text}`).join('\n') || '(none)'}\n\n` +
          `New transcript:\n${chunkText}`,
        schema: EXTRACT_SCHEMA,
      });
      return result || { claims: [], fallacies: [] };
    },

    async judgeClaim({ sessionId, claim, results, motion }) {
      const resultsText = (results || [])
        .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
        .join('\n\n');
      const result = await run({
        task: 'judge',
        sessionId,
        model: modelFor('judge'),
        maxTokens: 1500,
        effort: 'low', // stay inside the 8-20s verdict latency budget
        system: JUDGE_SYSTEM,
        prompt:
          `Debate motion: ${motion || '(none provided)'}\n` +
          `Claim by ${claim.speaker}: "${claim.text}"\n\nSearch results:\n${resultsText || '(no results found)'}`,
        schema: JUDGE_SCHEMA,
      });
      if (!result) {
        return { verdict: 'UNVERIFIABLE', confidence: 0, evidence_summary: 'Verification unavailable.', sources: [] };
      }
      return {
        verdict: result.verdict,
        confidence: result.confidence,
        evidence_summary: result.evidence_summary,
        sources: resolveSources(result.source_indices, results),
      };
    },

    async generateReceipts({ sessionId, motion, stats }) {
      const result = await run({
        task: 'receipts',
        sessionId,
        model: modelFor('receipts'),
        maxTokens: 1200,
        effort: 'low',
        system: RECEIPTS_SYSTEM,
        prompt: `Motion: ${motion || '(none)'}\n\nDebate stats (JSON):\n${JSON.stringify(stats, null, 2)}`,
        schema: RECEIPTS_SCHEMA,
      });
      return result || { headline: 'Debate complete.' };
    },
  };
}

// Map cited result numbers back to real sources. Anything out of range is
// dropped rather than guessed at: a citation we cannot resolve is not a
// citation, and inventing one would defeat the point of citing.
function resolveSources(indices, results) {
  const list = results || [];
  const seen = new Set();
  const out = [];
  for (const raw of indices || []) {
    const i = Number(raw) - 1; // results are presented to the model 1-based
    const hit = list[i];
    if (!hit?.url || seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push({ name: hit.title || hit.domain || hit.url, url: hit.url });
  }
  return out;
}
