// Registry of per-session pipeline runners (meeting/STT/extractor/verifier/scorer).
// Phase 0 ships the registry + flush hooks so shutdown is correct from day one;
// later phases register their runners here.
const pipelines = new Map(); // sessionId -> { stop: async fn }

export function registerPipeline(sessionId, runner) {
  pipelines.set(sessionId, runner);
}

export function getPipeline(sessionId) {
  return pipelines.get(sessionId) || null;
}

export async function stopPipeline(sessionId) {
  const runner = pipelines.get(sessionId);
  if (!runner) return;
  pipelines.delete(sessionId);
  await runner.stop();
}

export async function stopAllPipelines() {
  await Promise.allSettled([...pipelines.keys()].map((id) => stopPipeline(id)));
}
