// Mock meeting provider: replays a scripted debate through the exact same
// handler surface as Recall — participants join, "audio" chunks flow per
// participant (as {text} objects the mock STT understands), chat commands fire.
// Powers local dev, tests, the simulator, and the load test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(here, '..', '..', '..', 'scripts', 'fixtures', 'debate.json');

export function loadFixture(path = DEFAULT_FIXTURE) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function createMockMeetingProvider({ fixture, speedFactor } = {}) {
  const script = fixture || loadFixture();
  // MOCK_SPEED_FACTOR compresses fixture timing (e.g. 10 => 10x faster) for tests.
  const speed = speedFactor ?? parseFloat(process.env.MOCK_SPEED_FACTOR || '1');

  return {
    kind: 'mock',

    async startMeeting(session, handlers) {
      const timers = [];
      let stopped = false;
      const t = (ms) => Math.max(1, Math.round(ms / speed));
      const schedule = (ms, fn) => {
        const timer = setTimeout(() => {
          if (!stopped) fn();
        }, t(ms));
        timers.push(timer);
      };

      handlers.onStatus({ status: 'bot_joining' });
      schedule(50, () => handlers.onStatus({ status: 'in_call' }));

      for (const p of script.participants) {
        schedule(100, () =>
          handlers.onParticipantJoin({ participantId: p.id, name: p.name, isHost: !!p.isHost }),
        );
      }

      for (const item of script.events) {
        if (item.type === 'utterance') {
          schedule(item.atMs, () =>
            handlers.onAudio({ participantId: item.participant, chunk: { text: item.text } }),
          );
        } else if (item.type === 'chat') {
          schedule(item.atMs, () => {
            const p = script.participants.find((x) => x.id === item.participant);
            handlers.onChat({ participantId: item.participant, name: p?.name || 'Unknown', text: item.text });
          });
        }
      }

      const endAt = script.events.reduce((max, e) => Math.max(max, e.atMs), 0) + 2000;
      schedule(endAt, () => handlers.onStatus({ status: 'call_ended' }));
      logger.info('mock meeting started', { sessionId: session.id, events: script.events.length, speed });

      return {
        botId: `mock-${session.id}`,
        async stop() {
          stopped = true;
          for (const timer of timers) clearTimeout(timer);
        },
        async sendChat(text) {
          logger.info('mock bot chat', { sessionId: session.id, text });
        },
      };
    },
  };
}
