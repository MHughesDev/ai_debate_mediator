// Env-var-only configuration (design contract #5). Every knob lives here.
import { resolveProviderId } from './providers/llm/registry.js';

const env = process.env;

const int = (v, d) => (v !== undefined && v !== '' ? parseInt(v, 10) : d);
const num = (v, d) => (v !== undefined && v !== '' ? parseFloat(v) : d);
const bool = (v, d = false) => (v === undefined || v === '' ? d : v === 'true' || v === '1');

export const config = {
  port: int(env.PORT, 8080),
  publicBaseUrl: env.PUBLIC_BASE_URL || '', // e.g. https://myapp.onrender.com — used for bot display page URL
  logLevel: env.LOG_LEVEL || 'info',

  // External state (ADR-0003). Unset => in-memory fallbacks (ADR-0005, dev/test only).
  redisUrl: env.REDIS_URL || '',
  databaseUrl: env.DATABASE_URL || '',

  // Vendor providers (each has a mock)
  meetingProvider: env.MEETING_PROVIDER || (env.RECALL_API_KEY ? 'recall' : 'mock'),
  // The mock meeting provider emits {text} chunks rather than audio, so only
  // the mock STT can consume them — they are a matched pair. Auto-selecting a
  // real STT vendor just because a key exists silently produces zero
  // transcript. An explicit STT_PROVIDER still wins.
  sttProvider:
    env.STT_PROVIDER ||
    (!env.MEETING_PROVIDER && !env.RECALL_API_KEY
      ? 'mock'
      : env.DEEPGRAM_API_KEY
        ? 'deepgram'
        : env.ASSEMBLYAI_API_KEY
          ? 'assemblyai'
          : 'mock'),
  // Our own search layer (ADR-0006) is the default: it needs no API key
  // (Wikipedia/Wikidata) and improves as backends are configured.
  // Always our own engine unless explicitly overridden. Exa and Tavily keys
  // activate them as FEDERATED BACKENDS (ADR-0006); they must not silently
  // replace the whole retrieval layer, which is what auto-selection did.
  searchProvider: env.SEARCH_PROVIDER || 'own',
  // One global switch across every LLM backend (ADR-0007). Explicit
  // LLM_PROVIDER wins; otherwise the first vendor whose key is present.
  llmProvider: resolveProviderId(env),

  // Vendor credentials
  recallApiKey: env.RECALL_API_KEY || '',
  recallRegion: env.RECALL_REGION || 'us-west-2',
  deepgramApiKey: env.DEEPGRAM_API_KEY || '',
  assemblyaiApiKey: env.ASSEMBLYAI_API_KEY || '',
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  tavilyApiKey: env.TAVILY_API_KEY || '',
  exaApiKey: env.EXA_API_KEY || '',

  // ---- Own search engine (ADR-0006) ----
  // Backends: Wikipedia needs no key; the rest activate when configured.
  braveApiKey: env.BRAVE_API_KEY || '',
  // Brave's Search plan allows 50 requests/sec, so pacing is not the binding
  // constraint — spend is. The plan bills $5 per 1,000 requests against $5 of
  // monthly credit, so the budget is roughly 1,000 requests/month. We stay well
  // under the rate ceiling and cap how many of a claim's planned queries may
  // spend credit (see rateLimiter.js).
  braveQps: num(env.BRAVE_QPS, 20),
  braveMaxQueries: int(env.BRAVE_MAX_QUERIES, 1),
  googleCseKey: env.GOOGLE_CSE_KEY || '',
  googleCseCx: env.GOOGLE_CSE_CX || '',
  searxngUrl: env.SEARXNG_URL || '',
  searxngToken: env.SEARXNG_TOKEN || '',
  searchWikipediaEnabled: bool(env.SEARCH_WIKIPEDIA, true),
  searchBackends: (env.SEARCH_BACKENDS || '').split(',').filter(Boolean),
  // Latency budget. Verdict budget is 8-20s end to end (SPEC §3.1), so search
  // gets a hard ceiling and degrades to partial evidence rather than stalling.
  searchDeadlineMs: int(env.SEARCH_DEADLINE_MS, 4500),
  searchRetrieveMs: int(env.SEARCH_RETRIEVE_MS, 1800),
  searchBackendTimeoutMs: int(env.SEARCH_BACKEND_TIMEOUT_MS, 1500),
  searchFetchDeadlineMs: int(env.SEARCH_FETCH_DEADLINE_MS, 2500),
  searchMaxCandidates: int(env.SEARCH_MAX_CANDIDATES, 10),
  searchMaxFetch: int(env.SEARCH_MAX_FETCH, 5),
  searchMaxPerDomain: int(env.SEARCH_MAX_PER_DOMAIN, 2),
  searchMaxPageBytes: int(env.SEARCH_MAX_PAGE_BYTES, 1200000),
  searchCacheTtlSec: int(env.SEARCH_CACHE_TTL_SEC, 60 * 60 * 6),
  // Some vendors (Brave) permit only transient caching of their results. When
  // such a backend contributed, this shorter TTL applies instead: long enough
  // to serve a repeated claim inside one debate, short enough to be operational
  // rather than a stored database of their results.
  searchRestrictedCacheTtlSec: int(env.SEARCH_RESTRICTED_CACHE_TTL_SEC, 300),
  searchBreakerCooldownMs: int(env.SEARCH_BREAKER_COOLDOWN_MS, 60000),
  // Identify the bot honestly to the sites we read.
  searchUserAgent:
    env.SEARCH_USER_AGENT ||
    'AIDebateMediatorBot/1.0 (+https://github.com/MHughesDev/ai_debate_mediator)',

  // Models are resolved per provider in src/providers/llm/registry.js:
  // EXTRACTOR_MODEL / JUDGE_MODEL / RECEIPTS_MODEL override the
  // provider's defaults. Extraction is the fast, cheap loop; judging, scoring
  // and receipts decide what goes on screen and use the strong model.

  // Point any provider at a different endpoint: a self-hosted server, a
  // gateway, an Azure deployment, a proxy.
  // Cap on a single LLM request. Without one we inherit Node's 300s default,
  // which is long enough for a local model swap to hold a socket for five
  // minutes — measured, not hypothetical.
  llmRequestTimeoutMs: int(env.LLM_REQUEST_TIMEOUT_MS, 120000),
  llmBaseUrl: env.LLM_BASE_URL || '',
  // Works for every provider, so an unusual setup does not need us to know its
  // vendor-specific variable name.
  llmApiKey: env.LLM_API_KEY || '',

  // Pipeline tunables (latency budgets in SPEC §3.1)
  extractIntervalMs: int(env.EXTRACT_INTERVAL_MS, 5000),
  verifyConcurrency: int(env.VERIFY_CONCURRENCY, 3),
  verifyTimeoutMs: int(env.VERIFY_TIMEOUT_MS, 25000),
  searchesPerClaim: int(env.SEARCHES_PER_CLAIM, 2),
  scoreIntervalMs: int(env.SCORE_INTERVAL_MS, 20000),
  utteranceFlushMs: int(env.UTTERANCE_FLUSH_MS, 5000),
  transcriptWindowChars: int(env.TRANSCRIPT_WINDOW_CHARS, 24000),

  // Credibility thresholds (SPEC §3.1 non-negotiable rules; FALSE bar is highest)
  verdictMinConfidence: num(env.VERDICT_MIN_CONFIDENCE, 0.6),
  falseVerdictMinConfidence: num(env.FALSE_VERDICT_MIN_CONFIDENCE, 0.85),
  fallacyMinConfidence: num(env.FALLACY_MIN_CONFIDENCE, 0.85),
  dodgeTimeoutMs: int(env.DODGE_TIMEOUT_MS, 90000),

  // WS / event bus
  wsHeartbeatMs: int(env.WS_HEARTBEAT_MS, 15000),
  eventBacklogSize: int(env.EVENT_BACKLOG_SIZE, 500),
  sessionTtlSec: int(env.SESSION_TTL_SEC, 60 * 60 * 24),

  // Dev/demo
  mockEvents: bool(env.MOCK_EVENTS),

  // Cost rates (USD) for the per-session cost meter (Phase 5); override as vendors reprice
  costRates: {
    botHour: num(env.COST_BOT_HOUR, 0.85),
    sttHour: num(env.COST_STT_HOUR, 0.45),
    searchCall: num(env.COST_SEARCH_CALL, 0.005),
    llmIn: {
      // $ per 1M input tokens
      'claude-haiku-4-5': num(env.COST_HAIKU_IN, 1.0),
      'claude-opus-5': num(env.COST_OPUS_IN, 5.0),
    },
    llmOut: {
      'claude-haiku-4-5': num(env.COST_HAIKU_OUT, 5.0),
      'claude-opus-5': num(env.COST_OPUS_OUT, 25.0),
    },
  },
};

export function bootWarnings() {
  const warnings = [];
  if (!config.redisUrl) warnings.push('REDIS_URL unset — using in-memory state (dev only; not for deployment)');
  if (!config.databaseUrl) warnings.push('DATABASE_URL unset — persistence disabled (dev only)');
  if (config.llmProvider === 'mock') warnings.push('ANTHROPIC_API_KEY unset — using heuristic mock LLM');
  if (config.meetingProvider === 'mock') warnings.push('RECALL_API_KEY unset — meeting provider is mock (scripted playback)');
  return warnings;
}
