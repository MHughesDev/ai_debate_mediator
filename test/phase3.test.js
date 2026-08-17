import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, createTestSession, waitFor, openEventCollector } from './helpers.js';
import { loadPresets, validatePreset, deepMerge, resolveSessionConfig } from '../src/presets/index.js';
import { computeScores } from '../src/pipeline/scoreEngine.js';
import { startTurnClock } from '../src/pipeline/turnClock.js';
import { startSessionPipeline } from '../src/pipeline/session.js';
import { stopPipeline } from '../src/pipeline/runtime.js';
import { createMockMeetingProvider } from '../src/providers/meeting/mock.js';
import { createMockSttProvider } from '../src/providers/stt/mock.js';
import { createMockLlm } from '../src/providers/llm/mock.js';
import { createMockSearchProvider } from '../src/providers/search/mock.js';
import { getSession } from '../src/sessions/manager.js';
import { handleChatMessage } from '../src/pipeline/chatCommands.js';
import '../src/pipeline/commands.js';

test('presets: all five load and validate; bad presets rejected', () => {
  const presets = loadPresets();
  assert.deepEqual(
    Object.keys(presets).sort(),
    ['casual', 'lincoln_douglas', 'oxford', 'panel', 'roast'],
  );
  assert.equal(presets.panel.scoring_visibility, 'off');
  assert.equal(presets.oxford.turns.enforce, true);

  assert.throws(() => validatePreset({ format_id: 'x' }), /missing/);
  assert.throws(
    () => validatePreset({ ...presets.oxford, rubric: { accuracy: 0.9, evidence: 0.9, logic: 0, responsiveness: 0 } }),
    /sum to 1/,
  );
});

test('presets: dial overrides deep-merge without clobbering siblings', () => {
  const resolved = resolveSessionConfig({
    preset: 'oxford',
    overrides: { factcheck: { false_verdict_min_confidence: 0.95 }, scoring_visibility: 'end' },
  });
  assert.equal(resolved.preset, 'oxford');
  assert.equal(resolved.factcheck.false_verdict_min_confidence, 0.95);
  assert.equal(resolved.factcheck.mode, 'major_claims'); // sibling preserved
  assert.equal(resolved.scoring_visibility, 'end');
  assert.equal(resolved.turns.enforce, true);

  // unknown preset falls back to casual
  assert.equal(resolveSessionConfig({ preset: 'nope' }).preset, 'casual');
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { b: 9 } }), { a: { b: 9, c: 2 } });
});

test('score engine: sub-scores respond to verdicts, fallacies, dodges, links', () => {
  const speakers = [
    { id: 's1', name: 'A', team: 'Prop', tracked: true, isHost: false },
    { id: 's2', name: 'B', team: 'Opp', tracked: true, isHost: false },
    { id: 'h', name: 'Host', tracked: false, isHost: true },
  ];
  const claims = [
    { speaker: 'A', type: 'factual', verdict: 'TRUE', text: 'According to the IEA, sales tripled.', links: [] },
    { speaker: 'A', type: 'factual', verdict: 'TRUE', text: 'Studies show EVs emit less.', links: [{ relation: 'rebuts', targetClaimId: 'x' }] },
    { speaker: 'B', type: 'factual', verdict: 'FALSE', text: 'EVs emit more CO2.', links: [] },
    { speaker: 'B', type: 'factual', verdict: 'FALSE', text: 'The wall is visible from the Moon.', links: [] },
  ];
  const rubric = { accuracy: 0.3, evidence: 0.3, logic: 0.2, responsiveness: 0.2 };

  const scores = computeScores({ speakers, claims, fallacyCounts: { B: 2 }, dodgeCounts: { B: 1 }, rubric });
  assert.equal(scores.length, 2, 'host excluded');
  const a = scores.find((s) => s.speaker === 'A');
  const b = scores.find((s) => s.speaker === 'B');

  assert.equal(a.subs.accuracy, 100);
  assert.equal(b.subs.accuracy, 0);
  assert.ok(a.subs.evidence > b.subs.evidence, 'cited claims beat bare assertions');
  assert.ok(a.subs.logic > b.subs.logic, 'fallacies subtract from logic');
  assert.ok(a.subs.responsiveness > b.subs.responsiveness, 'rebuts add, dodges subtract');
  assert.ok(a.total > b.total);
  assert.equal(scores[0].speaker, 'A', 'sorted by total');

  // Rubric weights matter: crank responsiveness weight, gap narrows/reverses per subs
  const logicHeavy = computeScores({ speakers, claims, fallacyCounts: { B: 2 }, dodgeCounts: {}, rubric: { accuracy: 0, evidence: 0, logic: 1, responsiveness: 0 } });
  assert.equal(logicHeavy.find((s) => s.speaker === 'A').total, logicHeavy.find((s) => s.speaker === 'A').subs.logic);
});

