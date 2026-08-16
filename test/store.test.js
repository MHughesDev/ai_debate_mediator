import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/state/memoryStore.js';

test('memory store: kv with ttl and incr', async () => {
  const s = createMemoryStore();
  await s.set('a', 'hello');
  assert.equal(await s.get('a'), 'hello');
  await s.set('b', 'x', 0.03); // 30ms ttl
  assert.equal(await s.get('b'), 'x');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await s.get('b'), null);
  assert.equal(await s.incr('n'), 1);
  assert.equal(await s.incr('n'), 2);
});

test('memory store: hashes and lists', async () => {
  const s = createMemoryStore();
  await s.hset('h', 'f1', 'v1');
  await s.hset('h', 'f2', 'v2');
  assert.equal(await s.hget('h', 'f1'), 'v1');
  assert.deepEqual(await s.hgetall('h'), { f1: 'v1', f2: 'v2' });
  await s.hdel('h', 'f1');
  assert.equal(await s.hget('h', 'f1'), null);

  await s.rpush('l', 'a', 'b', 'c');
  assert.equal(await s.llen('l'), 3);
  assert.equal(await s.lpop('l'), 'a');
  assert.deepEqual(await s.lrange('l', 0, -1), ['b', 'c']);
});

test('memory store: zsets ordered by score', async () => {
  const s = createMemoryStore();
  await s.zadd('z', 3, 'three');
  await s.zadd('z', 1, 'one');
  await s.zadd('z', 2, 'two');
  assert.deepEqual(await s.zrangebyscore('z', 2, 10), ['two', 'three']);
  await s.zremrangebyscore('z', 0, 2);
  assert.deepEqual(await s.zrangebyscore('z', 0, 10), ['three']);
});

test('memory store: pub/sub with unsubscribe', async () => {
  const s = createMemoryStore();
  const seen = [];
  const unsub = await s.subscribe('ch', (m) => seen.push(m));
  await s.publish('ch', 'one');
  await s.publish('other', 'ignored');
  unsub();
  await s.publish('ch', 'two');
  assert.deepEqual(seen, ['one']);
});
