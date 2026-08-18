// Google Gemini generateContent.
//
// Gemini takes a response schema, but a stricter subset of JSON Schema than the
// other two: additionalProperties and $schema are rejected outright, so the
// shared task schemas are translated rather than passed through.
import { extractJson, schemaInstruction } from './json.js';

export function createGeminiDialect({ apiKey, baseUrl, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/$/, '');

  return {
    name: 'gemini',
    async structured({ model, system, prompt, schema, maxTokens = 2000, signal }) {
      const url = `${root}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(schema),
          },
        }),
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
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
    },
  };
}

// Gemini rejects the vocabulary the other dialects accept, so strip what it
// does not understand rather than letting the whole request fail.
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
