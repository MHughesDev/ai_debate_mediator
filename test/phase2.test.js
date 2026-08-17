import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setupTestServer, createTestSession, waitFor } from './helpers.js';
import { startSessionPipeline } from '../src/pipeline/session.js';
import { stopPipeline } from '../src/pipeline/runtime.js';
import { createMockMeetingProvider } from '../src/providers/meeting/mock.js';
import { createMockSttProvider } from '../src/providers/stt/mock.js';
import { createMockLlm } from '../src/providers/llm/mock.js';
import { createMockSearchProvider } from '../src/providers/search/mock.js';
import { gateVerdict } from '../src/pipeline/verifier.js';
import { getClaims, normalizeClaimText } from '../src/pipeline/argumentGraph.js';
import { getDb } from '../src/db/postgres.js';

const SRC = { name: 'S', url: 'https://example.org' };

test('gateVerdict enforces every credibility rule', () => {
  // Rule 2: displayable verdicts without sources degrade to UNVERIFIED
  assert.equal(gateVerdict({ verdict: 'TRUE', confidence: 0.99, sources: [] }).verdict, 'UNVERIFIED');
  assert.equal(gateVerdict({ verdict: 'FALSE', confidence: 0.99, sources: [] }).verdict, 'UNVERIFIED');

  // Rule 1: below general threshold -> UNVERIFIED
  assert.equal(gateVerdict({ verdict: 'TRUE', confidence: 0.4, sources: [SRC] }).verdict, 'UNVERIFIED');
  assert.equal(gateVerdict({ verdict: 'MISLEADING', confidence: 0.5, sources: [SRC] }).verdict, 'UNVERIFIED');

  // Rule 3: FALSE needs the higher bar (default 0.85)
  assert.equal(gateVerdict({ verdict: 'FALSE', confidence: 0.7, sources: [SRC] }).verdict, 'UNVERIFIED');
  assert.equal(gateVerdict({ verdict: 'FALSE', confidence: 0.9, sources: [SRC] }).verdict, 'FALSE');
  // ...and the bar is configurable per preset
  assert.equal(
    gateVerdict({ verdict: 'FALSE', confidence: 0.9, sources: [SRC] }, { false_verdict_min_confidence: 0.95 }).verdict,
    'UNVERIFIED',
  );

  // Passing verdicts flow through untouched
  const ok = gateVerdict({ verdict: 'TRUE', confidence: 0.92, evidence_summary: 'e', sources: [SRC] });
  assert.deepEqual(ok, { verdict: 'TRUE', confidence: 0.92, evidence_summary: 'e', sources: [SRC] });

  // UNVERIFIABLE needs no sources (it asserts nothing)
  assert.equal(gateVerdict({ verdict: 'UNVERIFIABLE', confidence: 0.5, sources: [] }).verdict, 'UNVERIFIABLE');

  // Garbage verdicts never reach the screen
  assert.equal(gateVerdict({ verdict: 'PROBABLY', confidence: 0.9, sources: [SRC] }).verdict, 'UNVERIFIED');
  assert.equal(gateVerdict(null).verdict, 'UNVERIFIED');
});

test('mock llm classifies fixture-style utterances', async () => {
  const llm = createMockLlm();
  const speakers = ['Alex Rivera', 'Jordan Blake'];
  const { claims, fallacies } = await llm.extractClaims({
    speakers,
    chunkText: [
      'Alex Rivera: Global electric vehicle sales tripled between 2020 and 2023, according to the International Energy Agency.',
      'Jordan Blake: Alex, what happens to the used gasoline fleet after 2035 — who pays for stranding millions of working cars?',
      'Alex Rivera: I believe a firm deadline is the fairest policy for industry.',
      'Jordan Blake: I predict the 2035 targets will quietly slip to 2040 within two years.',
      "Jordan Blake: Of course Alex would say that — someone who has never worked a day in the auto industry and clearly doesn't understand real engineering.",
    ].join('\n'),
  });

  const types = Object.fromEntries(claims.map((c) => [c.type, c]));
  assert.ok(types.factual?.checkable, 'factual claim is checkable');
  assert.ok(types.question, 'question detected');
  assert.ok(types.opinion, 'opinion detected');
  assert.ok(types.prediction, 'prediction detected');
  assert.equal(fallacies.length, 1);
  assert.equal(fallacies[0].label, 'Ad hominem');
});

