import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, createTestSession, waitFor } from './helpers.js';
import { startSessionPipeline } from '../src/pipeline/session.js';
import { stopPipeline } from '../src/pipeline/runtime.js';
import { createMockMeetingProvider } from '../src/providers/meeting/mock.js';
import { createMockSttProvider } from '../src/providers/stt/mock.js';
import { createMockLlm } from '../src/providers/llm/mock.js';
import { createMockSearchProvider } from '../src/providers/search/mock.js';
import { recordLlmUsage, recordSearch, recordBotSeconds, recordSttSeconds, getCounters, estimateCost } from '../src/pipeline/costMeter.js';
import { getDb } from '../src/db/postgres.js';

test('cost meter: counters accumulate and estimate uses per-model rates', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);

  await recordLlmUsage(session.id, 'claude-haiku-4-5', 10000, 2000);
  await recordLlmUsage(session.id, 'claude-haiku-4-5', 5000, 1000);
  await recordLlmUsage(session.id, 'claude-opus-5', 8000, 1500);
  await recordSearch(session.id, 4);
  await recordBotSeconds(session.id, 3600);
  await recordSttSeconds(session.id, 7200);

  const counters = await getCounters(session.id);
  assert.equal(counters['llm_in:claude-haiku-4-5'], 15000);
  assert.equal(counters['llm_out:claude-haiku-4-5'], 3000);
  assert.equal(counters.llm_calls, 3);
  assert.equal(counters.search_calls, 4);

  const estimate = estimateCost(counters);
  // bot 1h (~0.85) + stt 2h (~0.9) + 4 searches (0.02) + haiku (15k in / 3k out)
  // + opus (8k in / 1.5k out) => ~1.86
  assert.ok(estimate > 1.5 && estimate < 2.5, `estimate in expected band (got ${estimate})`);
});

test('phase5 e2e: a full run records costs, persists them, serves the API', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    config: { preset: 'oxford' },
    speakers: [
      { name: 'Alex Rivera', team: 'Proposition' },
      { name: 'Jordan Blake', team: 'Opposition' },
    ],
  });

  await startSessionPipeline(session.id, {
    meetingProvider: createMockMeetingProvider({ speedFactor: 50 }),
    sttProvider: createMockSttProvider({ latencyMs: 5 }),
    brainOptions: {
      llm: createMockLlm(),
      searchProvider: createMockSearchProvider({ latencyMs: 5 }),
      extractIntervalMs: 150,
      scoreIntervalMs: 400,
    },
  });
  t.after(() => stopPipeline(session.id));

  await waitFor(async () => {
    const meta = await fetch(`${srv.baseUrl}/api/sessions/${session.id}`).then((r) => r.json());
    return meta.status === 'ended';
  }, { timeoutMs: 25000 });

  const costs = await (await fetch(`${srv.baseUrl}/api/sessions/${session.id}/costs`)).json();
  assert.ok(costs.counters.search_calls >= 4, 'searches counted');
  assert.ok(costs.counters.bot_seconds >= 1, 'bot time counted');
  assert.equal(typeof costs.estimate_usd, 'number');

  const db = await getDb();
  assert.ok(db.writes.some((w) => w.text.includes('INSERT INTO session_costs')), 'costs persisted');

  const receipts = await (await fetch(`${srv.baseUrl}/api/sessions/${session.id}/receipts`)).json();
  assert.ok('cost_estimate_usd' in receipts, 'receipts carry the cost estimate');
});
