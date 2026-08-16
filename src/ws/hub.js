// WebSocket hub: fans session events out to display / dashboard / stage clients.
// Reconnect contract: client connects with ?session=<id>&since=<lastSeq>;
// server sends hello -> snapshot -> replay of missed events -> live stream.
import { WebSocketServer } from 'ws';
import { getSession, getSnapshot } from '../sessions/manager.js';
import { getEventsSince, subscribeSession } from '../sessions/events.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export function attachWsHub(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  // sessionId -> { unsubscribe, clients:Set<ws> }
  const subscriptions = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  async function ensureSubscribed(sessionId) {
    if (subscriptions.has(sessionId)) return subscriptions.get(sessionId);
    const entry = { clients: new Set(), unsubscribe: null };
    subscriptions.set(sessionId, entry);
    entry.unsubscribe = await subscribeSession(sessionId, (event) => {
      const json = JSON.stringify(event);
      for (const client of entry.clients) {
        if (client.readyState === client.OPEN) client.send(json);
      }
    });
    return entry;
  }

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('session');
    const role = url.searchParams.get('role') || 'display';
    const since = parseInt(url.searchParams.get('since') || '0', 10);

    const session = sessionId ? await getSession(sessionId) : null;
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', error: 'unknown session' }));
      ws.close(4004, 'unknown session');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const entry = await ensureSubscribed(sessionId);
    entry.clients.add(ws);
    logger.debug('ws connected', { sessionId, role });

    // Rehydrate: snapshot first, then any events the client missed.
    const snapshot = await getSnapshot(sessionId);
    ws.send(JSON.stringify({ type: 'hello', role, lastSeq: snapshot.lastSeq }));
    ws.send(JSON.stringify({ type: 'snapshot', seq: snapshot.lastSeq, ...snapshot }));
    if (since > 0 && since < snapshot.lastSeq) {
      for (const event of await getEventsSince(sessionId, since)) {
        ws.send(JSON.stringify(event));
      }
    }

    ws.on('message', (data) => {
      // Client -> server messages: currently only replay requests on gap detection.
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'replay' && Number.isInteger(msg.since)) {
        getEventsSince(sessionId, msg.since).then((events) => {
          for (const event of events) {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
          }
        });
      }
    });

    ws.on('close', async () => {
      entry.clients.delete(ws);
      if (entry.clients.size === 0) {
        subscriptions.delete(sessionId);
        if (entry.unsubscribe) await entry.unsubscribe();
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, config.wsHeartbeatMs);

  return {
    wss,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, 'server shutdown');
      for (const [, entry] of subscriptions) if (entry.unsubscribe) await entry.unsubscribe();
      subscriptions.clear();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
