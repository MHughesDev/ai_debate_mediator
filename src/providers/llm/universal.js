// Builds an LlmProvider for whichever backend LLM_PROVIDER names.
//
// Everything vendor-specific is data (registry.js) or transport (dialects/).
// This file only resolves configuration and enforces one rule: fail loudly at
// construction with an actionable message, rather than at 3am mid-debate with
// "HTTP 404 model not found".
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { recordLlmUsage } from '../../pipeline/costMeter.js';
import { getProviderSpec, resolveModel, TASKS } from './registry.js';
import { createTasks } from './tasks.js';
import { createOpenAiDialect } from './dialects/openai.js';
import { createAnthropicDialect } from './dialects/anthropic.js';
import { createGeminiDialect } from './dialects/gemini.js';

const DIALECTS = {
  openai: createOpenAiDialect,
  anthropic: createAnthropicDialect,
  gemini: createGeminiDialect,
};

export function createUniversalLlm({
  providerId = config.llmProvider,
  env = process.env,
  fetchImpl,
  baseUrl: baseUrlOverride,
} = {}) {
  const spec = getProviderSpec(providerId);

  const baseUrl = (baseUrlOverride || config.llmBaseUrl || spec.baseUrl || '').trim();
  if (!baseUrl) {
    throw new Error(
      `LLM_PROVIDER=${spec.id} (${spec.label}) needs LLM_BASE_URL to be set — it has no fixed endpoint.`,
    );
  }

  // A generic LLM_API_KEY works for every provider, so a gateway or an unusual
  // setup does not need us to know its vendor-specific variable name.
  const apiKey = (env[spec.apiKeyEnv] || config.llmApiKey || '').trim();
  if (!apiKey && !spec.keyOptional) {
    throw new Error(
      `LLM_PROVIDER=${spec.id} (${spec.label}) needs ${spec.apiKeyEnv} (or LLM_API_KEY). Get one at ${spec.docs}`,
    );
  }

  const models = {};
  for (const task of TASKS) {
    const model = resolveModel(spec, task, env);
    if (!model) {
      const hint = spec.modelHint ? ` — ${spec.modelHint}` : '';
      throw new Error(
        `LLM_PROVIDER=${spec.id} (${spec.label}) has no default model for "${task}". ` +
          `Set LLM_MODEL in .env to use one model for everything, or ${task.toUpperCase()}_MODEL ` +
          `for this task alone${hint}.`,
      );
    }
    models[task] = model;
  }

  const makeDialect = DIALECTS[spec.dialect];
  if (!makeDialect) throw new Error(`no dialect implementation for "${spec.dialect}"`);
  const dialect = makeDialect({ spec, apiKey, baseUrl, fetchImpl });

  async function run({ task, sessionId, model, system, prompt, schema, maxTokens, effort }) {
    const started = Date.now();
    const { data, usage, refused } = await dialect.structured({
      model, system, prompt, schema, maxTokens, effort,
    });

    if (sessionId && usage) {
      recordLlmUsage(sessionId, model, usage.input, usage.output).catch(() => {});
    }
    if (refused) return null;
    if (data === null) {
      // Transport succeeded but we could not get a usable object out of it.
      // Callers fall back to their documented safe result.
      logger.warn('llm returned unusable output', {
        provider: spec.id, task, model, ms: Date.now() - started,
      });
    }
    return data;
  }

  const provider = createTasks(run, (task) => models[task], spec.id);
  return {
    ...provider,
    // Load the model before the debate needs it. A self-hosted 7B takes ~50s to
    // page in on first use but ~4s once warm, so without this the first minute
    // of a debate produces no claims. Fire-and-forget: warming is an
    // optimisation, and its failure must never block a session starting.
    async warmup() {
      const unique = [...new Set(Object.values(models))];
      await Promise.all(
        unique.map((model) =>
          dialect
            .structured({
              model,
              system: 'Reply with JSON only.',
              prompt: 'Return {"ok":true}',
              schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
              maxTokens: 16,
            })
            .catch((err) => logger.debug('llm warmup failed', { model, error: err.message })),
        ),
      );
    },

    // Ask the endpoint which models it actually serves. Returns null when the
    // provider does not implement listing, which is not an error.
    listModels: (opts) => (dialect.listModels ? dialect.listModels(opts) : Promise.resolve(null)),
    // Surfaced by /healthz and preflight so it is obvious what is actually
    // running — the single most common source of confusion when a debate
    // behaves unlike the last one.
    describe: () => ({
      provider: spec.id,
      label: spec.label,
      dialect: spec.dialect,
      baseUrl,
      models,
      keyed: !!apiKey,
    }),
  };
}
