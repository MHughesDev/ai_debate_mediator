import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetStoreForTests } from '../src/state/store.js';
import { createMemoryStore } from '../src/state/memoryStore.js';
import { publishEvent, getLastSeq, getEventsSince, subscribeSession } from '../src/sessions/events.js';

test.beforeEach(() => _resetStoreForTests(createMemoryStore()));

test('events get monotonic sequence numbers per session', async () => {
  const e1 = await publishEvent('s1', 'factcheck', { claim: 'x' });
  const e2 = await publishEvent('s1', 'scoreboard', {});
  const other = await publishEvent('s2', 'factcheck', {});
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(other.seq, 1);
  assert.equal(await getLastSeq('s1'), 2);
});

test('backlog replay returns only events after the requested seq', async () => {
  for (let i = 0; i < 5; i++) await publishEvent('s1', 'transcript', { i });
  const missed = await getEventsSince('s1', 2);
  assert.deepEqual(missed.map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(missed.map((e) => e.i), [2, 3, 4]);
});

test('subscribers receive published events', async () => {
  const seen = [];
  const unsub = await subscribeSession('s1', (e) => seen.push(e));
  await publishEvent('s1', 'flag', { label: 'Strawman' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'flag');
  assert.equal(seen[0].label, 'Strawman');
  await unsub();
});
