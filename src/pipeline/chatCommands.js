// In-call chat commands (SPEC §3.6). Phase 1 ships the parser + /end;
// Phase 3 wires /mode, /pause scoring, /resume, /check that.
import { publishEvent } from '../sessions/events.js';
import { logger } from '../logger.js';

// Command registry: name -> async ({sessionId, args, from}) handler.
// Later phases replace these stubs via registerChatCommand.
const commands = new Map();

export function registerChatCommand(name, handler) {
  commands.set(name, handler);
}

export function parseChatCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: head.toLowerCase(), args: rest };
}

export async function handleChatMessage(sessionId, { participantId, name, text }) {
  const cmd = parseChatCommand(text);
  if (!cmd) return false;
  const handler = commands.get(cmd.name);
  if (!handler) {
    logger.debug('unknown chat command', { sessionId, command: cmd.name });
    return false;
  }
  await handler({ sessionId, args: cmd.args, from: { participantId, name } });
  await publishEvent(sessionId, 'command', { name: cmd.name, args: cmd.args, from: name });
  return true;
}

// /end — host kill switch (available from Phase 1).
registerChatCommand('end', async ({ sessionId }) => {
  const { stopPipeline } = await import('./runtime.js');
  await stopPipeline(sessionId);
});