test('mock search corpus answers fixture claims', async () => {
  const search = createMockSearchProvider({ latencyMs: 1 });
  const wall = await search.search('the Great Wall of China is visible from the Moon');
  assert.equal(wall[0]._verdictHint, 'FALSE');
  const nothing = await search.search('completely unrelated nonsense query');
  assert.equal(nothing.length, 0);
});

test('phase2 e2e: false claim -> FALSE card with source; full pipeline works', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    motion: 'Ban gasoline car sales by 2035',
    speakers: [
      { name: 'Alex Rivera', team: 'Proposition' },
      { name: 'Jordan Blake', team: 'Opposition' },
    ],
  });

  const ws = new WebSocket(`${srv.wsUrl}/ws?session=${session.id}&role=dashboard`);
  const events = [];
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));

  await startSessionPipeline(session.id, {
    meetingProvider: createMockMeetingProvider({ speedFactor: 50 }),
    sttProvider: createMockSttProvider({ latencyMs: 5 }),
    brainOptions: {
      llm: createMockLlm(),
      searchProvider: createMockSearchProvider({ latencyMs: 5 }),
      extractIntervalMs: 150,
    },
  });
  t.after(() => stopPipeline(session.id));

  // The scripted FALSE claim (Great Wall) must produce a FALSE card w/ source.
  await waitFor(
    () => events.some((e) => e.type === 'factcheck' && e.verdict === 'FALSE' && /great wall/i.test(e.claim)),
    { timeoutMs: 20000 },
  );
  const falseCard = events.find((e) => e.type === 'factcheck' && e.verdict === 'FALSE' && /great wall/i.test(e.claim));
  assert.ok(falseCard.sources.length >= 1, 'FALSE card carries a source');
  assert.match(falseCard.sources[0].name, /NASA/i);
  assert.ok(falseCard.confidence >= 0.85);

  // TRUE and MISLEADING cards also arrive.
  await waitFor(() => events.some((e) => e.type === 'factcheck' && e.verdict === 'TRUE'), { timeoutMs: 20000 });
  await waitFor(() => events.some((e) => e.type === 'factcheck' && e.verdict === 'MISLEADING'), { timeoutMs: 20000 });

  // Fallacy flag (high confidence ad hominem from the fixture).
  await waitFor(() => events.some((e) => e.type === 'flag' && e.kind === 'fallacy'), { timeoutMs: 20000 });

  // Pending indicator moved.
  assert.ok(events.some((e) => e.type === 'verification.pending' && e.count > 0));
  // Transparency "thoughts" were visible.
  assert.ok(events.some((e) => e.type === 'thought'));

  // Claims exist in the graph; checkable ones got verdicts.
  const claims = await getClaims(session.id);
  assert.ok(claims.length >= 5, `graph has claims (got ${claims.length})`);
  const checkable = claims.filter((c) => c.checkable);
  assert.ok(checkable.length >= 3);

  // Durable persistence happened for claims and verdicts.
  const db = await getDb();
  assert.ok(db.writes.some((w) => w.text.includes('INSERT INTO claims')));
  assert.ok(db.writes.some((w) => w.text.includes('INSERT INTO verdicts')));
  ws.close();
});

test('phase2: duplicate claims are not re-added', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);
  const { addClaim, findDuplicate } = await import('../src/pipeline/argumentGraph.js');
  await addClaim(session.id, { text: 'EV sales tripled between 2020 and 2023.', speaker: 'A', type: 'factual', checkable: true });
  const dup = await findDuplicate(session.id, 'EV sales tripled between 2020 and 2023');
  assert.ok(dup, 'normalized duplicate detected');
  assert.equal(normalizeClaimText('  EV Sales, TRIPLED!! '), 'ev sales tripled');
});
