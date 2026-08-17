// SttProvider interface (ADR-0004: Deepgram vs AssemblyAI bake-off pending,
// both behind this seam; mock passes scripted text through).
//
// A provider implements:
//   createStream({ sessionId, participantId, onTranscript }) -> { write(chunk), close() }
//     onTranscript({ text, isFinal, ts })
import { config } from '../../config.js';
import { createDeepgramProvider } from './deepgram.js';
import { createAssemblyAiProvider } from './assemblyai.js';
import { createMockSttProvider } from './mock.js';

export function getSttProvider() {
  switch (config.sttProvider) {
    case 'deepgram':
      return createDeepgramProvider();
    case 'assemblyai':
      return createAssemblyAiProvider();
    case 'mock':
      return createMockSttProvider();
    default:
      throw new Error(`unknown STT_PROVIDER: ${config.sttProvider}`);
  }
}
