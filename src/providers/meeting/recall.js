// Recall.ai meeting provider (ADR-0001).
// - Creates a bot whose camera is our display page (Output Media webpage).
// - Receives per-participant audio + participant/chat events over Recall's
//   realtime websocket, which connects BACK to this server at /ws/recall.
//   That requires PUBLIC_BASE_URL to be reachable from Recall's cloud.
//
// NOTE: request/response shapes follow Recall's v1 bot API as documented at
// docs.recall.ai (create bot, output_media webpage, realtime_endpoints).
// First live run should be smoke-tested; all shape mapping is centralized in
// parseRecallRealtimeMessage() below and covered by unit tests.
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const intakeTargets = new Map(); // sessionId -> handlers (set while a session pipeline is live)

export function registerRecallIntake(sessionId, handlers) {
  intakeTargets.set(sessionId, handlers);
  return () => intakeTargets.delete(sessionId);
}

// Maps a raw Recall realtime websocket message to our provider handler calls.
// Returns { handler, payload } or null when the message is irrelevant.
export function parseRecallRealtimeMessage(msg) {
  const event = msg?.event;
  const data = msg?.data;
  if (!event || !data) return null;
  switch (event) {
    case 'audio_separate_raw.data': {
      const participant = data.data?.participant || data.participant || {};
      const b64 = data.data?.buffer ?? data.buffer;
      if (!b64) return null;
      return {
        handler: 'onAudio',
        payload: {
          participantId: String(participant.id ?? 'unknown'),
          name: participant.name || null,
          chunk: Buffer.from(b64, 'base64'),
        },
      };
    }
    case 'participant_events.join': {
      const p = data.data?.participant || data.participant || {};
      return {
        handler: 'onParticipantJoin',
        payload: { participantId: String(p.id ?? 'unknown'), name: p.name || 'Unknown', isHost: !!p.is_host },
      };
    }
    case 'participant_events.leave': {
      const p = data.data?.participant || data.participant || {};
      return { handler: 'onParticipantLeave', payload: { participantId: String(p.id ?? 'unknown') } };
    }
    case 'participant_events.chat_message': {
      const p = data.data?.participant || data.participant || {};
      const text = data.data?.text ?? data.text ?? '';
      return {
        handler: 'onChat',
        payload: { participantId: String(p.id ?? 'unknown'), name: p.name || 'Unknown', text },
      };
    }
    default:
      return null;
  }
}

// Called by the ws hub when Recall's realtime socket delivers a message.
export function dispatchRecallMessage(sessionId, rawJson) {
  const handlers = intakeTargets.get(sessionId);
  if (!handlers) return;
  let msg;
  try {
    msg = JSON.parse(rawJson);
  } catch {
    return;
  }
  const mapped = parseRecallRealtimeMessage(msg);
  if (!mapped) return;
  const fn = handlers[mapped.handler];
  if (fn) fn(mapped.payload);
}

function apiBase() {
  return `https://${config.recallRegion}.recall.ai/api/v1`;
}

async function recallFetch(path, options = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Token ${config.recallApiKey}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Recall API ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

export function createRecallProvider() {
  return {
    kind: 'recall',

    async startMeeting(session, handlers) {
      if (!config.publicBaseUrl) {
        throw new Error('PUBLIC_BASE_URL must be set for Recall (display page + realtime intake URLs)');
      }
      const base = config.publicBaseUrl.replace(/\/$/, '');
      const wsBase = base.replace(/^http/, 'ws');
      const displayUrl = `${base}/display/?session=${session.id}`;
      const intakeUrl = `${wsBase}/ws/recall?session=${session.id}`;

      const unregister = registerRecallIntake(session.id, handlers);

      const bot = await recallFetch('/bot/', {
        method: 'POST',
        body: JSON.stringify({
          meeting_url: session.meetingUrl,
          bot_name: 'AI Debate Mediator',
          // Per-participant audio is compute heavy and Recall requires 4-core
          // bots for it. Without this the separate streams we depend on for
          // speaker attribution are not reliably delivered.
          variant: {
            zoom: 'web_4_core',
            google_meet: 'web_4_core',
            microsoft_teams: 'web_4_core',
          },
          output_media: {
            camera: { kind: 'webpage', config: { url: displayUrl } },
          },
          recording_config: {
            audio_separate_raw: {},
            participant_events: {},
            realtime_endpoints: [
              {
                type: 'websocket',
                url: intakeUrl,
                events: [
                  'audio_separate_raw.data',
                  'participant_events.join',
                  'participant_events.leave',
                  'participant_events.chat_message',
                ],
              },
            ],
          },
        }),
      });
      logger.info('recall bot created', { sessionId: session.id, botId: bot.id });
      handlers.onStatus({ status: 'bot_joining' });

      return {
        botId: bot.id,
        async stop() {
          unregister();
          try {
            await recallFetch(`/bot/${bot.id}/leave_call/`, { method: 'POST' });
          } catch (err) {
            logger.warn('recall leave_call failed', { error: err.message });
          }
        },
        async sendChat(text) {
          await recallFetch(`/bot/${bot.id}/send_chat_message/`, {
            method: 'POST',
            body: JSON.stringify({ message: text }),
          });
        },
      };
    },
  };
}
