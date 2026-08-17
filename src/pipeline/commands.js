// In-call chat command implementations (SPEC §3.6). Imported for its side
// effects by the session pipeline; /end lives in chatCommands.js.
import { registerChatCommand } from './chatCommands.js';
import { updateSession, getSession, setStateSlice, getStateSlice } from '../sessions/manager.js';
import { publishEvent } from '../sessions/events.js';
import { resolveSessionConfig, loadPresets } from '../presets/index.js';
import { getClaims } from './argumentGraph.js';
import { enqueueVerification } from './verifier.js';
import { getTranscriptTail } from './transcript.js';
import { addClaim } from './argumentGraph.js';
import { getPipeline } from './runtime.js';
import { logger } from '../logger.js';

// /mode <preset> — switch format mid-session. Scorer/verifier read the session
// config live, so the new dials apply from the next tick/claim.
registerChatCommand('mode', async ({ sessionId, args }) => {
  const presetId = (args[0] || '').toLowerCase();
  const presets = loadPresets();
  if (!presets[presetId]) {
    await publishEvent(sessionId, 'alert', { text: `Unknown mode "${presetId}"`, hold_ms: 4000 });
    return;
  }
  const session = await getSession(sessionId);
  const overrides = session?.config?.overrides || {};
  const resolved = resolveSessionConfig({ preset: presetId, overrides });
  await updateSession(sessionId, { config: resolved });
  await publishEvent(sessionId, 'mode', { preset: presetId, label: presets[presetId].label });
  await publishEvent(sessionId, 'alert', { text: `Mode: ${presets[presetId].label}`, hold_ms: 4000 });
  logger.info('mode switched', { sessionId, preset: presetId });
});

// /pause scoring and /resume — scoring visibility gate for the scorer.
registerChatCommand('pause', async ({ sessionId, args }) => {
  if ((args[0] || 'scoring').toLowerCase() !== 'scoring') return;
  await setStateSlice(sessionId, 'scoring', { paused: true });
  await publishEvent(sessionId, 'alert', { text: 'Scoring paused', hold_ms: 3000 });
});

registerChatCommand('resume', async ({ sessionId }) => {
  const state = (await getStateSlice(sessionId, 'scoring')) || {};
  await setStateSlice(sessionId, 'scoring', { ...state, paused: false });
  await publishEvent(sessionId, 'alert', { text: 'Scoring resumed', hold_ms: 3000 });
});

// /check that — force-verify the most recent claim; if the extractor hasn't
// caught one yet, promote the last utterance to a claim and verify it.
registerChatCommand('check', async ({ sessionId }) => {
  const claims = await getClaims(sessionId);
  const recent = [...claims].reverse().find((c) => c.type !== 'question');
  if (recent) {
    await enqueueVerification(sessionId, recent.id);
    await publishEvent(sessionId, 'thought', { text: `host asked: re-checking “${recent.text.slice(0, 60)}”` });
    return;
  }
  const tail = await getTranscriptTail(sessionId, 1);
  if (tail.length === 0) return;
  const utterance = tail[0];
  const claim = await addClaim(sessionId, {
    text: utterance.text,
    speaker: utterance.speakerName,
    speakerId: utterance.speakerId,
    type: 'factual',
    checkable: true,
    links: [],
  });
  await enqueueVerification(sessionId, claim.id);
  await publishEvent(sessionId, 'thought', { text: `host asked: checking “${claim.text.slice(0, 60)}”` });
});

// /turn next|pause|resume — turn clock control (dashboard or chat).
registerChatCommand('turn', async ({ sessionId, args }) => {
  const pipeline = getPipeline(sessionId);
  const clock = pipeline?.brain?.()?.turnClock;
  if (!clock?.active) return;
  const sub = (args[0] || 'next').toLowerCase();
  if (sub === 'next') await clock.advance();
  else if (sub === 'pause') await clock.pause();
  else if (sub === 'resume') await clock.resume();
});
