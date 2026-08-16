// Phase 0 mock event generator: drives the display page with realistic fake
// pipeline output so the bot tile can be demoed in a real call before any
// AI/audio is wired up (Phase 0 milestone). Also handy for UI work forever.
import { publishEvent } from '../sessions/events.js';
import { setStateSlice } from '../sessions/manager.js';
import { logger } from '../logger.js';

const running = new Map(); // sessionId -> { timer, step }

const SPEAKERS = [
  { id: 'sp1', name: 'Alex Rivera', team: 'Proposition' },
  { id: 'sp2', name: 'Jordan Blake', team: 'Opposition' },
];

const FACTCHECKS = [
  {
    claim: 'Global EV sales tripled between 2020 and 2023.',
    speaker: 'Alex Rivera',
    verdict: 'TRUE',
    confidence: 0.94,
    evidence: 'IEA data shows ~3M sales in 2020 rising to ~14M in 2023.',
    sources: [{ name: 'IEA Global EV Outlook', url: 'https://www.iea.org/reports/global-ev-outlook-2024' }],
  },
  {
    claim: 'The Great Wall of China is visible from the Moon.',
    speaker: 'Jordan Blake',
    verdict: 'FALSE',
    confidence: 0.97,
    evidence: 'NASA confirms no human structures are visible from the Moon.',
    sources: [{ name: 'NASA', url: 'https://www.nasa.gov/vision/space/workinginspace/great_wall.html' }],
  },
  {
    claim: 'Unemployment is at its lowest level in history.',
    speaker: 'Alex Rivera',
    verdict: 'MISLEADING',
    confidence: 0.88,
    evidence: 'Near 50-year lows, but not the lowest ever recorded.',
    sources: [{ name: 'BLS', url: 'https://www.bls.gov/charts/employment-situation/civilian-unemployment-rate.htm' }],
  },
  {
    claim: 'Most economists privately agree with my position.',
    speaker: 'Jordan Blake',
    verdict: 'UNVERIFIABLE',
    confidence: 0.5,
    evidence: 'No data source can establish private opinions.',
    sources: [],
  },
];

function scoreboard(step) {
  const wobble = (base) => Math.max(0, Math.min(100, base + Math.round(Math.sin(step / 2) * 8)));
  return {
    visibility: 'live',
    scores: [
      { speaker: 'Alex Rivera', team: 'Proposition', total: wobble(72), subs: { accuracy: 78, evidence: 70, logic: 74, responsiveness: 66 } },
      { speaker: 'Jordan Blake', team: 'Opposition', total: wobble(64), subs: { accuracy: 55, evidence: 68, logic: 71, responsiveness: 62 } },
    ],
    hold_ms: 6000,
  };
}

async function tick(sessionId, state) {
  const step = state.step++;
  const phase = step % 8;
  try {
    switch (phase) {
      case 0: {
        const speaker = SPEAKERS[step % SPEAKERS.length];
        await setStateSlice(sessionId, 'speaker', speaker);
        await publishEvent(sessionId, 'speaker', speaker);
        break;
      }
      case 1: {
        const turnclock = { label: `${SPEAKERS[state.step % 2].team} — Rebuttal`, remaining_s: 90 - (step % 4) * 15, total_s: 120, overtime: false };
        await setStateSlice(sessionId, 'turnclock', turnclock);
        await publishEvent(sessionId, 'turnclock', turnclock);
        break;
      }
      case 2: {
        const pending = { count: 1 + (step % 3) };
        await setStateSlice(sessionId, 'pending', pending);
        await publishEvent(sessionId, 'verification.pending', pending);
        break;
      }
      case 3:
      case 6: {
        const fc = { ...FACTCHECKS[step % FACTCHECKS.length], hold_ms: 9000 };
        await setStateSlice(sessionId, 'lastFactcheck', fc);
        await publishEvent(sessionId, 'factcheck', fc);
        break;
      }
      case 4: {
        const sb = scoreboard(step);
        await setStateSlice(sessionId, 'scoreboard', sb);
        await publishEvent(sessionId, 'scoreboard', sb);
        break;
      }
      case 5: {
        const t = { speaker: SPEAKERS[step % 2].name, text: 'And that is precisely why the motion must stand — the numbers back it up.', final: true };
        await publishEvent(sessionId, 'transcript', t);
        break;
      }
      case 7: {
        if (step % 24 === 7) {
          await publishEvent(sessionId, 'flag', {
            kind: 'fallacy',
            speaker: SPEAKERS[1].name,
            label: 'Ad hominem',
            detail: 'Attacked the speaker rather than the argument.',
            hold_ms: 7000,
          });
        }
        break;
      }
    }
  } catch (err) {
    logger.error('mock tick failed', { sessionId, error: err.message });
  }
}

export function startMock(sessionId) {
  if (running.has(sessionId)) return;
  const state = { step: 0 };
  const timer = setInterval(() => tick(sessionId, state), 3000);
  running.set(sessionId, { timer, state });
  tick(sessionId, state);
  logger.info('mock generator started', { sessionId });
}

export function stopMock(sessionId) {
  const entry = running.get(sessionId);
  if (!entry) return;
  clearInterval(entry.timer);
  running.delete(sessionId);
  logger.info('mock generator stopped', { sessionId });
}

export function stopAllMocks() {
  for (const id of [...running.keys()]) stopMock(id);
}
