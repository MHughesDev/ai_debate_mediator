// Mock STT: accepts {text} chunks from the mock meeting provider and emits an
// interim then a final transcript with realistic (sub-second) latency.
export function createMockSttProvider({ latencyMs = 120 } = {}) {
  return {
    kind: 'mock',

    createStream({ onTranscript }) {
      let closed = false;
      const timers = [];
      return {
        write(chunk) {
          if (closed || !chunk || typeof chunk.text !== 'string') return;
          const words = chunk.text.split(' ');
          if (words.length > 4) {
            timers.push(
              setTimeout(() => {
                if (!closed) onTranscript({ text: words.slice(0, 3).join(' ') + '…', isFinal: false, ts: Date.now() });
              }, Math.round(latencyMs / 2)),
            );
          }
          timers.push(
            setTimeout(() => {
              if (!closed) onTranscript({ text: chunk.text, isFinal: true, ts: Date.now() });
            }, latencyMs),
          );
        },
        close() {
          closed = true;
          for (const t of timers) clearTimeout(t);
        },
      };
    },
  };
}
