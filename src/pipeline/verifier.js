// Verification: Redis queue per session + a small worker pool.
// worker: claim -> 1..N web searches -> LLM judge -> credibility gating ->
// factcheck event + persisted verdict. Latency budget: claim -> verdict 8-20s.
//
// Credibility rules (SPEC §3.1, non-negotiable) live in gateVerdict():
//   1. Below-threshold verdicts display as UNVERIFIED — never a guess.
//   2. TRUE/FALSE/MISLEADING must carry at least one source.
//   3. FALSE requires the highest confidence bar (false_verdict_min_confidence).
//   4. Opinions/predictions/questions are never verified (enforced upstream:
//      only checkable factual claims are ever enqueued).
import { getStore } from '../state/store.js';
import { getClaim, setClaimVerdict } from './argumentGraph.js';
import { publishEvent } from '../sessions/events.js';
import { setStateSlice, getSession } from '../sessions/manager.js';
import { recordSearch } from './costMeter.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const queueKey = (id) => `sess:${id}:verifyq`;
const pendingKey = (id) => `sess:${id}:verifying`;

export function gateVerdict(raw, overrides = {}) {
  const minConfidence = overrides.verdict_min_confidence ?? config.verdictMinConfidence;
  const falseMin = overrides.false_verdict_min_confidence ?? config.falseVerdictMinConfidence;

  let { verdict, confidence = 0, evidence_summary = '', sources = [] } = raw || {};
  if (!['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE'].includes(verdict)) verdict = 'UNVERIFIED';

  const displayable = ['TRUE', 'FALSE', 'MISLEADING'];
  if (displayable.includes(verdict)) {
    if (!sources || sources.length === 0) {
      // Rule 2: no sources -> never assert.
      return { verdict: 'UNVERIFIED', confidence, evidence_summary: 'Insufficient sourced evidence.', sources: [] };
    }
    if (confidence < minConfidence) {
      return { verdict: 'UNVERIFIED', confidence, evidence_summary: 'Confidence below display threshold.', sources };
    }
    if (verdict === 'FALSE' && confidence < falseMin) {
      // Rule 3: a wrong FALSE on screen is the worst failure mode.
      return { verdict: 'UNVERIFIED', confidence, evidence_summary: 'FALSE requires higher confidence.', sources };
    }
  }
  return { verdict, confidence, evidence_summary, sources };
}

export async function enqueueVerification(sessionId, claimId) {
  const store = await getStore();
  await store.rpush(queueKey(sessionId), claimId);
  await store.expire(queueKey(sessionId), config.sessionTtlSec);
  await bumpPending(sessionId, +1);
}

async function bumpPending(sessionId, delta) {
  const store = await getStore();
  const current = parseInt((await store.get(pendingKey(sessionId))) || '0', 10);
  const next = Math.max(0, current + delta);
  await store.set(pendingKey(sessionId), String(next), config.sessionTtlSec);
  const payload = { count: next };
  await setStateSlice(sessionId, 'pending', payload);
  await publishEvent(sessionId, 'verification.pending', payload);
  return next;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function startVerifier(sessionId, { llm, searchProvider, concurrency = config.verifyConcurrency, sessionConfig = {} }) {
  let stopped = false;
  let active = 0;
  let idleResolvers = [];

  async function processClaim(claimId) {
    const claim = await getClaim(sessionId, claimId);
    if (!claim) return;
    try {
      // The motion is what disambiguates a claim that is underspecified on its
      // own. "Unemployment is at a record low" is about whichever country the
      // debate is about, and without that the judge can be handed correct
      // evidence about the wrong place and call the claim TRUE.
      const motion = (await getSession(sessionId))?.motion || '';
      await publishEvent(sessionId, 'thought', { text: `searching: “${claim.text.slice(0, 80)}”…` });
      // Providers that plan their own queries (our engine) get the raw claim
      // once; simple providers get hand-built variants for recall.
      const queries = searchProvider.plansQueries
        ? [claim.text]
        : config.searchesPerClaim > 1
          ? [claim.text, `${claim.text} fact check evidence`]
          : [claim.text];

      const resultsNested = await withTimeout(
        Promise.all(queries.map((q) => searchProvider.search(q, { maxResults: 4 }).catch(() => []))),
        config.verifyTimeoutMs / 2,
        'search',
      );
      await recordSearch(sessionId, queries.length);
      const seen = new Set();
      const results = resultsNested.flat().filter((r) => {
        if (!r?.url || seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });

      await publishEvent(sessionId, 'thought', { text: `comparing ${results.length} sources…` });
      const rawVerdict = await withTimeout(
        llm.judgeClaim({ sessionId, claim, results, motion }),
        config.verifyTimeoutMs,
        'judge',
      );
      // Read the LIVE session config so /mode switches change gating immediately.
      const liveConfig = (await getSession(sessionId))?.config || sessionConfig;
      const gated = gateVerdict(rawVerdict, liveConfig.factcheck || {});

      const updated = await setClaimVerdict(sessionId, claimId, gated);
      const card = {
        claimId,
        claim: claim.text,
        speaker: claim.speaker,
        verdict: gated.verdict,
        confidence: gated.confidence,
        evidence: gated.evidence_summary,
        sources: gated.sources,
        hold_ms: 15000,
      };
      await setStateSlice(sessionId, 'lastFactcheck', card);
      await publishEvent(sessionId, 'factcheck', card);
      return updated;
    } catch (err) {
      // Timeout / provider failure -> honest UNVERIFIED, never a guess.
      logger.warn('verification failed', { sessionId, claimId, error: err.message });
      const gated = {
        verdict: 'UNVERIFIED',
        confidence: 0,
        evidence_summary: 'Verification did not complete in time.',
        sources: [],
      };
      await setClaimVerdict(sessionId, claimId, gated).catch(() => {});
      await publishEvent(sessionId, 'factcheck', {
        claimId,
        claim: claim.text,
        speaker: claim.speaker,
        verdict: 'UNVERIFIED',
        confidence: 0,
        evidence: gated.evidence_summary,
        sources: [],
        hold_ms: 6000,
      });
    } finally {
      await bumpPending(sessionId, -1);
      active -= 1;
      maybeNotifyIdle();
    }
  }

  function maybeNotifyIdle() {
    if (active === 0) {
      for (const resolve of idleResolvers.splice(0)) resolve();
    }
  }

  async function loop() {
    const store = await getStore();
    while (!stopped) {
      if (active >= concurrency) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const claimId = await store.lpop(queueKey(sessionId));
      if (!claimId) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      active += 1;
      processClaim(claimId); // deliberately unawaited: pool-style concurrency
    }
  }

  const looping = loop();

  return {
    async waitForIdle(timeoutMs = 10000) {
      const store = await getStore();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const qlen = await store.llen(queueKey(sessionId));
        if (qlen === 0 && active === 0) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },
    async stop() {
      stopped = true;
      await looping.catch(() => {});
    },
  };
}
