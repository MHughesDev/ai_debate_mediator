// Brain runner placeholder: Phase 2 replaces this with the claim extractor
// loop + verification workers + (Phase 3) score engine. Kept separate so the
// session pipeline wiring is stable from Phase 1 onward.
export async function startBrain(_sessionId) {
  return {
    async stop() {},
  };
}
