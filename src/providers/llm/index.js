// LlmProvider interface — task-level so the mock can be heuristic:
//   extractClaims({ motion, speakers, chunkText, priorClaims }) ->
//     { claims: [{ text, speaker, type, checkable, links }], fallacies: [{ speaker, label, detail, confidence }] }
//   judgeClaim({ claim, results }) ->
//     { verdict, confidence, evidence_summary, sources: [{name,url}] }
//   generateReceipts({ motion, stats }) -> { winner?, most_accurate?, ...narrative fields }
import { config } from '../../config.js';
import { createAnthropicLlm } from './anthropic.js';
import { createMockLlm } from './mock.js';

export function getLlmProvider() {
  switch (config.llmProvider) {
    case 'anthropic':
      return createAnthropicLlm();
    case 'mock':
      return createMockLlm();
    default:
      throw new Error(`unknown LLM_PROVIDER: ${config.llmProvider}`);
  }
}
