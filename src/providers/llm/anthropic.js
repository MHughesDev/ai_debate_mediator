// Anthropic-backed LLM tasks. Structured JSON via output_config.format
// (json_schema); refusals and schema misses degrade safely (never a guessed
// verdict — credibility rule #1 is enforced downstream in gateVerdict too).
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { recordLlmUsage } from '../../pipeline/costMeter.js';

const EXTRACT_SCHEMA = {
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

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE'] },
    confidence: { type: 'number' },
    evidence_summary: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, url: { type: 'string' } },
        required: ['name', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'confidence', 'evidence_summary', 'sources'],
  additionalProperties: false,
};

const RECEIPTS_SCHEMA = {
  type: 'object',
  properties: {
    winner: { type: 'string' },
    headline: { type: 'string' },
    most_accurate: { type: 'string' },
    least_accurate: { type: 'string' },
    biggest_unsupported_claim: { type: 'string' },
  },
  required: ['headline'],
  additionalProperties: false,
};

export function createAnthropicLlm() {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  async function structured({ sessionId, model, system, prompt, schema, maxTokens = 2000, effort }) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema }, ...(effort ? { effort } : {}) },
    });
    if (sessionId && response.usage) {
      recordLlmUsage(sessionId, model, response.usage.input_tokens, response.usage.output_tokens).catch(() => {});
    }
    if (response.stop_reason === 'refusal') {
      logger.warn('llm refusal', { model, category: response.stop_details?.category });
      return null;
    }
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      logger.warn('llm structured output parse failed', { model });
      return null;
    }
  }

  return {
    kind: 'anthropic',

    async extractClaims({ sessionId, motion, speakers, chunkText, priorClaims }) {
      const result = await structured({
        sessionId,
        model: config.extractorModel,
        maxTokens: 2500,
        system:
          'You are the claim extractor for a live debate fact-checking system. Extract only substantive claims from the new transcript text. ' +
          'Types: factual (verifiable statement of fact), opinion (value judgment), prediction (about the future), question (posed to an opponent). ' +
          'checkable=true only for factual claims a web search could verify. Attribute each claim to the speaker who said it. ' +
          'links connect a new claim to a prior claim it directly supports or rebuts (match by target_text). ' +
          'Report fallacies only when unmistakable (ad hominem, strawman, false dilemma...) with confidence 0-1. Do not invent claims.',
        prompt:
          `Debate motion: ${motion || '(none provided)'}\n` +
          `Speakers: ${speakers.join(', ')}\n\n` +
          `Prior claims (for links/dedupe):\n${(priorClaims || []).map((c) => `- [${c.speaker}] ${c.text}`).join('\n') || '(none)'}\n\n` +
          `New transcript:\n${chunkText}`,
        schema: EXTRACT_SCHEMA,
      });
      return result || { claims: [], fallacies: [] };
    },

    async judgeClaim({ sessionId, claim, results }) {
      const resultsText = (results || [])
        .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
        .join('\n\n');
      const result = await structured({
        sessionId,
        model: config.judgeModel,
        maxTokens: 1500,
        effort: 'low', // stay inside the 8-20s verdict latency budget
        system:
          'You are the verification judge for a live debate fact-checker. Judge the claim strictly against the provided search results — not prior knowledge. ' +
          'Verdicts: TRUE (results clearly support it), FALSE (results clearly contradict it), MISLEADING (technically partial truth that creates a wrong impression), ' +
          'UNVERIFIABLE (results cannot settle it). confidence is 0-1 and must reflect the strength of the evidence; a FALSE verdict shown on screen is the worst possible ' +
          'failure mode, so only assign FALSE with high confidence and contradicting sources. evidence_summary is ONE display-ready sentence. ' +
          'sources must reference only URLs from the results that actually informed the verdict.',
        prompt: `Claim by ${claim.speaker}: "${claim.text}"\n\nSearch results:\n${resultsText || '(no results found)'}`,
        schema: JUDGE_SCHEMA,
      });
      return result || { verdict: 'UNVERIFIABLE', confidence: 0, evidence_summary: 'Verification unavailable.', sources: [] };
    },

    async generateReceipts({ sessionId, motion, stats }) {
      const result = await structured({
        sessionId,
        model: config.receiptsModel,
        maxTokens: 1200,
        effort: 'low',
        system:
          'You write the post-debate "receipts" card. Base every statement strictly on the provided stats; short, punchy, neutral. headline is one sentence.',
        prompt: `Motion: ${motion || '(none)'}\n\nDebate stats (JSON):\n${JSON.stringify(stats, null, 2)}`,
        schema: RECEIPTS_SCHEMA,
      });
      return result || { headline: 'Debate complete.' };
    },
  };
}
