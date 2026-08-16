// Shared resilient WS client for display/dashboard/stage pages.
// Auto-reconnects with backoff and rehydrates via ?since=<lastSeq> replay,
// so a mid-call server restart is a ~2s blip (design contract #4).
export function connectSession({ sessionId, role, onEvent, onStatus }) {
  let ws = null;
  let lastSeq = 0;
  let attempts = 0;
  let closed = false;

  function status(s) {
    if (onStatus) onStatus(s);
  }

  function open() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?session=${encodeURIComponent(sessionId)}&role=${role}&since=${lastSeq}`;
    ws = new WebSocket(url);
    status(attempts === 0 ? 'connecting' : 'reconnecting');

    ws.onopen = () => {
      attempts = 0;
      status('connected');
    };

    ws.onmessage = (msgEvent) => {
      let event;
      try {
        event = JSON.parse(msgEvent.data);
      } catch {
        return;
      }
      if (typeof event.seq === 'number') {
        // Gap detection: request replay of anything we skipped.
        if (lastSeq && event.seq > lastSeq + 1) {
          ws.send(JSON.stringify({ type: 'replay', since: lastSeq }));
        }
        if (event.seq > lastSeq) lastSeq = event.seq;
      }
      if (event.type === 'hello' && typeof event.lastSeq === 'number' && event.lastSeq > lastSeq) {
        // hello carries the server's head; snapshot that follows covers the gap.
        lastSeq = event.lastSeq;
      }
      onEvent(event);
    };

    ws.onclose = () => {
      if (closed) return;
      status('disconnected');
      const delay = Math.min(500 * 2 ** attempts, 8000);
      attempts += 1;
      setTimeout(open, delay);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }

  open();

  return {
    close() {
      closed = true;
      if (ws) ws.close();
    },
  };
}

export function sessionIdFromUrl() {
  return new URLSearchParams(location.search).get('session') || '';
}