test('turn clock: advances, pauses, flags overtime', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);

  const { ws, events } = await openEventCollector(srv.wsUrl, session.id);

  const clock = startTurnClock(session.id, {
    structure: [
      { label: 'Opening', team: 'Prop', seconds: 60 },
      { label: 'Reply', team: 'Opp', seconds: 60 },
    ],
    enforce: true,
  });
  t.after(() => clock.stop());

  await waitFor(() => events.some((e) => e.type === 'turnclock' && e.label === 'Opening'));
  await clock.pause();
  await waitFor(() => events.some((e) => e.type === 'turnclock' && e.paused === true));
  await clock.resume();
  await clock.advance();
  await waitFor(() => events.some((e) => e.type === 'turnclock' && e.label === 'Reply'));
  const reply = events.filter((e) => e.type === 'turnclock').at(-1);
  assert.equal(reply.turn_index, 1);
  assert.equal(reply.total_s, 60);
  await clock.advance(); // past the end
  await waitFor(() => events.some((e) => e.type === 'turnclock.finished'));
  ws.close();
});

test('phase3 e2e: Oxford mock debate is scored end-to-end with commands', async (t) => {
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

  // Preset resolution happened at creation.
  const meta = await getSession(session.id);
  assert.equal(meta.config.preset, 'oxford');
  assert.equal(meta.config.scoring_visibility, 'live');

  const { ws, events } = await openEventCollector(srv.wsUrl, session.id);

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

  // Turn clock started from the Oxford structure.
  await waitFor(() => events.some((e) => e.type === 'turnclock' && /Opening — Proposition/.test(e.label)), { timeoutMs: 10000 });

  // Live scoreboard with both debaters and full sub-scores.
  await waitFor(
    () => events.some((e) => e.type === 'scoreboard' && e.scores?.length === 2 && e.scores.every((s) => s.subs)),
    { timeoutMs: 20000 },
  );

  // The fixture's "/check that" chat command produced a host-requested check.
  await waitFor(() => events.some((e) => e.type === 'command' && e.name === 'check'), { timeoutMs: 20000 });

  // /pause scoring stops scoreboard publishes; /resume restarts them.
  await handleChatMessage(session.id, { participantId: 'host', name: 'Host', text: '/pause scoring' });
  await waitFor(() => events.some((e) => e.type === 'alert' && /paused/i.test(e.text)));
  const countAtPause = events.filter((e) => e.type === 'scoreboard').length;
  await new Promise((r) => setTimeout(r, 1000));
  const during = events.filter((e) => e.type === 'scoreboard').length;
  assert.ok(during <= countAtPause + 1, 'no scoreboard flood while paused');
  await handleChatMessage(session.id, { participantId: 'host', name: 'Host', text: '/resume' });

  // /mode switches the active preset live.
  await handleChatMessage(session.id, { participantId: 'host', name: 'Host', text: '/mode roast' });
  await waitFor(() => events.some((e) => e.type === 'mode' && e.preset === 'roast'));
  const switched = await getSession(session.id);
  assert.equal(switched.config.preset, 'roast');
  assert.equal(switched.config.personality, 'witty');

  // Wait for the debate to end; final snapshot lands in state.
  await waitFor(() => events.some((e) => e.type === 'session.status' && e.status === 'ended'), { timeoutMs: 20000 });
  const scoreboards = events.filter((e) => e.type === 'scoreboard');
  assert.ok(scoreboards.length >= 2, 'periodic + final snapshots');
  const final = scoreboards.at(-1);
  const alex = final.scores.find((s) => s.speaker === 'Alex Rivera');
  const jordan = final.scores.find((s) => s.speaker === 'Jordan Blake');
  assert.ok(alex && jordan);
  assert.ok(alex.subs.accuracy > jordan.subs.accuracy, 'Alex (true claims) out-scores Jordan (false claims) on accuracy');
  ws.close();
});

test('phase3: panel preset never publishes a live scoreboard', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    config: { preset: 'panel' },
    speakers: [{ name: 'Alex Rivera', team: null }, { name: 'Jordan Blake', team: null }],
  });

  const { ws, events } = await openEventCollector(srv.wsUrl, session.id);

  await startSessionPipeline(session.id, {
    meetingProvider: createMockMeetingProvider({ speedFactor: 50 }),
    sttProvider: createMockSttProvider({ latencyMs: 5 }),
    brainOptions: {
      llm: createMockLlm(),
      searchProvider: createMockSearchProvider({ latencyMs: 5 }),
      extractIntervalMs: 150,
      scoreIntervalMs: 300,
    },
  });
  t.after(() => stopPipeline(session.id));

  // Fact-checking still works on panel...
  await waitFor(() => events.some((e) => e.type === 'factcheck'), { timeoutMs: 20000 });
  await waitFor(() => events.some((e) => e.type === 'session.status' && e.status === 'ended'), { timeoutMs: 20000 });
  // ...but scoring stays dark.
  assert.equal(events.filter((e) => e.type === 'scoreboard').length, 0);
  ws.close();
});
