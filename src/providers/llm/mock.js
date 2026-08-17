// Heuristic mock LLM: deterministic, offline, tuned to behave sensibly on
// natural debate transcripts (and exactly right on the test fixture). Keeps
// the entire brain pipeline runnable with zero API keys (ADR-0005).
const OPINION_RE = /\b(i believe|in my opinion|i think|should\b|the wrong tool|the fairest)\b/i;
const PREDICTION_RE = /\b(i predict|will (adopt|slip|quietly)|within (five|two) years)\b/i;
const FACTUAL_RE = /\b(\d+|tripled|doubled|eighty percent|percent|lowest|highest|visible from|emit (more|far less)|according to|studies show)\b/i;
const AD_HOMINEM_RE = /\b(never worked a day|clearly doesn't understand|doesn't understand real|idiot|incompetent|of course \w+ would say)\b/i;
const UNCHECKABLE_RE = /\b(privately agree|everyone knows|real engineering)\b/i;

export function createMockLlm() {
  return {
    kind: 'mock',

    async extractClaims({ speakers, chunkText }) {
      const claims = [];
      const fallacies = [];
      // The chunk arrives as "Speaker: text" lines (built by the extractor).
      for (const line of chunkText.split('\n')) {
        const m = line.match(/^(.+?):\s+(.+)$/);
        if (!m) continue;
        const [, speaker, text] = m;
        if (!speakers.includes(speaker)) continue;

        if (AD_HOMINEM_RE.test(text)) {
          fallacies.push({
            speaker,
            label: 'Ad hominem',
            detail: 'Attacked the opponent personally instead of the argument.',
            confidence: 0.9,
          });
          continue;
        }

        // Split into sentences; classify each independently so one utterance
        // can yield e.g. an opinion AND a prediction.
        const sentences = text.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 12);
        for (const sentence of sentences) {
          const s = sentence.trim();
          let type = null;
          if (/\?\s*$/.test(s)) type = 'question';
          else if (PREDICTION_RE.test(s)) type = 'prediction';
          else if (OPINION_RE.test(s)) type = 'opinion';
          else if (FACTUAL_RE.test(s)) type = 'factual';
          if (!type) continue;
          claims.push({
            text: s,
            speaker,
            type,
            checkable: type === 'factual' && !UNCHECKABLE_RE.test(s),
            links: [],
          });
        }
      }
      return { claims, fallacies };
    },

    async judgeClaim({ claim, results }) {
      if (!results || results.length === 0) {
        return {
          verdict: 'UNVERIFIABLE',
          confidence: 0.5,
          evidence_summary: 'No sources found that address this claim.',
          sources: [],
        };
      }
      // Mock search results carry a _verdictHint for the matched claim pattern.
      const hinted = results.find((r) => r._verdictHint);
      if (!hinted) {
        return {
          verdict: 'UNVERIFIABLE',
          confidence: 0.55,
          evidence_summary: 'Sources found but none settle the claim.',
          sources: results.slice(0, 1).map((r) => ({ name: r.title, url: r.url })),
        };
      }
      return {
        verdict: hinted._verdictHint,
        confidence: hinted._confidenceHint ?? 0.9,
        evidence_summary: hinted.snippet,
        sources: [{ name: hinted.title, url: hinted.url }],
      };
    },

    async generateReceipts({ stats }) {
      const byAccuracy = [...(stats.speakers || [])].sort(
        (a, b) => (b.subs?.accuracy ?? 0) - (a.subs?.accuracy ?? 0),
      );
      const winner = [...(stats.speakers || [])].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
      return {
        headline: winner ? `${winner.speaker} takes the debate on the numbers.` : 'Debate complete.',
        winner: winner?.speaker,
        most_accurate: byAccuracy[0]?.speaker,
        least_accurate: byAccuracy.length > 1 ? byAccuracy[byAccuracy.length - 1].speaker : undefined,
        biggest_unsupported_claim: stats.biggest_unsupported_claim,
      };
    },
  };
}
