// Argument graph: claims are nodes; supports/rebuts links are edges.
// Hot copy in Redis (drives the stage-mode map + extractor dedupe/links);
// persisted to Postgres claims/verdicts tables (SPEC §4.4).
import { randomUUID } from 'node:crypto';
import { getStore } from '../state/store.js';
import { getDb } from '../db/postgres.js';
import { config } from '../config.js';

const claimsKey = (id) => `sess:${id}:claims`;

export function normalizeClaimText(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function findDuplicate(sessionId, text) {
  const norm = normalizeClaimText(text);
  if (!norm) return null;
  const existing = await getClaims(sessionId);
  return (
    existing.find((c) => {
      const other = normalizeClaimText(c.text);
      return other === norm || other.includes(norm) || norm.includes(other);
    }) || null
  );
}

export async function addClaim(sessionId, { text, speaker, speakerId, type, checkable, links = [] }) {
  const store = await getStore();
  const claim = {
    id: randomUUID().slice(0, 8),
    sessionId,
    text,
    speaker,
    speakerId: speakerId ?? null,
    type,
    checkable: !!checkable,
    links, // [{relation, targetClaimId}]
    verdict: checkable ? 'UNVERIFIED' : null,
    confidence: null,
    createdAt: Date.now(),
  };
  await store.hset(claimsKey(sessionId), claim.id, JSON.stringify(claim));
  await store.expire(claimsKey(sessionId), config.sessionTtlSec);

  const db = await getDb();
  await db.query(
    'INSERT INTO claims (id, session_id, speaker_id, text, type, checkable, graph_links) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
    [claim.id, sessionId, claim.speakerId, text, type, claim.checkable, JSON.stringify(links)],
  );
  return claim;
}

export async function getClaims(sessionId) {
  const store = await getStore();
  const all = await store.hgetall(claimsKey(sessionId));
  return Object.values(all)
    .map((raw) => JSON.parse(raw))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function getClaim(sessionId, claimId) {
  const store = await getStore();
  const raw = await store.hget(claimsKey(sessionId), claimId);
  return raw ? JSON.parse(raw) : null;
}

export async function setClaimVerdict(sessionId, claimId, { verdict, confidence, evidence_summary, sources }) {
  const store = await getStore();
  const claim = await getClaim(sessionId, claimId);
  if (!claim) return null;
  const updated = { ...claim, verdict, confidence, evidence_summary, sources };
  await store.hset(claimsKey(sessionId), claimId, JSON.stringify(updated));

  const db = await getDb();
  await db.query(
    'INSERT INTO verdicts (claim_id, verdict, confidence, evidence_summary, sources) VALUES ($1,$2,$3,$4,$5)',
    [claimId, verdict, confidence ?? 0, evidence_summary ?? null, JSON.stringify(sources ?? [])],
  );
  return updated;
}

// Resolve LLM-provided link target texts to claim ids (best-effort).
export async function resolveLinks(sessionId, rawLinks) {
  if (!rawLinks || rawLinks.length === 0) return [];
  const claims = await getClaims(sessionId);
  const links = [];
  for (const link of rawLinks) {
    const targetNorm = normalizeClaimText(link.target_text || '');
    if (!targetNorm) continue;
    const target = claims.find((c) => {
      const other = normalizeClaimText(c.text);
      return other === targetNorm || other.includes(targetNorm) || targetNorm.includes(other);
    });
    if (target) links.push({ relation: link.relation, targetClaimId: target.id });
  }
  return links;
}
