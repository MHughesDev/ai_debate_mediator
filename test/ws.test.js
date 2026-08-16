import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setupTestServer, createTestSession, waitFor } from './helpers.js';
import { publishEvent } from '../src/sessions/events.js';

function collect(ws) {
  const events = [];
  ws.on('message', (data) => events.push(JSON.parse(data.toString())));
  return events;
}

function connected(ws) {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

test('ws: connect gets hello + snapshot, then live events', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);

  const ws = new WebSocket(`${srv.wsUrl}/ws?session=${session.id}&role=display`);
  const events = collect(ws);
  await connected(ws);

  await waitFor(() => events.some((e) => e.type === 'hello') && events.some((e) => e.type === 'snapshot'));
  await publishEvent(session.id, 'factcheck', { claim: 'live test', verdict: 'TRUE', confidence: 0.9, sources: [{ name: 's', url: 'u' }] });
  await waitFor(() => events.some((e) => e.type === 'factcheck'));

  const fc = events.find((e) => e.type === 'factcheck');
  assert.equal(fc.claim, 'live test');
  assert.ok(fc.seq > 0);
  ws.close();
});

test('ws: reconnect with since replays missed events in order', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl);

  // Client saw up to seq 1 (session.status), then missed three events.
  await publishEvent(session.id, 'transcript', { text: 'a' });
  await publishEvent(session.id, 'transcript', { text: 'b' });
  await publishEvent(session.id, 'transcript', { text: 'c' });

  const ws = new WebSocket(`${srv.wsUrl}/ws?session=${session.id}&role=display&since=1`);
  const events = collect(ws);
  await connected(ws);

  await waitFor(() => events.filter((e) => e.type === 'transcript').length === 3);
  const texts = events.filter((e) => e.type === 'transcript').map((e) => e.text);
  assert.deepEqual(texts, ['a', 'b', 'c']);
  ws.close();
});

test('ws: unknown session is rejected', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const ws = new WebSocket(`${srv.wsUrl}/ws?session=nope`);
  const events = collect(ws);
  await connected(ws);
  await waitFor(() => events.some((e) => e.type === 'error'));
  assert.match(events[0].error, /unknown session/);
});
