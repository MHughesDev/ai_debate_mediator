// Google Gemini.
//
// Google has two generations of API live at once, so this dialect tries the
// current one and falls back:
//
//   1. Interactions API (v1beta/interactions) — now GA and the documented path,
//      taking `response_format: {type:'text', mime_type, schema}`.
//   2. generateContent — the long-standing endpoint, taking
//      `generationConfig.responseSchema`.
//
// The fallback is not defensive padding: the Interactions response nests its
// output inside a `steps` array whose exact shape we have not been able to
// verify against a live key, so if parsing yields nothing usable we drop to the
// endpoint whose shape we do know rather than silently returning no evidence.
// The winning path is remembered per process.
import { extractJson, schemaInstruction } from './json.js';
import { logger } from '../../../logger.js';

export function createGeminiDialect({ apiKey, baseUrl, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/$/, '');
  let useInteractions = true;

  async function post(url, body, signal) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function viaInteractions({ model, system, prompt, schema, maxTokens, signal }) {
    const data = await post(
      `${root}/interactions`,
      {
        model,
        input: `${system}\n\n${prompt}`,
        max_output_tokens: maxTokens,
        response_format: { type: 'text', mime_type: 'application/json', schema },
      },
      signal,
    );
    return {
      data: extractJson(textFromInteraction(data)),
      usage: {
        input: data.usage?.total_input_tokens ?? data.usage?.input_tokens ?? 0,
        output: data.usage?.total_output_tokens ?? data.usage?.output_tokens ?? 0,
      },
    };
  }

  async function viaGenerateContent({ model, system, prompt, schema, maxTokens, signal }) {
    const data = await post(
      `${root}/models/${encodeURIComponent(model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(schema),
        },
      },
      signal,
    );
    const candidate = data.candidates?.[0];
    const usage = {
      input: data.usageMetadata?.promptTokenCount ?? 0,
      output: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
    if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
      return { data: null, refused: true, usage };
    }
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
    return { data: extractJson(text), usage };
  }

  return {
    name: 'gemini',

    async listModels({ signal } = {}) {
      const res = await fetchImpl(`${root}/models`, {
        headers: { 'x-goog-api-key': apiKey },
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      // Gemini returns "models/gemini-..."; callers configure the bare id.
      return (data.models || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
    },

    async structured({ model, system, prompt, schema, maxTokens = 2000, signal }) {
      if (useInteractions) {
        try {
          const result = await viaInteractions({ model, system, prompt, schema, maxTokens, signal });
          if (result.data !== null) return result;
          logger.debug('gemini interactions returned nothing usable, trying generateContent', { model });
        } catch (err) {
          if ([401, 403, 429].includes(err.status)) throw err; // a real failure, not a wrong endpoint
          logger.debug('gemini interactions unavailable, using generateContent', { model, status: err.status });
        }
        useInteractions = false;
      }
      return viaGenerateContent({ model, system, prompt, schema, maxTokens, signal });
    },
  };
}

// The Interactions response nests output in a `steps` array. Collect text from
// the shapes it is documented or likely to use rather than betting on one.
export function textFromInteraction(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node.text === 'string') out.push(node.text);
    if (node.content) visit(node.content);
    if (node.parts) visit(node.parts);
    if (node.output) visit(node.output);
  };
  visit(data.steps);
  return out.join('');
}

// The older generateContent schema vocabulary is stricter than JSON Schema:
// additionalProperties and $schema are rejected, so strip them rather than
// letting the whole request fail. (The Interactions API accepts them, and is
// passed the schema untouched.)
export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema') continue;
    if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]),
      );
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export { schemaInstruction };
