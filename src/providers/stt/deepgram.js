// Deepgram streaming STT: one websocket per participant audio stream
// (speaker identity comes from the platform, so no diarization needed).
import WebSocket from 'ws';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const DG_URL =
  'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&model=nova-2';

export function createDeepgramProvider() {
  return {
    kind: 'deepgram',

    createStream({ sessionId, participantId, onTranscript, onError }) {
      const ws = new WebSocket(DG_URL, {
        headers: { Authorization: `Token ${config.deepgramApiKey}` },
      });
      const pending = [];
      let open = false;
      let closed = false;

      ws.on('open', () => {
        open = true;
        for (const chunk of pending.splice(0)) ws.send(chunk);
      });
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type !== 'Results') return;
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript?.trim();
        if (!text) return;
        onTranscript({ text, isFinal: !!msg.is_final, ts: Date.now() });
      });
      ws.on('error', (err) => {
        logger.error('deepgram stream error', { sessionId, participantId, error: err.message });
        if (onError) onError(err);
      });
      ws.on('close', () => {
        if (!closed) {
          logger.warn('deepgram stream closed unexpectedly', { sessionId, participantId });
          if (onError) onError(new Error('transcription stream dropped'));
        }
      });

      const keepalive = setInterval(() => {
        if (open && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 5000);

      return {
        write(chunk) {
          if (closed) return;
          if (open && ws.readyState === ws.OPEN) ws.send(chunk);
          else pending.push(chunk);
        },
        close() {
          closed = true;
          clearInterval(keepalive);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'CloseStream' }));
            ws.close();
          } else {
            ws.terminate();
          }
        },
      };
    },
  };
}
