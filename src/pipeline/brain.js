// Brain: wires the claim extractor loop + verification workers (+ Phase 3
// score engine) for a live session. Providers are injectable for tests.
import { getLlmProvider } from '../providers/llm/index.js';
import { getSearchProvider } from '../providers/search/index.js';
import { startExtractor } from './extractor.js';
import { startVerifier } from './verifier.js';
import { publishEvent } from '../sessions/events.js';
import { getSession } from '../sessions/manager.js';
import { config } from '../config.js';

export async function startBrain(sessionId, { llm, searchProvider, extractIntervalMs } = {}) {
  const session = await getSession(sessionId);
  const sessionConfig = session?.config || {};
  const resolvedLlm = llm || getLlmProvider();
  const resolvedSearch = searchProvider || getSearchProvider();

  const verifier = startVerifier(sessionId, {
    llm: resolvedLlm,
    searchProvider: resolvedSearch,
    sessionConfig,
  });

  const fallacyFlagsEnabled = sessionConfig.mediator?.fallacy_flags !== false;
  const extractor = startExtractor(sessionId, {
    llm: resolvedLlm,
    intervalMs: extractIntervalMs || config.extractIntervalMs,
    async onFallacy(fallacy) {
      if (!fallacyFlagsEnabled) return;
      await publishEvent(sessionId, 'flag', {
        kind: 'fallacy',
        speaker: fallacy.speaker,
        label: fallacy.label,
        detail: fallacy.detail,
        confidence: fallacy.confidence,
        hold_ms: 7000,
      });
    },
  });

  return {
    extractor,
    verifier,
    async stop() {
      // Drain: one final extraction pass, then let in-flight verifications finish.
      await extractor.drain().catch(() => {});
      await extractor.stop();
      await verifier.waitForIdle(config.verifyTimeoutMs).catch(() => {});
      await verifier.stop();
    },
  };
}
