// Session lifecycle + hot-state snapshot. Hot state lives in Redis so any
// container instance (or a restarted one) can serve any session (contract #3).
import { randomUUID } from 'node:crypto';
import { getStore } from '../state/store.js';
import { getDb } from '../db/postgres.js';
import { publishEvent, getLastSeq } from './events.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const metaKey = (id) => `sess:${id}:meta`;
const stateKey = (id) => `sess:${id}:state`; // hash of display/pipeline hot state slices (JSON per field)

export async function createSession({ meetingUrl, config: sessionConfig = {}, speakers = [], motion = '' }) {
  if (!meetingUrl) throw Object.assign(new Error('meetingUrl is required'), { status: 400 });
  const id = randomUUID().slice(0, 8);
  const store = await getStore();
  const db = await getDb();
  const meta = {
    id,
    meetingUrl,
    config: sessionConfig,
    speakers,
    motion,
    status: 'created',
    createdAt: Date.now(),
  };
  await store.set(metaKey(id), JSON.stringify(meta), config.sessionTtlSec);
  await db.query('INSERT INTO sessions (id, meeting_url, config, status) VALUES ($1,$2,$3,$4)', [
    id,
    meetingUrl,
    JSON.stringify({ ...sessionConfig, speakers, motion }),
    'created',
  ]);
  await publishEvent(id, 'session.status', { status: 'created' });
  logger.info('session created', { sessionId: id });
  return meta;
}

export async function getSession(id) {
  const store = await getStore();
  const raw = await store.get(metaKey(id));
  return raw ? JSON.parse(raw) : null;
}

export async function updateSession(id, patch) {
  const store = await getStore();
  const meta = await getSession(id);
  if (!meta) return null;
  const next = { ...meta, ...patch };
  await store.set(metaKey(id), JSON.stringify(next), config.sessionTtlSec);
  return next;
}

export async function setSessionStatus(id, status) {
  const db = await getDb();
  const meta = await updateSession(id, { status });
  if (!meta) return null;
  const col = status === 'live' ? 'started_at' : status === 'ended' ? 'ended_at' : null;
  await db.query(
    col
      ? `UPDATE sessions SET status=$2, ${col}=now() WHERE id=$1`
      : 'UPDATE sessions SET status=$2 WHERE id=$1',
    [id, status],
  );
  await publishEvent(id, 'session.status', { status });
  return meta;
}

// Hot-state slices: named JSON fragments (scores, turnclock, speaker, pending, …)
// written by the pipeline, read back for the reconnect snapshot.
export async function setStateSlice(id, slice, value) {
  const store = await getStore();
  await store.hset(stateKey(id), slice, JSON.stringify(value));
  await store.expire(stateKey(id), config.sessionTtlSec);
}

export async function getStateSlice(id, slice) {
  const store = await getStore();
  const raw = await store.hget(stateKey(id), slice);
  return raw ? JSON.parse(raw) : null;
}

// Snapshot = everything a display/dashboard needs to render after (re)connecting.
export async function getSnapshot(id) {
  const meta = await getSession(id);
  if (!meta) return null;
  const store = await getStore();
  const slices = await store.hgetall(stateKey(id));
  const state = {};
  for (const [k, v] of Object.entries(slices)) {
    try {
      state[k] = JSON.parse(v);
    } catch {
      /* skip corrupt slice */
    }
  }
  const lastSeq = await getLastSeq(id);
  return { session: meta, state, lastSeq };
}
