import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, createTestSession, waitFor, openEventCollector } from './helpers.js';
import { startSessionPipeline } from '../src/pipeline/session.js';
import { stopPipeline } from '../src/pipeline/runtime.js';
import { createMockMeetingProvider } from '../src/providers/meeting/mock.js';
import { createMockSttProvider } from '../src/providers/stt/mock.js';
import { createMockLlm } from '../src/providers/llm/mock.js';
import { createMockSearchProvider } from '../src/providers/search/mock.js';
import { contentWords, answersQuestion, startDodgeTracker } from '../src/pipeline/dodge.js';
import { addFinalUtterance } from '../src/pipeline/transcript.js';
import { publishEvent } from '../src/sessions/events.js';
import { getDb } from '../src/db/postgres.js';

test('dodge: answer matching uses content-word overlap', () => {
  const q = 'What happens to the used gasoline fleet after 2035 — who pays for stranding millions of cars?';
  assert.ok(answersQuestion(q, 'The gasoline fleet will be phased out and owners compensated for stranding costs.'));
  assert.ok(!answersQuestion(q, 'Lifecycle studies show EVs emit far less CO2.'));
  assert.ok(contentWords('the a is').size === 0, 'stopwords removed');
});

test('dodge: unanswered question fires a dodge; answered one does not', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    speakers: [{ name: 'A', team: 'X' }, { name: 'B', team: 'Y' }],
  });
  // Register speakers via the registry (dodge charges tracked non-askers).
  const { ensureSpeaker } = await import('../src/pipeline/speakers.js');
  await ensureSpeaker(session.id, { participantId: 'p1', name: 'A' });
  await ensureSpeaker(session.id, { participantId: 'p2', name: 'B' });

  const { events } = await openEventCollector(srv.wsUrl, session.id);
  const tracker = startDodgeTracker(session.id, { enabled: true, timeoutMs: 300, flagDodges: true });
  t.after(() => tracker.stop());

  // Question 1: goes unanswered -> dodge flag against B.
  tracker.trackQuestion({ id: 'q1', text: 'Who pays for stranding the gasoline fleet after the ban?', speaker: 'A' });
  await waitFor(() => events.some((e) => e.type === 'flag' && e.kind === 'dodge'), { timeoutMs: 3000 });
  assert.equal(tracker.stats().dodged, 1);

  // Question 2: B answers with overlapping content before the timer -> no new dodge.
  tracker.trackQuestion({ id: 'q2', text: 'How will charging infrastructure reach rural drivers?', speaker: 'A' });
  await addFinalUtterance(session.id, {
    speakerId: 's2',
    speakerName: 'B',
    team: 'Y',
    text: 'Rural charging infrastructure will be funded through the highway program, reaching drivers everywhere.',
  });
  await waitFor(() => tracker.stats().answered === 1, { timeoutMs: 3000 });
  await new Promise((r) => setTimeout(r, 400)); // past the timeout window
  assert.equal(tracker.stats().dodged, 1, 'answered question never dodges');
});

