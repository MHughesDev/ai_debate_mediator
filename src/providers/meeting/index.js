// MeetingProvider interface (ADR-0001: isolate Recall behind this seam).
//
// A provider implements:
//   startMeeting(session, handlers) -> Promise<controller>
//     handlers: {
//       onParticipantJoin({ participantId, name, isHost }),
//       onParticipantLeave({ participantId }),
//       onAudio({ participantId, chunk }),   // vendor-shaped chunk, fed to SttProvider stream
//       onChat({ participantId, name, text }),
//       onStatus({ status, detail }),
//     }
//     controller: { botId?, stop(): Promise, sendChat?(text): Promise }
import { config } from '../../config.js';
import { createRecallProvider } from './recall.js';
import { createMockMeetingProvider } from './mock.js';

export function getMeetingProvider() {
  switch (config.meetingProvider) {
    case 'recall':
      return createRecallProvider();
    case 'mock':
      return createMockMeetingProvider();
    default:
      throw new Error(`unknown MEETING_PROVIDER: ${config.meetingProvider}`);
  }
}
