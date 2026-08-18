// LlmProvider interface — task-level so the mock can be heuristic:
//   extractClaims({ motion, speakers, chunkText, priorClaims }) ->
//     { claims: [{ text, speaker, type, checkable, links }], fallacies: [{ speaker, label, detail, confidence }] }
//   judgeClaim({ claim, results, motion }) ->
//     { verdict, confidence, evidence_summary, sources: [{name,url}] }
//   generateReceipts({ motion, stats }) -> { winner?, most_accurate?, ...narrative fields }
//
// Every real backend is built from one code path (ADR-0007): the vendor is a
// registry entry plus one of three request dialects, selected by LLM_PROVIDER.
//
// Tasks may be routed to DIFFERENT backends, which is the point rather than a
// nicety. Measured on a local 7B: extraction is ~720 calls per debate and works
// fine, but judging is where a small model stops being good enough — it will not
// commit to FALSE with cited sources, so the credibility gate downgrades a
// correct FALSE to UNVERIFIED. Judging is only ~40 calls, so pointing that one
// task at a stronger model costs little and is the difference between a working
// fact-checker and one that never contradicts anybody.
//
//   EXTRACTOR_PROVIDER=ollama  LLM_MODEL=qwen2.5:7b-instruct
//   JUDGE_PROVIDER=anthropic   JUDGE_MODEL=claude-haiku-4-5
import { logger } from '../../logger.js';
import { createUniversalLlm } from './universal.js';
import { createMockLlm } from './mock.js';
import { resolveProviderId, resolveTaskBaseUrl, TASKS } from './registry.js';

const TASK_METHOD = {
  extractor: 'extractClaims',
  judge: 'judgeClaim',
  receipts: 'generateReceipts',
};

export function getLlmProvider({ env = process.env } = {}) {
  const globalProviderId = resolveProviderId(env);
  const byTask = Object.fromEntries(
    TASKS.map((task) => [task, { id: resolveProviderId(env, task), baseUrl: resolveTaskBaseUrl(task, env) }]),
  );
  // Keyed by endpoint as well as vendor, so two local servers on different
  // ports are two instances rather than one shared by accident.
  const keyOf = (t) => `${t.id}|${t.baseUrl}`;
  const unique = [...new Set(Object.values(byTask).map((t) => t.id))];

  // Everything on the mock: hand back the mock itself, which is heuristic
  // rather than a transport and has no registry entry to build from.
  if (unique.length === 1 && unique[0] === 'mock') return createMockLlm();

  const instances = new Map();
  const instanceFor = (target) => {
    const key = keyOf(target);
    if (!instances.has(key)) {
      instances.set(
        key,
        target.id === 'mock'
          ? createMockLlm()
          : createUniversalLlm({
              providerId: target.id,
              env,
              globalProviderId,
              baseUrl: target.baseUrl || undefined,
            }),
      );
    }
    return instances.get(key);
  };
  // Build eagerly so a misconfigured backend fails at startup with an
  // actionable message rather than mid-debate on first use.
  for (const target of Object.values(byTask)) instanceFor(target);

  const routed = new Set(Object.values(byTask).map(keyOf)).size > 1;
  if (routed) {
    logger.info('llm tasks routed separately', Object.fromEntries(Object.entries(byTask).map(([k, v]) => [k, keyOf(v)])));
  }

  const provider = {
    kind: unique.length === 1 ? unique[0] : unique.join('+'),

    async warmup() {
      const targets = [...new Map(Object.values(byTask).map((t) => [keyOf(t), t])).values()];
      await Promise.all(targets.map((t) => instanceFor(t).warmup?.().catch(() => {})));
    },

    // Reports the backend for the task most likely to be asked about.
    listModels: (opts) => instanceFor(byTask.judge).listModels?.(opts) ?? Promise.resolve(null),

    describe: () => {
      const per = Object.fromEntries(
        Object.entries(byTask).map(([task, target]) => {
          const info = instanceFor(target).describe?.();
          return [task, info ? `${info.provider}:${info.models[task]}` : target.id];
        }),
      );
      const primary = instanceFor(byTask.judge).describe?.() || { provider: byTask.judge.id };
      return { ...primary, routed, tasks: per };
    },
  };

  for (const [task, method] of Object.entries(TASK_METHOD)) {
    provider[method] = (args) => instanceFor(byTask[task])[method](args);
  }
  return provider;
}