test('phase4 e2e: dodge flag + receipts close out a full debate', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    motion: 'Ban gasoline car sales by 2035',
    config: { preset: 'oxford' },
    speakers: [
      { name: 'Alex Rivera', team: 'Proposition' },
      { name: 'Jordan Blake', team: 'Opposition' },
    ],
  });

  const { ws, events } = await openEventCollector(srv.wsUrl, session.id);

  await startSessionPipeline(session.id, {
    meetingProvider: createMockMeetingProvider({ speedFactor: 50 }),
    sttProvider: createMockSttProvider({ latencyMs: 5 }),
    brainOptions: {
      llm: createMockLlm(),
      searchProvider: createMockSearchProvider({ latencyMs: 5 }),
      extractIntervalMs: 150,
      scoreIntervalMs: 400,
      dodgeTimeoutMs: 500, // fixture question is never answered with overlap
    },
  });
  t.after(() => stopPipeline(session.id));

  // Jordan's stranded-fleet question goes unanswered -> dodge flag.
  await waitFor(() => events.some((e) => e.type === 'flag' && e.kind === 'dodge'), { timeoutMs: 20000 });
  const dodge = events.find((e) => e.type === 'flag' && e.kind === 'dodge');
  assert.match(dodge.speaker, /Alex Rivera/, 'the non-asker is charged');

  // Debate ends -> receipts arrive as the terminal display state.
  await waitFor(() => events.some((e) => e.type === 'receipts'), { timeoutMs: 25000 });
  const receipts = events.find((e) => e.type === 'receipts');
  assert.ok(receipts.headline);
  assert.ok(receipts.final_scores.length === 2);
  assert.ok(receipts.most_accurate, 'most accurate speaker named');
  assert.ok(receipts.verdict_counts.FALSE >= 1, 'false verdicts counted');
  assert.ok(receipts.unanswered_questions >= 1);

  // Receipts persisted + served over REST.
  const db = await getDb();
  assert.ok(db.writes.some((w) => w.text.includes('INSERT INTO receipts')));
  const api = await fetch(`${srv.baseUrl}/api/sessions/${session.id}/receipts`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).headline, receipts.headline);
  ws.close();
});

test('phase4: replay-request message recovers a client-detected gap', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);
  const { ws, events } = await openEventCollector(srv.wsUrl, session.id);

  for (let i = 0; i < 4; i++) await publishEvent(session.id, 'transcript', { text: `u${i}`, final: true });
  await waitFor(() => events.filter((e) => e.type === 'transcript').length >= 4);

  // Client asks for a replay from seq 1 (as the gap-detector does).
  ws.send(JSON.stringify({ type: 'replay', since: 1 }));
  await waitFor(() => events.filter((e) => e.type === 'transcript').length >= 8);
  const texts = events.filter((e) => e.type === 'transcript').map((e) => e.text);
  assert.deepEqual(texts.slice(-4), ['u0', 'u1', 'u2', 'u3'], 'replayed in order');
  ws.close();
});

test('phase4: pipeline survives a failing LLM and a failing search provider', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    config: { preset: 'oxford' },
    speakers: [{ name: 'Alex Rivera', team: 'P' }, { name: 'Jordan Blake', team: 'O' }],
  });
  const { ws, events } = await openEventCollector(srv.wsUrl, session.id);

  const brokenLlm = {
    kind: 'broken',
    async extractClaims() {
      throw new Error('LLM exploded');
    },
    async judgeClaim() {
      throw new Error('judge exploded');
    },
    async generateReceipts() {
      throw new Error('receipts exploded');
    },
  };

  await startSessionPipeline(session.id, {
    meetingProvider: createMockMeetingProvider({ speedFactor: 50 }),
    sttProvider: createMockSttProvider({ latencyMs: 5 }),
    brainOptions: {
      llm: brokenLlm,
      searchProvider: { kind: 'broken', search: async () => { throw new Error('search down'); } },
      extractIntervalMs: 150,
    },
  });
  t.after(() => stopPipeline(session.id));

  // Transcript still flows despite the brain being on fire...
  await waitFor(() => events.filter((e) => e.type === 'transcript').length >= 10, { timeoutMs: 20000 });
  // ...and the session still ends cleanly.
  await waitFor(() => events.some((e) => e.type === 'session.status' && e.status === 'ended'), { timeoutMs: 20000 });
  ws.close();
});

test('phase4: verifier emits honest UNVERIFIED when judging fails', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    config: { preset: 'oxford' },
    speakers: [{ name: 'Alex Rivera', team: 'P' }],
  });
  const { ws, events } = await openEventCollector(srv.wsUrl, session.id);

  const { addClaim } = await import('../src/pipeline/argumentGraph.js');
  const { startVerifier, enqueueVerification } = await import('../src/pipeline/verifier.js');
  const claim = await addClaim(session.id, {
    text: 'EV sales tripled between 2020 and 2023.',
    speaker: 'Alex Rivera',
    type: 'factual',
    checkable: true,
  });

  const verifier = startVerifier(session.id, {
    llm: { judgeClaim: async () => { throw new Error('judge down'); } },
    searchProvider: createMockSearchProvider({ latencyMs: 5 }),
    sessionConfig: {},
  });
  t.after(() => verifier.stop());
  await enqueueVerification(session.id, claim.id);

  await waitFor(() => events.some((e) => e.type === 'factcheck'), { timeoutMs: 10000 });
  const card = events.find((e) => e.type === 'factcheck');
  assert.equal(card.verdict, 'UNVERIFIED', 'failure -> UNVERIFIED, never a guess');
  assert.equal(card.sources.length, 0);
  ws.close();
});

