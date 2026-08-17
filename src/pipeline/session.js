// Per-session pipeline runner: meeting provider -> per-participant STT streams
// -> transcript -> (Phase 2+) extractor/verifier/scorer. One runner per live
// session, registered in runtime.js so shutdown can flush cleanly.
import { getMeetingProvider } from '../providers/meeting/index.js';
import { getSttProvider } from '../providers/stt/index.js';
import { ensureSpeaker, getSpeaker } from './speakers.js';
import { addFinalUtterance, publishInterim, flushTranscript } from './transcript.js';
import { registerPipeline, stopPipeline, getPipeline } from './runtime.js';
import { setSessionStatus, getSession } from '../sessions/manager.js';
import { publishEvent } from '../sessions/events.js';
import { handleChatMessage } from './chatCommands.js';
import { startBrain } from './brain.js';
import { logger } from '../logger.js';

export async function startSessionPipeline(sessionId, { meetingProvider, sttProvider, brainOptions } = {}) {
  if (getPipeline(sessionId)) return { alreadyRunning: true };
  const session = await getSession(sessionId);
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 });

  const meeting = meetingProvider || getMeetingProvider();
  const stt = sttProvider || getSttProvider();
  const sttStreams = new Map(); // participantId -> stream
  let controller = null;
  let brain = null;
  let stopped = false;

  async function getOrCreateStream(participantId, name) {
    let stream = sttStreams.get(participantId);
    if (stream) return stream;
    const speaker = (await getSpeaker(sessionId, participantId)) ||
      (await ensureSpeaker(sessionId, { participantId, name: name || 'Unknown' }));
    stream = stt.createStream({
      sessionId,
      participantId,
      onTranscript: ({ text, isFinal }) => {
        if (stopped) return;
        if (isFinal) {
          addFinalUtterance(sessionId, {
            speakerId: speaker.id,
            speakerName: speaker.name,
            team: speaker.team,
            text,
          }).catch((err) => logger.error('addFinalUtterance failed', { sessionId, error: err.message }));
        } else {
          publishInterim(sessionId, { speakerName: speaker.name, text }).catch(() => {});
        }
      },
    });
    sttStreams.set(participantId, stream);
    return stream;
  }

  const handlers = {
    onParticipantJoin({ participantId, name, isHost }) {
      ensureSpeaker(sessionId, { participantId, name, isHost }).catch((err) =>
        logger.error('ensureSpeaker failed', { sessionId, error: err.message }),
      );
    },
    onParticipantLeave({ participantId }) {
      const stream = sttStreams.get(participantId);
      if (stream) {
        stream.close();
        sttStreams.delete(participantId);
      }
    },
    onAudio({ participantId, name, chunk }) {
      getOrCreateStream(participantId, name)
        .then((stream) => stream.write(chunk))
        .catch((err) => logger.error('stt route failed', { sessionId, error: err.message }));
    },
    onChat({ participantId, name, text }) {
      handleChatMessage(sessionId, { participantId, name, text }).catch((err) =>
        logger.error('chat command failed', { sessionId, error: err.message }),
      );
    },
    onStatus({ status }) {
      publishEvent(sessionId, 'meeting.status', { status }).catch(() => {});
      if (status === 'in_call') setSessionStatus(sessionId, 'live').catch(() => {});
      if (status === 'call_ended') {
        // End-of-call: finish pipeline work (receipts etc. handled by brain stop)
        stopPipeline(sessionId).catch((err) =>
          logger.error('auto stop failed', { sessionId, error: err.message }),
        );
      }
    },
  };

  controller = await meeting.startMeeting(session, handlers);
  brain = await startBrain(sessionId, brainOptions);

  registerPipeline(sessionId, {
    async stop() {
      stopped = true;
      for (const [, stream] of sttStreams) stream.close();
      sttStreams.clear();
      if (controller) await controller.stop().catch(() => {});
      if (brain) await brain.stop().catch(() => {});
      await flushTranscript(sessionId);
      const current = await getSession(sessionId);
      if (current && current.status !== 'ended') await setSessionStatus(sessionId, 'ended');
      logger.info('pipeline stopped', { sessionId });
    },
    sendChat: (text) => (controller?.sendChat ? controller.sendChat(text) : Promise.resolve()),
    brain: () => brain,
  });

  logger.info('pipeline started', {
    sessionId,
    meeting: meeting.kind,
    stt: stt.kind,
  });
  return { alreadyRunning: false, botId: controller.botId };
}
