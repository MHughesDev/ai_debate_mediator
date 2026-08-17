// Post-debate receipts (SPEC §3.7): final scores, most/least accurate,
// biggest unsupported claim, unanswered questions. Stats are computed from
// the graph + scores; the LLM writes the narrative fields; everything is
// persisted and pushed as the display's terminal state.
import { getClaims } from './argumentGraph.js';
import { computeSessionScores } from './scoreEngine.js';
import { getSession, setStateSlice } from '../sessions/manager.js';
import { publishEvent } from '../sessions/events.js';
import { getDb } from '../db/postgres.js';
import { logger } from '../logger.js';

export async function buildReceiptStats(sessionId, { dodgeStats } = {}) {
  const session = await getSession(sessionId);
  const rubric = session?.config?.rubric || {};
  const [claims, scores] = await Promise.all([getClaims(sessionId), computeSessionScores(sessionId, rubric)]);

  const factual = claims.filter((c) => c.type === 'factual');
  const verdictCounts = {};
  for (const c of factual) {
    if (!c.verdict) continue;
    verdictCounts[c.verdict] = (verdictCounts[c.verdict] || 0) + 1;
  }

  // "Biggest unsupported claim": prefer a confirmed FALSE, else a checkable
  // factual claim that verification could not support.
  const falseClaim = factual.find((c) => c.verdict === 'FALSE');
  const unsupported =
    falseClaim || factual.find((c) => c.checkable && ['UNVERIFIED', 'UNVERIFIABLE'].includes(c.verdict));

  const questions = claims.filter((c) => c.type === 'question');

  return {
    motion: session?.motion || '',
    speakers: scores,
    claims_total: claims.length,
    factual_claims: factual.length,
    verdict_counts: verdictCounts,
    biggest_unsupported_claim: unsupported?.text || null,
    unanswered_questions: dodgeStats ? dodgeStats.dodged + dodgeStats.unansweredAtEnd : questions.length ? undefined : 0,
    questions_asked: questions.length,
  };
}

export async function generateAndPublishReceipts(sessionId, { llm, dodgeStats }) {
  try {
    const session = await getSession(sessionId);
    if (session?.config?.display?.receipts === false) return null;

    const stats = await buildReceiptStats(sessionId, { dodgeStats });
    if (!stats.speakers.length) return null;

    const narrative = await llm.generateReceipts({ sessionId, motion: stats.motion, stats });
    const { persistCosts } = await import('./costMeter.js');
    const costs = await persistCosts(sessionId).catch(() => null);
    const receipts = {
      ...narrative,
      final_scores: stats.speakers.map((s) => ({ speaker: s.speaker, team: s.team, total: s.total, subs: s.subs })),
      verdict_counts: stats.verdict_counts,
      biggest_unsupported_claim: narrative.biggest_unsupported_claim ?? stats.biggest_unsupported_claim,
      unanswered_questions: stats.unanswered_questions ?? 0,
      cost_estimate_usd: costs?.estimate ?? null,
      generatedAt: Date.now(),
    };

    const db = await getDb();
    await db.query(
      'INSERT INTO receipts (session_id, summary) VALUES ($1,$2) ON CONFLICT (session_id) DO UPDATE SET summary = $2',
      [sessionId, JSON.stringify(receipts)],
    );
    await setStateSlice(sessionId, 'receipts', receipts);
    await publishEvent(sessionId, 'receipts', receipts);
    logger.info('receipts published', { sessionId });
    return receipts;
  } catch (err) {
    logger.error('receipts generation failed', { sessionId, error: err.message });
    return null;
  }
}

export async function getReceipts(sessionId) {
  const { getStateSlice } = await import('../sessions/manager.js');
  return getStateSlice(sessionId, 'receipts');
}
