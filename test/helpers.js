// Shared test scaffolding: boots the real app on an ephemeral port with a
// fresh in-memory store + null db per call.
import http from 'node:http';
import { createApp } from '../src/server.js';
import { attachWsHub } from '../src/ws/hub.js';
import { _resetStoreForTests } from '../src/state/store.js';
import { _resetDbForTests } from '../src/db/postgres.js';
import { createMemoryStore } from '../src/state/memoryStore.js';
import { stopAllMocks } from '../src/mock/generator.js';
import { stopAllPipelines } from '../src/pipeline/runtime.js';

export async function setupTestServer() {
  _resetStoreForTests(createMemoryStore());
  _resetDbForTests(null); // getDb() will build a fresh null db (DATABASE_URL unset in tests)

  const app = createApp();
  const server = http.createServer(app);
  const hub = attachWsHub(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    async close() {
      stopAllMocks();
      await stopAllPipelines();
      await hub.close();
      await new Promise((resolve) => server.close(resolve));
      _resetStoreForTests(null);
      _resetDbForTests(null);
    },
  };
}

export async function createTestSession(baseUrl, body = {}) {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meetingUrl: 'https://zoom.us/j/000', ...body }),
  });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  return res.json();
}

// Open a WS client and resolve only after the server's hello — so no events
// published after this point can be missed by the test.
export async function openEventCollector(wsUrl, sessionId, role = 'dashboard') {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`${wsUrl}/ws?session=${sessionId}&role=${role}`);
  const events = [];
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    const check = setInterval(() => {
      if (events.some((e) => e.type === 'hello')) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
  return { ws, events };
}

export function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      try {
        const value = await predicate();
        if (value) {
          clearInterval(timer);
          resolve(value);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('waitFor timed out'));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, intervalMs);
  });
}
