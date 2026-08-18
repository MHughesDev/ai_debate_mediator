// OpenAI-compatible chat completions — the dialect nearly everything speaks:
// OpenAI, Azure, Groq, Together, Fireworks, DeepSeek, Mistral, xAI, OpenRouter,
// and every serious local server (Ollama, vLLM, LM Studio, llama.cpp, LocalAI).
//
// The hard part is structured output, because support for it is uneven and a
// self-hosted server is exactly where it is most likely to be missing. So we
// negotiate downwards instead of failing:
//
//   1. response_format: json_schema  — real schema enforcement (OpenAI, vLLM,
//      recent Ollama). Best: the model cannot return the wrong shape.
//   2. response_format: json_object  — guaranteed valid JSON, shape merely
//      requested in the prompt.
//   3. no response_format at all     — plain completion, JSON recovered from
//      the text. Works against literally any endpoint.
//
// The outcome is remembered per endpoint+model, so the negotiation costs one
// failed request on startup rather than one on every call.
import { extractJson, schemaInstruction } from './json.js';
import { logger } from '../../../logger.js';

const MODES = ['json_schema', 'json_object', 'prompt'];
const modeCache = new Map(); // `${baseUrl}|${model}` -> mode

export function createOpenAiDialect({ spec, apiKey, baseUrl, fetchImpl = fetch }) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  function headers() {
    const h = { 'content-type': 'application/json' };
    if (!apiKey) return h;
    // Azure authenticates with its own header rather than a bearer token.
    if (spec.authStyle === 'api-key-header') h['api-key'] = apiKey;
    else h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  function buildBody({ model, system, prompt, schema, maxTokens, mode }) {
    const wantsPromptSchema = mode !== 'json_schema';
    const body = {
      model,
      max_tokens: maxTokens,
      // Some OpenAI-compatible servers only honour the newer field name; send
      // both, since unknown keys are ignored far more often than they error.
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system + (wantsPromptSchema ? schemaInstruction(schema) : '') },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
    };
    if (mode === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'result', schema, strict: true },
      };
    } else if (mode === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  async function attempt({ model, system, prompt, schema, maxTokens, mode, signal }) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(buildBody({ model, system, prompt, schema, maxTokens, mode })),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    // An explicit content filter is a refusal, not a parse problem.
    if (choice?.finish_reason === 'content_filter') {
      return { data: null, refused: true, usage: usageOf(data) };
    }
    return {
      data: extractJson(choice?.message?.content ?? ''),
      usage: usageOf(data),
    };
  }

  return {
    name: 'openai',
    async structured({ model, system, prompt, schema, maxTokens = 2000, signal }) {
      const cacheKey = `${baseUrl}|${model}`;
      const start = MODES.indexOf(modeCache.get(cacheKey) || MODES[0]);

      let lastErr = null;
      for (let i = Math.max(start, 0); i < MODES.length; i += 1) {
        const mode = MODES[i];
        try {
          const result = await attempt({ model, system, prompt, schema, maxTokens, mode, signal });
          modeCache.set(cacheKey, mode);
          return result;
        } catch (err) {
          lastErr = err;
          // 4xx here means "this server does not support that request shape",
          // which is precisely what the next mode down is for. Anything else
          // (auth, rate limit, network, 5xx) is a real failure — retrying with
          // a weaker request shape would just mislabel the problem.
          const negotiable = err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status);
          if (!negotiable || i === MODES.length - 1) throw err;
          logger.debug('llm structured mode unsupported, degrading', {
            model, from: mode, to: MODES[i + 1], status: err.status,
          });
        }
      }
      throw lastErr;
    },
  };
}

function usageOf(data) {
  return {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
  };
}
