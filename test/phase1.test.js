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
import { getTranscriptDelta } from '../src/pipeline/transcript.js';
import { getSpeakers } from '../src/pipeline/speakers.js';
import { getDb } from '../src/db/postgres.js';
import { parseRecallRealtimeMessage } from '../src/providers/meeting/recall.js';
import { parseChatCommand } from '../src/pipeline/chatCommands.js';

const FAST = { speedFactor: 50 }; // 60s fixture -> ~1.2s

// Explicit mocks everywhere so tests stay hermetic: the default search
// provider is now our own engine, which would otherwise reach the network.
function fastProviders() {
  return {
    meetingProvider: createMockMeetingProvider(FAST),
    sttProvider: createMockSttProvider({ latencyMs: 5 }),
    brainOptions: {
      llm: createMockLlm(),
      searchProvider: createMockSearchProvider({ latencyMs: 5 }),
      extractIntervalMs: 200,
    },
  };
}

test('phase1: scripted debate produces speaker-labeled transcript end-to-end', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, {
    speakers: [
      { name: 'Alex Rivera', team: 'Proposition' },
      { name: 'Jordan Blake', team: 'Opposition' },
    ],
  });

  const ws = new WebSocket(`${srv.wsUrl}/ws?session=${session.id}&role=dashboard`);
  const events = [];
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));

  await startSessionPipeline(session.id, fastProviders());
  t.after(() => stopPipeline(session.id));

  // All 16 fixture utterances become final transcript entries.
  await waitFor(() => events.filter((e) => e.type === 'transcript').length >= 16, { timeoutMs: 15000 });

  const finals = events.filter((e) => e.type === 'transcript');
  const alex = finals.find((e) => e.speaker === 'Alex Rivera');
  assert.ok(alex, 'Alex utterances labeled');
  assert.equal(alex.team, 'Proposition');
  const jordan = finals.find((e) => e.speaker === 'Jordan Blake');
  assert.equal(jordan.team, 'Opposition');

  // Speakers registered with platform identity + team mapping; host untracked.
  const speakers = await getSpeakers(session.id);
  assert.equal(speakers.length, 3);
  const host = speakers.find((s) => s.isHost);
  assert.equal(host.tracked, false);

  // Interims flowed too.
  assert.ok(events.some((e) => e.type === 'transcript.interim'));

  // Session went live and ended by itself when the scripted call ended.
  await waitFor(() =>
    events.some((e) => e.type === 'session.status' && e.status === 'ended'),
  );
  ws.close();
});

test('phase1: transcript delta cursor feeds the extractor incrementally', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);
  await startSessionPipeline(session.id, fastProviders());
  t.after(() => stopPipeline(session.id));

  await waitFor(async () => (await getTranscriptDelta(session.id, 0)).entries.length >= 5, {
    timeoutMs: 15000,
  });
  const first = await getTranscriptDelta(session.id, 0);
  assert.ok(first.cursor >= 5);
  const again = await getTranscriptDelta(session.id, first.cursor);
  // Everything up to the cursor is not re-delivered.
  assert.ok(again.entries.length < first.entries.length || again.entries.length === 0);
});

test('phase1: utterances are batch-persisted to the database', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);
  await startSessionPipeline(session.id, fastProviders());

  // Wait for the run to finish, then stop (stop flushes buffered rows).
  await new Promise((r) => setTimeout(r, 2500));
  await stopPipeline(session.id);

  const db = await getDb();
  const utteranceWrites = db.writes.filter((w) => w.text.includes('INSERT INTO utterances'));
  assert.ok(utteranceWrites.length >= 1, 'batched utterance INSERT happened');
  const totalRows = utteranceWrites.reduce((n, w) => n + w.params.length / 4, 0);
  assert.ok(totalRows >= 16, `all utterances persisted (got ${totalRows})`);
});

test('phase1: recall realtime message mapping', () => {
  const audio = parseRecallRealtimeMessage({
    event: 'audio_separate_raw.data',
    data: { data: { buffer: Buffer.from('pcm').toString('base64'), participant: { id: 7, name: 'Ada' } } },
  });
  assert.equal(audio.handler, 'onAudio');
  assert.equal(audio.payload.participantId, '7');
  assert.deepEqual(audio.payload.chunk, Buffer.from('pcm'));

  const join = parseRecallRealtimeMessage({
    event: 'participant_events.join',
    data: { data: { participant: { id: 3, name: 'Grace', is_host: true } } },
  });
  assert.equal(join.handler, 'onParticipantJoin');
  assert.equal(join.payload.isHost, true);

  const chat = parseRecallRealtimeMessage({
    event: 'participant_events.chat_message',
    data: { data: { participant: { id: 3, name: 'Grace' }, text: '/end' } },
  });
  assert.equal(chat.handler, 'onChat');
  assert.equal(chat.payload.text, '/end');

  assert.equal(parseRecallRealtimeMessage({ event: 'unrelated', data: {} }), null);
});

test('phase1: chat command parser', () => {
  assert.deepEqual(parseChatCommand('/mode oxford'), { name: 'mode', args: ['oxford'] });
  assert.deepEqual(parseChatCommand('/pause scoring'), { name: 'pause', args: ['scoring'] });
  assert.equal(parseChatCommand('hello world'), null);
  assert.deepEqual(parseChatCommand('  /END  '), { name: 'end', args: [] });
});
