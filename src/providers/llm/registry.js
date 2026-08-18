// Catalog of every LLM backend the app can talk to.
//
// Switching provider is one global: LLM_PROVIDER=<id>. Everything else
// (endpoint, auth style, request shape, default models) is looked up here, so
// adding a vendor is a table entry rather than a new code path.
//
// Only three request dialects exist in practice, and almost every vendor
// speaks one of them:
//   openai    — POST {baseUrl}/chat/completions, Bearer auth. The de facto
//               standard: OpenAI, Azure, Groq, Together, Fireworks, DeepSeek,
//               Mistral, xAI, OpenRouter, and every local server worth using
//               (Ollama, vLLM, LM Studio, llama.cpp, LocalAI).
//   anthropic — POST {baseUrl}/v1/messages, x-api-key auth.
//   gemini    — POST {baseUrl}/models/{model}:generateContent.
//
// MODEL IDS DRIFT — these were re-verified against vendor docs on 2026-08-17,
// and 8 of the 14 ids written six months earlier had already been retired.
// Vendors rename and retire models constantly, so the defaults
// below are a starting point, not a promise. LLM_MODEL overrides everything at
// once (the usual case when self-hosting), EXTRACTOR_MODEL / JUDGE_MODEL /
// RECEIPTS_MODEL override per task; EXTRACTOR_PROVIDER / JUDGE_PROVIDER /
// RECEIPTS_PROVIDER route a task to a different backend entirely. `npm run
// preflight`
// reports exactly which model id it resolved and whether the vendor accepted it.
//
// `fast` runs the extraction loop (every few seconds, cost-sensitive); `strong`
// judges claims and writes receipts, where quality matters more than latency.

export const PROVIDERS = {
  // ---------------------------------------------------------------- hosted
  anthropic: {
    label: 'Anthropic',
    dialect: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: { fast: 'claude-haiku-4-5', strong: 'claude-opus-5' },
    docs: 'https://console.anthropic.com',
  },
  openai: {
    label: 'OpenAI',
    dialect: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: { fast: 'gpt-5.6-luna', strong: 'gpt-5.6-terra' },
    docs: 'https://platform.openai.com',
  },
  google: {
    label: 'Google Gemini',
    dialect: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
    models: { fast: 'gemini-2.5-flash', strong: 'gemini-2.5-pro' },
    docs: 'https://aistudio.google.com',
  },
  azure: {
    label: 'Azure OpenAI',
    dialect: 'openai',
    // Azure has no shared host: set LLM_BASE_URL to
    // https://<resource>.openai.azure.com/openai/deployments/<deployment>
    // and use your DEPLOYMENT name as the model id.
    baseUrl: '',
    apiKeyEnv: 'AZURE_OPENAI_API_KEY',
    authStyle: 'api-key-header',
    requiresBaseUrl: true,
    models: {},
    docs: 'https://learn.microsoft.com/azure/ai-services/openai/',
  },
  groq: {
    label: 'Groq',
    dialect: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    models: { fast: 'openai/gpt-oss-20b', strong: 'openai/gpt-oss-120b' },
    docs: 'https://console.groq.com',
  },
  together: {
    label: 'Together AI',
    dialect: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    models: {
      fast: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      strong: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    },
    docs: 'https://api.together.ai',
  },
  fireworks: {
    label: 'Fireworks AI',
    dialect: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    models: {
      fast: 'accounts/fireworks/models/gpt-oss-20b',
      strong: 'accounts/fireworks/models/gpt-oss-120b',
    },
    docs: 'https://fireworks.ai',
  },
  openrouter: {
    label: 'OpenRouter',
    dialect: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    // Routes to hundreds of models, so there is no sensible default: model ids
    // are namespaced like "anthropic/claude-sonnet-4" or "openai/gpt-4.1-mini".
    models: {},
    docs: 'https://openrouter.ai/models',
  },
  deepseek: {
    label: 'DeepSeek',
    dialect: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // DeepSeek offers json_object only — no schema constraint. The openai
    // dialect's negotiation handles that by stepping down a rung.
    models: { fast: 'deepseek-v4-flash', strong: 'deepseek-v4-pro' },
    docs: 'https://platform.deepseek.com',
  },
  mistral: {
    label: 'Mistral',
    dialect: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    models: { fast: 'mistral-small-4', strong: 'mistral-large-3' },
    docs: 'https://console.mistral.ai',
  },
  xai: {
    label: 'xAI Grok',
    dialect: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    models: { fast: 'grok-build-0.1', strong: 'grok-4.6' },
    docs: 'https://console.x.ai',
  },
  cerebras: {
    label: 'Cerebras',
    dialect: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    models: { fast: 'gpt-oss-120b', strong: 'gpt-oss-120b' },
    docs: 'https://cloud.cerebras.ai',
  },

  // ------------------------------------------- self-hosted / bring your own
  // These need no API key: the "key" is that you are running the server. Point
  // LLM_BASE_URL at it if it is not on the default port, and set the model env
  // vars to whatever the server actually has loaded.
  ollama: {
    label: 'Ollama (local)',
    dialect: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY', // optional; Ollama ignores auth by default
    keyOptional: true,
    // You run it, so tokens cost nothing — the cost meter must not price
    // these at a hosted vendor's rate.
    selfHosted: true,
    models: {},
    modelHint: 'run `ollama list` and set LLM_MODEL to one of them',
    docs: 'https://ollama.com',
  },
  vllm: {
    label: 'vLLM (self-hosted)',
    dialect: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    apiKeyEnv: 'VLLM_API_KEY',
    keyOptional: true,
    // You run it, so tokens cost nothing — the cost meter must not price
    // these at a hosted vendor's rate.
    selfHosted: true,
    models: {},
    modelHint: 'use the --model id the server was started with',
    docs: 'https://docs.vllm.ai',
  },
  lmstudio: {
    label: 'LM Studio (local)',
    dialect: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    apiKeyEnv: 'LMSTUDIO_API_KEY',
    keyOptional: true,
    // You run it, so tokens cost nothing — the cost meter must not price
    // these at a hosted vendor's rate.
    selfHosted: true,
    models: {},
    modelHint: 'copy the model id from the LM Studio server tab',
    docs: 'https://lmstudio.ai',
  },
  llamacpp: {
    label: 'llama.cpp server (local)',
    dialect: 'openai',
    baseUrl: 'http://localhost:8080/v1',
    apiKeyEnv: 'LLAMACPP_API_KEY',
    keyOptional: true,
    // You run it, so tokens cost nothing — the cost meter must not price
    // these at a hosted vendor's rate.
    selfHosted: true,
    models: {},
    modelHint: 'llama.cpp accepts any model id; it serves whatever was loaded',
    docs: 'https://github.com/ggml-org/llama.cpp',
  },
  localai: {
    label: 'LocalAI (self-hosted)',
    dialect: 'openai',
    baseUrl: 'http://localhost:8080/v1',
    apiKeyEnv: 'LOCALAI_API_KEY',
    keyOptional: true,
    // You run it, so tokens cost nothing — the cost meter must not price
    // these at a hosted vendor's rate.
    selfHosted: true,
    models: {},
    docs: 'https://localai.io',
  },
  // Any other OpenAI-compatible endpoint: a proxy, a gateway, a cloud VM
  // running something else. Set LLM_BASE_URL and LLM_API_KEY.
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    dialect: 'openai',
    baseUrl: '',
    apiKeyEnv: 'LLM_API_KEY',
    keyOptional: true,
    requiresBaseUrl: true,
    models: {},
    docs: '(set LLM_BASE_URL)',
  },

  mock: {
    label: 'Mock (offline)',
    dialect: 'mock',
    baseUrl: '',
    apiKeyEnv: '',
    keyOptional: true,
    models: {},
  },
};

