// Session event bus. Every displayable/pipeline event flows through here:
// monotonic per-session seq -> Redis backlog (bounded, for reconnect replay)
// -> pub/sub -> WS hub fanout. Design contract #4: clients rehydrate from
// this backlog + snapshot after any disconnect or server restart.
import { getStore } from '../state/store.js';
import { config } from '../config.js';

const seqKey = (id) => `sess:${id}:seq`;
const backlogKey = (id) => `sess:${id}:backlog`;
const channel = (id) => `sess:${id}:events`;

export async function publishEvent(sessionId, type, payload = {}) {
  const store = await getStore();
  const seq = await store.incr(seqKey(sessionId));
  const event = { seq, type, ts: Date.now(), ...payload };
  const json = JSON.stringify(event);
  await store.zadd(backlogKey(sessionId), seq, json);
  // Trim backlog to the newest eventBacklogSize entries.
  const excess = seq - config.eventBacklogSize;
  if (excess > 0) await store.zremrangebyscore(backlogKey(sessionId), 0, excess);
  await store.expire(backlogKey(sessionId), config.sessionTtlSec);
  await store.set(seqKey(sessionId), String(seq), config.sessionTtlSec);
  await store.publish(channel(sessionId), json);
  return event;
}

export async function getLastSeq(sessionId) {
  const store = await getStore();
  return parseInt((await store.get(seqKey(sessionId))) || '0', 10);
}

export async function getEventsSince(sessionId, sinceSeq) {
  const store = await getStore();
  const raw = await store.zrangebyscore(backlogKey(sessionId), sinceSeq + 1, Number.MAX_SAFE_INTEGER);
  return raw.map((j) => JSON.parse(j));
}

// handler receives the parsed event object. Returns an async unsubscribe fn.
export async function subscribeSession(sessionId, handler) {
  const store = await getStore();
  return store.subscribe(channel(sessionId), (json) => {
    let event;
    try {
      event = JSON.parse(json);
    } catch {
      return;
    }
    handler(event);
  });
}
