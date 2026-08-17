// Score engine (SPEC §3.4): per-speaker sub-scores weighted by the active
// rubric. Pure computation is exported for tests; the runner snapshots
// periodically, honors visibility modes, and persists to Postgres.
import { getStore } from '../state/store.js';
import { getDb } from '../db/postgres.js';
import { getClaims } from './argumentGraph.js';
import { getSpeakers } from './speakers.js';
import { publishEvent } from '../sessions/events.js';
import { setStateSlice, getStateSlice } from '../sessions/manager.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const fallaciesKey = (id) => `sess:${id}:fallacies`; // hash speakerName -> count
const dodgesKey = (id) => `sess:${id}:dodges`; // hash speakerName -> count

export async function recordFallacy(sessionId, speakerName) {
  const store = await getStore();
  const n = parseInt((await store.hget(fallaciesKey(sessionId), speakerName)) || '0', 10);
  await store.hset(fallaciesKey(sessionId), speakerName, String(n + 1));
  await store.expire(fallaciesKey(sessionId), config.sessionTtlSec);
}

export async function recordDodge(sessionId, speakerName) {
  const store = await getStore();
  const n = parseInt((await store.hget(dodgesKey(sessionId), speakerName)) || '0', 10);
  await store.hset(dodgesKey(sessionId), speakerName, String(n + 1));
  await store.expire(dodgesKey(sessionId), config.sessionTtlSec);
}

async function getCounts(sessionId, key) {
  const store = await getStore();
  const raw = await store.hgetall(key(sessionId));
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parseInt(v, 10);
  return out;
}

const EVIDENCE_MARKERS = /\b(according to|studies show|study|data|report|statistics|the (iea|icct|oecd|bls|un|who))\b/i;

// Pure scoring: claims + fallacy/dodge counts -> per-speaker sub-scores + total.
export function computeScores({ speakers, claims, fallacyCounts = {}, dodgeCounts = {}, rubric }) {
  const results = [];
  for (const speaker of speakers) {
    if (!speaker.tracked || speaker.isHost) continue;
    const mine = claims.filter((c) => c.speaker === speaker.name);
    const factual = mine.filter((c) => c.type === 'factual');
    const judged = factual.filter((c) => ['TRUE', 'FALSE', 'MISLEADING'].includes(c.verdict));

    // Accuracy: verified truthfulness of what they asserted (0-100; 60 neutral start).
    let accuracy = 60;
    if (judged.length > 0) {
      const points = judged.reduce(
        (sum, c) => sum + (c.verdict === 'TRUE' ? 1 : c.verdict === 'MISLEADING' ? 0.35 : 0),
        0,
      );
      accuracy = Math.round((points / judged.length) * 100);
    }

    // Evidence quality: claims backed by citations/sources vs bare assertion.
    let evidence = 55;
    if (factual.length > 0) {
      const backed = factual.filter(
        (c) => EVIDENCE_MARKERS.test(c.text) || c.verdict === 'TRUE' || (c.links || []).some((l) => l.relation === 'supports'),
      );
      evidence = Math.round((backed.length / factual.length) * 100);
    }

    // Logic: fallacies subtract; building support links adds.
    const supports = mine.filter((c) => (c.links || []).some((l) => l.relation === 'supports')).length;
    const logic = Math.max(0, Math.min(100, 70 - (fallacyCounts[speaker.name] || 0) * 15 + supports * 5));

    // Responsiveness: engaging the opponent's points adds; dodges subtract.
    const rebuts = mine.filter((c) => (c.links || []).some((l) => l.relation === 'rebuts')).length;
    const responsiveness = Math.max(0, Math.min(100, 65 + rebuts * 8 - (dodgeCounts[speaker.name] || 0) * 15));

    const subs = { accuracy, evidence, logic, responsiveness };
    const total =
      subs.accuracy * (rubric.accuracy ?? 0.25) +
      subs.evidence * (rubric.evidence ?? 0.25) +
      subs.logic * (rubric.logic ?? 0.25) +
      subs.responsiveness * (rubric.responsiveness ?? 0.25);

    results.push({ speaker: speaker.name, team: speaker.team, speakerId: speaker.id, subs, total: Math.round(total * 10) / 10 });
  }
  return results.sort((a, b) => b.total - a.total);
}

export async function computeSessionScores(sessionId, rubric) {
  const [speakers, claims, fallacyCounts, dodgeCounts] = await Promise.all([
    getSpeakers(sessionId),
    getClaims(sessionId),
    getCounts(sessionId, fallaciesKey),
    getCounts(sessionId, dodgesKey),
  ]);
  return computeScores({ speakers, claims, fallacyCounts, dodgeCounts, rubric });
}

export function startScorer(sessionId, { sessionConfig, intervalMs = config.scoreIntervalMs }) {
  let stopped = false;
  let running = false;

  async function snapshot({ force = false, reveal = false } = {}) {
    if (running) return null;
    running = true;
    try {
      const { getSession } = await import('../sessions/manager.js');
      const session = await getSession(sessionId);
      const cfg = session?.config && Object.keys(session.config).length ? session.config : sessionConfig;
      const visibility = cfg.scoring_visibility || 'off';
      if (visibility === 'off' && !force) return null;

      const scoringState = await getStateSlice(sessionId, 'scoring');
      if (scoringState?.paused && !force) return null;

      const scores = await computeSessionScores(sessionId, cfg.rubric || {});
      if (scores.length === 0) return null;

      const db = await getDb();
      for (const s of scores) {
        await db.query(
          'INSERT INTO scores (session_id, speaker_id, sub_scores, total) VALUES ($1,$2,$3,$4)',
          [sessionId, s.speakerId || s.speaker, JSON.stringify(s.subs), s.total],
        );
      }

      const payload = { scores, visibility, hold_ms: 6000 };
      await setStateSlice(sessionId, 'scoreboard', payload);
      // 'off' NEVER publishes (not even the final forced snapshot); 'end' only
      // publishes at the reveal moment; 'live' publishes every snapshot.
      if (visibility === 'live' || (visibility === 'end' && reveal)) {
        await publishEvent(sessionId, 'scoreboard', payload);
      }
      return scores;
    } catch (err) {
      logger.error('score snapshot failed', { sessionId, error: err.message });
      return null;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(snapshot, intervalMs);
  return {
    snapshot,
    async stop({ revealFinal = false } = {}) {
      stopped = true;
      clearInterval(timer);
      // Final snapshot; "end" visibility reveals here.
      return snapshot({ force: true, reveal: revealFinal });
    },
  };
}