test('phase4: the judge is told the motion, so underspecified claims have context', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    motion: 'This house believes the United States economy has recovered',
    config: { preset: 'oxford' },
    speakers: [{ name: 'Alex Rivera', team: 'P' }],
  });

  const { addClaim } = await import('../src/pipeline/argumentGraph.js');
  const { startVerifier, enqueueVerification } = await import('../src/pipeline/verifier.js');
  // Underspecified on its own: no country, no date. Keyword search will happily
  // return another country's statistics, so the judge needs the motion to know
  // what is being claimed — otherwise correct evidence about the wrong place
  // reads as support.
  const claim = await addClaim(session.id, {
    text: 'Unemployment is at a record low.',
    speaker: 'Alex Rivera',
    type: 'factual',
    checkable: true,
  });

  let seen = null;
  const verifier = startVerifier(session.id, {
    llm: {
      async judgeClaim(args) {
        seen = args;
        return { verdict: 'UNVERIFIABLE', confidence: 0.4, evidence_summary: 'Scope unclear.', sources: [] };
      },
    },
    searchProvider: createMockSearchProvider({ latencyMs: 5 }),
    sessionConfig: {},
  });
  t.after(() => verifier.stop());
  await enqueueVerification(session.id, claim.id);

  await waitFor(() => seen !== null, { timeoutMs: 10000 });
  assert.equal(seen.motion, 'This house believes the United States economy has recovered');
  assert.equal(seen.claim.text, 'Unemployment is at a record low.');
});

test('phase4: the receipts quotation is verbatim and its attribution comes from data', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    motion: 'This house believes electric vehicles have gone mainstream',
    config: { preset: 'oxford' },
    speakers: [{ name: 'Alex Rivera', team: 'P' }, { name: 'Jordan Blake', team: 'O' }],
  });

  // Receipts need scored speakers, which the pipeline normally registers as
  // participants join.
  const { ensureSpeaker } = await import('../src/pipeline/speakers.js');
  await ensureSpeaker(session.id, { participantId: 'p1', name: 'Alex Rivera' });
  await ensureSpeaker(session.id, { participantId: 'p2', name: 'Jordan Blake' });

  const { addClaim, setClaimVerdict } = await import('../src/pipeline/argumentGraph.js');
  const VERBATIM = 'Electric vehicles actually emit more carbon dioxide than gasoline cars over their lifetime.';
  const claim = await addClaim(session.id, {
    text: VERBATIM,
    speaker: 'Jordan Blake',
    type: 'factual',
    checkable: true,
  });
  await setClaimVerdict(session.id, claim.id, {
    verdict: 'FALSE',
    confidence: 0.95,
    evidence_summary: 'Sources contradict it.',
    sources: [{ name: 'ICCT', url: 'https://theicct.org/x' }],
  });

  const { generateAndPublishReceipts } = await import('../src/pipeline/receipts.js');
  // A model that rewrites the quote and invents an attribution — which is what
  // a local 7B actually did, appending "(Proposition's claim...)" to a claim
  // whose speaker it had no team data for.
  const receipts = await generateAndPublishReceipts(session.id, {
    llm: {
      async generateReceipts() {
        return {
          headline: 'Proposition takes it.',
          biggest_unsupported_claim: 'EVs are dirtier than petrol cars (Proposition said this).',
        };
      },
    },
  });

  assert.equal(receipts.biggest_unsupported_claim, VERBATIM, 'the transcript wins over the retelling');
  assert.equal(receipts.biggest_unsupported_claim_speaker, 'Jordan Blake', 'attributed to whoever actually said it');
});
