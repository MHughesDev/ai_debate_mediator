// Turn clock: drives the preset's turn structure. Publishes turnclock events
// (display + stage ticker), flags overtime, auto-advances when enforce=true.
import { publishEvent } from '../sessions/events.js';
import { setStateSlice } from '../sessions/manager.js';
import { logger } from '../logger.js';

export function startTurnClock(sessionId, { structure = [], enforce = false, publishEveryMs = 5000 }) {
  if (!structure.length) {
    return { active: false, advance: async () => {}, pause: async () => {}, resume: async () => {}, stop: async () => {}, state: () => null };
  }

  let index = 0;
  let endsAt = Date.now() + structure[0].seconds * 1000;
  let paused = false;
  let pausedRemaining = null;
  let lastPublish = 0;
  let stopped = false;

  function current() {
    return structure[index] || null;
  }

  function remainingS() {
    if (paused) return Math.round((pausedRemaining || 0) / 1000);
    return Math.round((endsAt - Date.now()) / 1000);
  }

  async function publish(forced = false) {
    const turn = current();
    if (!turn) return;
    const now = Date.now();
    if (!forced && now - lastPublish < publishEveryMs) return;
    lastPublish = now;
    const remaining = remainingS();
    const payload = {
      label: turn.label,
      team: turn.team ?? null,
      remaining_s: remaining,
      total_s: turn.seconds,
      overtime: remaining < 0,
      paused,
      turn_index: index,
      turn_count: structure.length,
    };
    await setStateSlice(sessionId, 'turnclock', payload);
    await publishEvent(sessionId, 'turnclock', payload);
  }

  async function advance() {
    if (index >= structure.length - 1) {
      index = structure.length; // finished
      await publishEvent(sessionId, 'turnclock.finished', {});
      return;
    }
    index += 1;
    endsAt = Date.now() + structure[index].seconds * 1000;
    paused = false;
    await publish(true);
  }

  const timer = setInterval(async () => {
    if (stopped || paused || !current()) return;
    try {
      const remaining = remainingS();
      if (remaining < 0 && enforce && remaining < -10) {
        // 10s grace, then advance automatically.
        await advance();
      } else {
        await publish(remaining <= 10); // final 10s publish every tick
      }
    } catch (err) {
      logger.error('turn clock tick failed', { sessionId, error: err.message });
    }
  }, 1000);

  publish(true).catch(() => {});

  return {
    active: true,
    state: () => ({ index, remaining_s: remainingS(), paused }),
    advance,
    async pause() {
      if (paused) return;
      pausedRemaining = endsAt - Date.now();
      paused = true;
      await publish(true);
    },
    async resume() {
      if (!paused) return;
      endsAt = Date.now() + (pausedRemaining || 0);
      paused = false;
      pausedRemaining = null;
      await publish(true);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
