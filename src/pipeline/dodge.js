// Dodge detection (SPEC §3.2): questions are tracked with an unanswered-
// question timer. If no other tracked speaker produces an utterance that
// substantively overlaps the question's content words before the timer fires,
// the addressees are charged with a dodge (responsiveness penalty + flag).
import { subscribeSession, publishEvent } from '../sessions/events.js';
import { recordDodge } from './scoreEngine.js';
import { getSpeakers } from './speakers.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const STOPWORDS = new Set(
  'the a an and or but if then than that this those these what who whom whose which when where why how is are was were be been being do does did have has had will would can could should shall may might must not no yes to of in on for with about against between into through during before after above below from up down out off over under again further once here there all any both each few more most other some such only own same so very just'.split(' '),
);

export function contentWords(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

export function answersQuestion(questionText, utteranceText, minOverlap = 2) {
  const q = contentWords(questionText);
  const u = contentWords(utteranceText);
  let overlap = 0;
  for (const w of u) if (q.has(w)) overlap += 1;
  return overlap >= minOverlap;
}

export function startDodgeTracker(sessionId, { enabled = true, timeoutMs = config.dodgeTimeoutMs, flagDodges = true } = {}) {
  const open = new Map(); // questionClaimId -> { claim, timer, askedAt }
  let unsubscribe = null;
  let stopped = false;
  const stats = { asked: 0, answered: 0, dodged: 0, unansweredAtEnd: 0 };

  async function onTimeout(entry) {
    if (stopped) return;
    open.delete(entry.claim.id);
    stats.dodged += 1;
    try {
      // Charge every tracked non-asker (covers 1v1 and team formats).
      const speakers = (await getSpeakers(sessionId)).filter(
        (s) => s.tracked && !s.isHost && s.name !== entry.claim.speaker,
      );
      for (const s of speakers) await recordDodge(sessionId, s.name);
      if (flagDodges) {
        await publishEvent(sessionId, 'flag', {
          kind: 'dodge',
          speaker: speakers.map((s) => s.name).join(', '),
          label: 'Question left unanswered',
          detail: `“${entry.claim.text.slice(0, 120)}” — ${entry.claim.speaker}`,
          hold_ms: 7000,
        });
      }
    } catch (err) {
      logger.error('dodge timeout handling failed', { sessionId, error: err.message });
    }
  }

  function trackQuestion(claim) {
    if (!enabled || stopped) return;
    stats.asked += 1;
    const entry = { claim, askedAt: Date.now(), timer: null };
    entry.timer = setTimeout(() => onTimeout(entry), timeoutMs);
    if (entry.timer.unref) entry.timer.unref();
    open.set(claim.id, entry);
  }

  async function init() {
    unsubscribe = await subscribeSession(sessionId, (event) => {
      if (stopped || event.type !== 'transcript' || !event.final) return;
      for (const [id, entry] of [...open.entries()]) {
        if (event.speaker === entry.claim.speaker) continue; // asker restating ≠ answer
        if (answersQuestion(entry.claim.text, event.text)) {
          clearTimeout(entry.timer);
          open.delete(id);
          stats.answered += 1;
        }
      }
    });
  }
  const ready = init();

  return {
    trackQuestion,
    stats: () => ({ ...stats, open: open.size }),
    async stop() {
      stopped = true;
      stats.unansweredAtEnd = open.size;
      for (const [, entry] of open) clearTimeout(entry.timer);
      open.clear();
      await ready;
      if (unsubscribe) await unsubscribe();
    },
  };
}