export function getProviderSpec(id) {
  const spec = PROVIDERS[id];
  if (!spec) {
    throw new Error(
      `unknown LLM_PROVIDER: ${id}. Available: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return { id, ...spec };
}

/**
 * Which provider should run, given the environment.
 *
 * Explicit LLM_PROVIDER always wins. Otherwise pick the first hosted provider
 * whose key is present, so pasting a key into .env is all it takes. Local
 * servers are never auto-selected: we cannot tell whether one is running, and
 * silently failing to reach localhost is worse than an honest mock.
 */
export function resolveProviderId(env = process.env, task) {
  const perTask = task && env[TASK_PROVIDER_ENV[task]];
  if (perTask) return perTask.trim().toLowerCase();
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER.trim().toLowerCase();
  const autoOrder = [
    'anthropic', 'openai', 'google', 'groq', 'deepseek',
    'mistral', 'xai', 'together', 'fireworks', 'cerebras', 'openrouter',
  ];
  for (const id of autoOrder) {
    if (env[PROVIDERS[id].apiKeyEnv]) return id;
  }
  return 'mock';
}

// Extraction runs every few seconds and wants the cheap model; the rest decide
// what goes on screen and want the good one.
const TASK_ENV = {
  extractor: 'EXTRACTOR_MODEL',
  judge: 'JUDGE_MODEL',
  receipts: 'RECEIPTS_MODEL',
};
const TASK_TIER = { extractor: 'fast', judge: 'strong', receipts: 'strong' };

// Each task may be routed to a DIFFERENT backend. The reason is economic:
// extraction is ~720 calls per debate and wants a cheap local model, while
// judging is ~40 calls that decide what appears on screen and wants the
// strongest model available. Scoring is deterministic and uses no LLM.
const TASK_PROVIDER_ENV = {
  extractor: 'EXTRACTOR_PROVIDER',
  judge: 'JUDGE_PROVIDER',
  receipts: 'RECEIPTS_PROVIDER',
};

// A task can also be pointed at its own endpoint — two local servers on
// different ports (a small model for extraction, a large one for judging) is
// the obvious case, since one server serialises requests behind one model.
const TASK_BASE_URL_ENV = {
  extractor: 'EXTRACTOR_BASE_URL',
  judge: 'JUDGE_BASE_URL',
  receipts: 'RECEIPTS_BASE_URL',
};

export function resolveTaskBaseUrl(task, env = process.env) {
  return (env[TASK_BASE_URL_ENV[task]] || '').trim();
}

export const TASKS = Object.keys(TASK_ENV);

/**
 * Resolve the model id for one task:
 *   1. the per-task variable (EXTRACTOR_MODEL, JUDGE_MODEL, ...)
 *   2. LLM_MODEL, one model for everything — which is the normal case when you
 *      are self-hosting, because the server has exactly one model loaded and
 *      naming it four times is friction for no benefit
 *   3. the provider's default for this task's tier
 *
 * Returns '' when nothing is known; callers must surface that as a clear error
 * rather than sending an empty model id.
 */
export function resolveModel(spec, task, env = process.env, globalProviderId) {
  const explicit = env[TASK_ENV[task]];
  if (explicit) return explicit.trim();
  // LLM_MODEL names a model on the DEFAULT provider. It must not leak to a task
  // routed elsewhere, or a local model id gets sent to a hosted vendor.
  if (env.LLM_MODEL && (!globalProviderId || spec.id === globalProviderId)) return env.LLM_MODEL.trim();
  return spec.models?.[TASK_TIER[task]] || '';
}
