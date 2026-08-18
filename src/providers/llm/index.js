// LlmProvider interface — task-level so the mock can be heuristic:
//   extractClaims({ motion, speakers, chunkText, priorClaims }) ->
//     { claims: [{ text, speaker, type, checkable, links }], fallacies: [{ speaker, label, detail, confidence }] }
//   judgeClaim({ claim, results, motion }) ->
//     { verdict, confidence, evidence_summary, sources: [{name,url}] }
//   generateReceipts({ motion, stats }) -> { winner?, most_accurate?, ...narrative fields }
//
// Every real backend is built from one code path (ADR-0007): the vendor is a
// registry entry plus one of three request dialects, selected by LLM_PROVIDER.
// The mock stays separate because it is heuristic rather than a transport.
import { config } from '../../config.js';
import { createUniversalLlm } from './universal.js';
import { createMockLlm } from './mock.js';

export function getLlmProvider() {
  if (config.llmProvider === 'mock') return createMockLlm();
  return createUniversalLlm();
}
