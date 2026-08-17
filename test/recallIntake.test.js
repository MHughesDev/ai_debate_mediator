// The Recall.ai intake path is the highest-risk integration: Recall's cloud
// dials OUR server at /ws/recall and streams per-participant audio + participant
// and chat events. We cannot call Recall from tests, but we can stand in for it
// — connect a fake Recall client to the real endpoint and assert every message
// shape lands in the right handler. This covers hub routing, session scoping,
// dispatch, and payload mapping; only Recall's actual wire format is assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setupTestServer, createTestSession, waitFor } from './helpers.js';
import { registerRecallIntake } from '../src/providers/meeting/recall.js';

function recallAudio(participantId, name, text) {
  return {
    event: 'audio_separate_raw.data',
    data: {
      data: {
        buffer: Buffer.from(text).toString('base64'),
        participant: { id: participantId, name },
      },
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

test('recall intake: audio, join, leave and chat reach the pipeline handlers', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);

  const calls = { join: [], leave: [], audio: [], chat: [] };
  const unregister = registerRecallIntake(session.id, {
    onParticipantJoin: (p) => calls.join.push(p),
    onParticipantLeave: (p) => calls.leave.push(p),
    onAudio: (a) => calls.audio.push(a),
    onChat: (c) => calls.chat.push(c),
    onStatus: () => {},
  });
  t.after(() => unregister());

  const ws = await connect(`${srv.wsUrl}/ws/recall?session=${session.id}`);

  ws.send(JSON.stringify({
    event: 'participant_events.join',
    data: { data: { participant: { id: 101, name: 'Alex Rivera', is_host: false } } },
  }));
  ws.send(JSON.stringify(recallAudio(101, 'Alex Rivera', 'pcm-bytes-here')));
  ws.send(JSON.stringify({
    event: 'participant_events.chat_message',
    data: { data: { participant: { id: 999, name: 'Sam Chen' }, text: '/check that' } },
  }));
  ws.send(JSON.stringify({
    event: 'participant_events.leave',
    data: { data: { participant: { id: 101 } } },
  }));
  // Unknown event types must be ignored, not crash the socket.
  ws.send(JSON.stringify({ event: 'video_separate_png.data', data: { data: {} } }));
  ws.send('this is not json');

  await waitFor(() => calls.join.length && calls.audio.length && calls.chat.length && calls.leave.length);

  assert.deepEqual(calls.join[0], { participantId: '101', name: 'Alex Rivera', isHost: false });
  assert.equal(calls.audio[0].participantId, '101');
  assert.deepEqual(calls.audio[0].chunk, Buffer.from('pcm-bytes-here'), 'audio decoded from base64');
  assert.equal(calls.chat[0].text, '/check that');
  assert.deepEqual(calls.leave[0], { participantId: '101' });
  assert.equal(ws.readyState, ws.OPEN, 'bad payloads do not kill the intake socket');
  ws.close();
});

test('recall intake: events are scoped to their own session', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const a = await createTestSession(srv.baseUrl);
  const b = await createTestSession(srv.baseUrl);

  const aAudio = [];
  const bAudio = [];
  const unA = registerRecallIntake(a.id, { onAudio: (x) => aAudio.push(x), onStatus: () => {} });
  const unB = registerRecallIntake(b.id, { onAudio: (x) => bAudio.push(x), onStatus: () => {} });
  t.after(() => { unA(); unB(); });

  const wsA = await connect(`${srv.wsUrl}/ws/recall?session=${a.id}`);
  wsA.send(JSON.stringify(recallAudio(1, 'Alex', 'audio-for-a')));
  await waitFor(() => aAudio.length === 1);

  assert.equal(bAudio.length, 0, 'session B never sees session A audio');
  assert.deepEqual(aAudio[0].chunk, Buffer.from('audio-for-a'));
  wsA.close();
});

test('recall intake: a socket without a session id is rejected', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const ws = new WebSocket(`${srv.wsUrl}/ws/recall`);
  const code = await new Promise((resolve, reject) => {
    ws.on('close', resolve);
    ws.on('error', reject);
  });
  assert.equal(code, 4400);
});

test('recall intake: audio for an unregistered session is dropped safely', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);
  // No registerRecallIntake — e.g. a bot still streaming after the pipeline stopped.
  const ws = await connect(`${srv.wsUrl}/ws/recall?session=${session.id}`);
  ws.send(JSON.stringify(recallAudio(1, 'Alex', 'orphan audio')));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ws.readyState, ws.OPEN, 'server stays healthy with no listener attached');
  ws.close();
});
