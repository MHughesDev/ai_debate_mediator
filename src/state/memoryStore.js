// In-memory implementation of the Store interface (ADR-0005).
// Mirrors exactly the command subset the app uses against Redis, including
// pub/sub and key expiry. Dev/test only — production sets REDIS_URL.
import { EventEmitter } from 'node:events';

export function createMemoryStore() {
  const kv = new Map(); // key -> { value, expiresAt|null }
  const hashes = new Map(); // key -> Map(field -> value)
  const lists = new Map(); // key -> array
  const zsets = new Map(); // key -> Map(member -> score)
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  function alive(entry) {
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) return false;
    return true;
  }

  return {
    kind: 'memory',

    async get(key) {
      const e = kv.get(key);
      if (!alive(e)) {
        kv.delete(key);
        return null;
      }
      return e.value;
    },
    async set(key, value, ttlSec) {
      kv.set(key, { value: String(value), expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : null });
    },
    async del(key) {
      kv.delete(key);
      hashes.delete(key);
      lists.delete(key);
      zsets.delete(key);
    },
    async incr(key) {
      const e = kv.get(key);
      const cur = alive(e) ? parseInt(e.value, 10) || 0 : 0;
      const next = cur + 1;
      kv.set(key, { value: String(next), expiresAt: alive(e) ? e.expiresAt : null });
      return next;
    },
    async expire(key, ttlSec) {
      const e = kv.get(key);
      if (e) e.expiresAt = Date.now() + ttlSec * 1000;
    },

    async hset(key, field, value) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key).set(field, String(value));
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hgetall(key) {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h.entries());
    },
    async hdel(key, field) {
      hashes.get(key)?.delete(field);
    },

    async rpush(key, ...values) {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key).push(...values.map(String));
      return lists.get(key).length;
    },
    async lpop(key) {
      const l = lists.get(key);
      if (!l || l.length === 0) return null;
      return l.shift();
    },
    async llen(key) {
      return lists.get(key)?.length ?? 0;
    },
    async lrange(key, start, stop) {
      const l = lists.get(key) ?? [];
      const end = stop === -1 ? l.length : stop + 1;
      return l.slice(start, end);
    },

    async zadd(key, score, member) {
      if (!zsets.has(key)) zsets.set(key, new Map());
      zsets.get(key).set(String(member), score);
    },
    async zrangebyscore(key, min, max) {
      const z = zsets.get(key);
      if (!z) return [];
      return [...z.entries()]
        .filter(([, s]) => s >= min && s <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([m]) => m);
    },
    async zremrangebyscore(key, min, max) {
      const z = zsets.get(key);
      if (!z) return;
      for (const [m, s] of z.entries()) if (s >= min && s <= max) z.delete(m);
    },
    async zcard(key) {
      return zsets.get(key)?.size ?? 0;
    },

    async publish(channel, message) {
      bus.emit(channel, message);
    },
    // Returns an unsubscribe function.
    async subscribe(channel, handler) {
      bus.on(channel, handler);
      return () => bus.off(channel, handler);
    },

    async close() {
      bus.removeAllListeners();
    },
  };
}
