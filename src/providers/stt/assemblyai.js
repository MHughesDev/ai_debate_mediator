// AssemblyAI streaming STT (bake-off alternative, ADR-0004).
import WebSocket from 'ws';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const AAI_URL = 'wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000';

export function createAssemblyAiProvider() {
  return {
    kind: 'assemblyai',

    createStream({ sessionId, participantId, onTranscript, onError }) {
      const ws = new WebSocket(AAI_URL, {
        headers: { Authorization: config.assemblyaiApiKey },
      });
      const pending = [];
      let open = false;
      let closed = false;

      ws.on('open', () => {
        open = true;
        for (const chunk of pending.splice(0)) send(chunk);
      });

      function send(chunk) {
        // AssemblyAI v2 realtime expects base64 audio in a JSON envelope.
        ws.send(JSON.stringify({ audio_data: Buffer.from(chunk).toString('base64') }));
      }

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.message_type === 'FinalTranscript' && msg.text?.trim()) {
          onTranscript({ text: msg.text.trim(), isFinal: true, ts: Date.now() });
        } else if (msg.message_type === 'PartialTranscript' && msg.text?.trim()) {
          onTranscript({ text: msg.text.trim(), isFinal: false, ts: Date.now() });
        }
      });
      ws.on('error', (err) => {
        logger.error('assemblyai stream error', { sessionId, participantId, error: err.message });
        if (onError) onError(err);
      });

      return {
        write(chunk) {
          if (closed) return;
          if (open && ws.readyState === ws.OPEN) send(chunk);
          else pending.push(chunk);
        },
        close() {
          closed = true;
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ terminate_session: true }));
            ws.close();
          } else {
            ws.terminate();
          }
        },
      };
    },
  };
}
