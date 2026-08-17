// Claim extractor loop: every EXTRACT_INTERVAL_MS, feed the transcript DELTA
// (never the whole transcript) to the fast LLM, dedupe, grow the argument
// graph, queue checkable factual claims for verification, surface fallacies.
// One bad tick must never kill the session — errors are isolated per tick.
import { getTranscriptDelta } from './transcript.js';
import { addClaim, findDuplicate, getClaims, resolveLinks } from './argumentGraph.js';
import { enqueueVerification } from './verifier.js';
import { getSpeakers } from './speakers.js';
import { publishEvent } from '../sessions/events.js';
import { getSession } from '../sessions/manager.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export function startExtractor(sessionId, { llm, intervalMs = config.extractIntervalMs, onFallacy, onClaim }) {
  let cursor = 0;
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const { entries, cursor: nextCursor } = await getTranscriptDelta(sessionId, cursor);
      if (entries.length === 0) return;
      cursor = nextCursor;

      const session = await getSession(sessionId);
      const speakers = (await getSpeakers(sessionId)).filter((s) => s.tracked);
      const speakerNames = speakers.map((s) => s.name);
      const chunkText = entries.map((e) => `${e.speakerName}: ${e.text}`).join('\n');
      const priorClaims = (await getClaims(sessionId)).slice(-30);

      const { claims, fallacies } = await llm.extractClaims({
        sessionId,
        motion: session?.motion,
        speakers: speakerNames,
        chunkText,
        priorClaims: priorClaims.map((c) => ({ speaker: c.speaker, text: c.text })),
      });

      for (const raw of claims || []) {
        if (!raw.text || !raw.speaker) continue;
        if (await findDuplicate(sessionId, raw.text)) continue;
        const speaker = speakers.find((s) => s.name === raw.speaker);
        const links = await resolveLinks(sessionId, raw.links);
        const claim = await addClaim(sessionId, {
          text: raw.text,
          speaker: raw.speaker,
          speakerId: speaker?.id,
          type: raw.type,
          checkable: raw.type === 'factual' && !!raw.checkable,
          links,
        });
        await publishEvent(sessionId, 'claim', { claim });
        if (onClaim) await onClaim(claim);
        if (claim.checkable) await enqueueVerification(sessionId, claim.id);
      }

      for (const fallacy of fallacies || []) {
        if ((fallacy.confidence ?? 0) < config.fallacyMinConfidence) continue; // high-confidence only
        if (onFallacy) await onFallacy(fallacy);
      }
    } catch (err) {
      logger.error('extractor tick failed', { sessionId, error: err.message });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  return {
    tick, // exposed for tests / final drain
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
    async drain() {
      // Final pass over any transcript produced after the last tick.
      stopped = false;
      await tick();
      stopped = true;
    },
  };
}
