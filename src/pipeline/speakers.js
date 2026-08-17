// Speaker registry: platform participant identity -> speaker record.
// Platform identity is preferred over diarization (SPEC risk table). Team and
// display-name overrides come from the launcher config on the session.
import { randomUUID } from 'node:crypto';
import { getStore } from '../state/store.js';
import { getDb } from '../db/postgres.js';
import { getSession } from '../sessions/manager.js';
import { publishEvent } from '../sessions/events.js';
import { config } from '../config.js';

const speakersKey = (id) => `sess:${id}:speakers`;

export async function ensureSpeaker(sessionId, { participantId, name, isHost = false }) {
  const store = await getStore();
  const existingRaw = await store.hget(speakersKey(sessionId), participantId);
  if (existingRaw) return JSON.parse(existingRaw);

  const session = await getSession(sessionId);
  // Launcher-configured speakers: [{name, team}] — matched case-insensitively.
  const configured = (session?.speakers || []).find(
    (s) => s.name && name && s.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );

  const speaker = {
    id: randomUUID().slice(0, 8),
    participantId,
    name: configured?.name || name || 'Unknown',
    team: configured?.team || null,
    isHost,
    tracked: !!configured || !isHost, // hosts not in the roster are untracked (not scored)
  };
  await store.hset(speakersKey(sessionId), participantId, JSON.stringify(speaker));
  await store.expire(speakersKey(sessionId), config.sessionTtlSec);

  const db = await getDb();
  await db.query(
    'INSERT INTO speakers (id, session_id, platform_participant_id, display_name, team) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
    [speaker.id, sessionId, participantId, speaker.name, speaker.team],
  );
  await publishEvent(sessionId, 'speaker.joined', { speaker });
  return speaker;
}

export async function getSpeaker(sessionId, participantId) {
  const store = await getStore();
  const raw = await store.hget(speakersKey(sessionId), participantId);
  return raw ? JSON.parse(raw) : null;
}

export async function getSpeakers(sessionId) {
  const store = await getStore();
  const all = await store.hgetall(speakersKey(sessionId));
  return Object.values(all).map((raw) => JSON.parse(raw));
}
