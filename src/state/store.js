// Store facade: ioredis-backed when REDIS_URL is set (Upstash in prod, ADR-0003),
// in-memory otherwise (ADR-0005). All app code talks to this interface only.
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createMemoryStore } from './memoryStore.js';

let storeInstance = null;

function createRedisStore(url) {
  // Lazy import so the dependency is only touched when actually configured.
  return import('ioredis').then(({ default: Redis }) => {
    const opts = { maxRetriesPerRequest: 3, lazyConnect: false, enableOfflineQueue: true };
    if (url.startsWith('rediss://')) opts.tls = {};
    const client = new Redis(url, opts);
    const subscriber = new Redis(url, opts); // pub/sub needs a dedicated connection
    client.on('error', (err) => logger.error('redis error', { error: err.message }));
    subscriber.on('error', (err) => logger.error('redis subscriber error', { error: err.message }));

    const handlers = new Map(); // channel -> Set(handler)
    subscriber.on('message', (channel, message) => {
      const set = handlers.get(channel);
      if (set) for (const h of set) h(message);
    });

    return {
      kind: 'redis',
      get: (k) => client.get(k),
      set: (k, v, ttlSec) => (ttlSec ? client.set(k, v, 'EX', ttlSec) : client.set(k, v)),
      del: (k) => client.del(k),
      incr: (k) => client.incr(k),
      expire: (k, ttl) => client.expire(k, ttl),
      hset: (k, f, v) => client.hset(k, f, v),
      hget: (k, f) => client.hget(k, f),
      hgetall: (k) => client.hgetall(k),
      hdel: (k, f) => client.hdel(k, f),
      rpush: (k, ...vals) => client.rpush(k, ...vals),
      lpop: (k) => client.lpop(k),
      llen: (k) => client.llen(k),
      lrange: (k, start, stop) => client.lrange(k, start, stop),
      zadd: (k, score, member) => client.zadd(k, score, member),
      zrangebyscore: (k, min, max) => client.zrangebyscore(k, min, max),
      zremrangebyscore: (k, min, max) => client.zremrangebyscore(k, min, max),
      zcard: (k) => client.zcard(k),
      publish: (channel, message) => client.publish(channel, message),
      async subscribe(channel, handler) {
        if (!handlers.has(channel)) {
          handlers.set(channel, new Set());
          await subscriber.subscribe(channel);
        }
        handlers.get(channel).add(handler);
        return async () => {
          const set = handlers.get(channel);
          if (!set) return;
          set.delete(handler);
          if (set.size === 0) {
            handlers.delete(channel);
            await subscriber.unsubscribe(channel);
          }
        };
      },
      async close() {
        await client.quit().catch(() => {});
        await subscriber.quit().catch(() => {});
      },
    };
  });
}

export async function getStore() {
  if (!storeInstance) {
    storeInstance = config.redisUrl ? await createRedisStore(config.redisUrl) : createMemoryStore();
    logger.info('store initialized', { kind: storeInstance.kind });
  }
  return storeInstance;
}

export async function closeStore() {
  if (storeInstance) {
    await storeInstance.close();
    storeInstance = null;
  }
}

// Test hook: swap in a fresh store (memory) for isolation.
export function _resetStoreForTests(store) {
  storeInstance = store ?? null;
}
