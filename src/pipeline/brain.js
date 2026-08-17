// Brain: wires the claim extractor loop, verification workers, score engine,
// and turn clock for a live session. Providers are injectable for tests.
import './commands.js'; // registers /mode /pause /resume /check /turn handlers
import { getLlmProvider } from '../providers/llm/index.js';
import { getSearchProvider } from '../providers/search/index.js';
import { startExtractor } from './extractor.js';
import { startVerifier } from './verifier.js';
import { startScorer, recordFallacy } from './scoreEngine.js';
import { startTurnClock } from './turnClock.js';
import { publishEvent } from '../sessions/events.js';
import { getSession } from '../sessions/manager.js';
import { config } from '../config.js';

export async function startBrain(sessionId, { llm, searchProvider, extractIntervalMs, scoreIntervalMs } = {}) {
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
      await recordFallacy(sessionId, fallacy.speaker); // always scored...
      if (!fallacyFlagsEnabled) return; // ...but only flagged when the preset wants it
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

  const scorer = startScorer(sessionId, {
    sessionConfig,
    intervalMs: scoreIntervalMs || config.scoreIntervalMs,
  });

  const turnClock = startTurnClock(sessionId, {
    structure: sessionConfig.turns?.structure || [],
    enforce: !!sessionConfig.turns?.enforce,
  });

  return {
    extractor,
    verifier,
    scorer,
    turnClock,
    llm: resolvedLlm,
    async stop() {
      // Drain: final extraction pass, let in-flight verifications finish, then
      // take the final score snapshot (reveals when visibility === 'end').
      await turnClock.stop();
      await extractor.drain().catch(() => {});
      await extractor.stop();
      await verifier.waitForIdle(config.verifyTimeoutMs).catch(() => {});
      await verifier.stop();
      await scorer.stop({ revealFinal: true });
    },
  };
}
