import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, createTestSession } from './helpers.js';

test('api: healthz, session lifecycle, snapshot', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());

  const health = await fetch(`${srv.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  // create requires meetingUrl
  const bad = await fetch(`${srv.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(bad.status, 400);

  const session = await createTestSession(srv.baseUrl, { motion: 'This house believes X' });
  assert.ok(session.id);
  assert.equal(session.status, 'created');

  const fetched = await fetch(`${srv.baseUrl}/api/sessions/${session.id}`);
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).motion, 'This house believes X');

  const snapshot = await (await fetch(`${srv.baseUrl}/api/sessions/${session.id}/snapshot`)).json();
  assert.equal(snapshot.session.id, session.id);
  assert.ok(snapshot.lastSeq >= 1); // session.status event

  const ended = await fetch(`${srv.baseUrl}/api/sessions/${session.id}/end`, { method: 'POST' });
  assert.equal((await ended.json()).status, 'ended');

  const missing = await fetch(`${srv.baseUrl}/api/sessions/nope`);
  assert.equal(missing.status, 404);
});

test('api: mock generator can be started and produces state', async (t) => {
  const srv = await setupTestServer();
  t.after(() => srv.close());
  const session = await createTestSession(srv.baseUrl, { mock: true });

  // Give the generator a tick, then the snapshot should carry hot state.
  await new Promise((r) => setTimeout(r, 100));
  const snapshot = await (await fetch(`${srv.baseUrl}/api/sessions/${session.id}/snapshot`)).json();
  assert.ok(snapshot.lastSeq >= 2);
  const stop = await fetch(`${srv.baseUrl}/api/sessions/${session.id}/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  });
  assert.equal(stop.status, 200);
});
