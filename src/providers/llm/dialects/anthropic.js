// Anthropic Messages API.
//
// Raw fetch rather than the SDK so that every dialect is uniform and testable
// against a local fake server, and so LLM_BASE_URL can point at a gateway or
// proxy without special-casing.
import { extractJson, schemaInstruction } from './json.js';
import { logger } from '../../../logger.js';

const API_VERSION = '2023-06-01';

export function createAnthropicDialect({ apiKey, baseUrl, fetchImpl = fetch }) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  let supportsJsonSchema = true;

  async function attempt({ model, system, prompt, schema, maxTokens, effort, useSchema, signal }) {
    const body = {
      model,
      max_tokens: maxTokens,
      system: system + (useSchema ? '' : schemaInstruction(schema)),
      messages: [{ role: 'user', content: prompt }],
    };
    if (useSchema) {
      body.output_config = {
        format: { type: 'json_schema', schema },
        ...(effort ? { effort } : {}),
      };
    }

    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const usage = { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 };

    if (data.stop_reason === 'refusal') {
      logger.warn('llm refusal', { model, category: data.stop_details?.category });
      return { data: null, refused: true, usage };
    }
    const text = (data.content || []).find((b) => b.type === 'text')?.text;
    return { data: extractJson(text ?? ''), usage };
  }

  return {
    name: 'anthropic',

    async listModels({ signal } = {}) {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.data || []).map((m) => m.id).filter(Boolean);
    },

    async structured({ model, system, prompt, schema, maxTokens = 2000, effort, signal }) {
      try {
        return await attempt({ model, system, prompt, schema, maxTokens, effort, useSchema: supportsJsonSchema, signal });
      } catch (err) {
        // A gateway or older-compatible endpoint may not know output_config.
        // Drop to schema-in-prompt once, then remember.
        const negotiable = supportsJsonSchema && err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status);
        if (!negotiable) throw err;
        logger.debug('anthropic json_schema unsupported, using prompt schema', { model, status: err.status });
        supportsJsonSchema = false;
        return attempt({ model, system, prompt, schema, maxTokens, effort, useSchema: false, signal });
      }
    },
  };
}
