// Rolling transcript: Redis list (hot window for the extractor + reconnects),
// WS events for dashboards, batched writes to Postgres (SPEC §4.4 utterances).
import { getStore } from '../state/store.js';
import { getDb } from '../db/postgres.js';
import { publishEvent } from '../sessions/events.js';
import { setStateSlice } from '../sessions/manager.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const transcriptKey = (id) => `sess:${id}:transcript`;
const MAX_ENTRIES = 800; // ~an hour of debate finals; extractor cursor is a list index

const buffers = new Map(); // sessionId -> { rows: [], timer }

export async function addFinalUtterance(sessionId, { speakerId, speakerName, team, text, ts = Date.now() }) {
  const store = await getStore();
  const entry = { speakerId, speakerName, team: team ?? null, text, ts };
  const len = await store.rpush(transcriptKey(sessionId), JSON.stringify(entry));
  await store.expire(transcriptKey(sessionId), config.sessionTtlSec);
  if (len > MAX_ENTRIES + 100) {
    // Trim from the head; extractor cursors are monotonically increasing list
    // lengths, so trimming only affects long-finished history.
    const excess = len - MAX_ENTRIES;
    for (let i = 0; i < excess; i++) await store.lpop(transcriptKey(sessionId));
  }

  await setStateSlice(sessionId, 'speaker', { id: speakerId, name: speakerName, team: team ?? null });
  await publishEvent(sessionId, 'transcript', { speakerId, speaker: speakerName, team: team ?? null, text, final: true });

  queuePersist(sessionId, { speakerId, text, ts });
  return len; // acts as the extractor cursor position after this entry
}

export async function publishInterim(sessionId, { speakerName, text }) {
  await publishEvent(sessionId, 'transcript.interim', { speaker: speakerName, text, final: false });
}

// Extractor support: entries after cursor (a previous list length), new cursor.
export async function getTranscriptDelta(sessionId, cursor = 0) {
  const store = await getStore();
  const len = await store.llen(transcriptKey(sessionId));
  if (len <= cursor) return { entries: [], cursor: len };
  const raw = await store.lrange(transcriptKey(sessionId), cursor, len - 1);
  return { entries: raw.map((j) => JSON.parse(j)), cursor: len };
}

export async function getTranscriptTail(sessionId, count = 50) {
  const store = await getStore();
  const len = await store.llen(transcriptKey(sessionId));
  const raw = await store.lrange(transcriptKey(sessionId), Math.max(0, len - count), len - 1);
  return raw.map((j) => JSON.parse(j));
}

function queuePersist(sessionId, row) {
  let buf = buffers.get(sessionId);
  if (!buf) {
    buf = { rows: [], timer: null };
    buffers.set(sessionId, buf);
  }
  buf.rows.push(row);
  if (!buf.timer) {
    buf.timer = setTimeout(() => flushSession(sessionId), config.utteranceFlushMs);
    if (buf.timer.unref) buf.timer.unref();
  }
}

async function flushSession(sessionId) {
  const buf = buffers.get(sessionId);
  if (!buf) return;
  clearTimeout(buf.timer);
  buf.timer = null;
  const rows = buf.rows.splice(0);
  if (rows.length === 0) return;
  try {
    const db = await getDb();
    const values = [];
    const params = [];
    rows.forEach((r, i) => {
      const base = i * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(sessionId, r.speakerId || null, r.text, new Date(r.ts));
    });
    await db.query(
      `INSERT INTO utterances (session_id, speaker_id, text, ts) VALUES ${values.join(',')}`,
      params,
    );
  } catch (err) {
    logger.error('utterance flush failed', { sessionId, error: err.message, count: rows.length });
  }
}

// Called on shutdown (design contract #6) and at session end.
export async function flushAllTranscripts() {
  await Promise.allSettled([...buffers.keys()].map((id) => flushSession(id)));
  buffers.clear();
}

export async function flushTranscript(sessionId) {
  await flushSession(sessionId);
  buffers.delete(sessionId);
}
