// Universal LLM layer (ADR-0007).
//
// A local HTTP server impersonates each vendor, so every dialect, the
// structured-output negotiation and the error paths are exercised for real —
// actual requests, headers and bodies — without a single API key.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveProviderId, resolveModel, getProviderSpec, PROVIDERS } from '../src/providers/llm/registry.js';
import { createUniversalLlm } from '../src/providers/llm/universal.js';
import { getLlmProvider } from '../src/providers/llm/index.js';
import { config } from '../src/config.js';
import { extractJson } from '../src/providers/llm/dialects/json.js';
import { toGeminiSchema } from '../src/providers/llm/dialects/gemini.js';

const VERDICT = { verdict: 'TRUE', confidence: 0.9, evidence_summary: 'Supported.', sources: [] };

// A stand-in for every vendor at once, routed by path.
//   opts.reject: Set of response_format types this server refuses (400)
async function startFakeLlm(opts = {}) {
  const reject = opts.reject || new Set();
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, headers: req.headers, body: parsed });

      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url.includes('/models') && req.method === 'GET') {
        if (opts.status) return send(opts.status, { error: { message: 'not implemented' } });
        return send(200, { data: (opts.served || ['gpt-5.6-terra', 'gpt-5.6-luna']).map((id) => ({ id })) });
      }

      if (req.url.includes('/chat/completions')) {
        const kind = parsed.response_format?.type || 'none';
        if (reject.has(kind)) return send(400, { error: { message: `${kind} not supported` } });
        if (opts.status) return send(opts.status, { error: { message: 'nope' } });
        return send(200, {
          choices: [{ message: { content: opts.content ?? JSON.stringify(VERDICT) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        });
      }

      if (req.url.includes('/v1/messages')) {
        if (opts.status) return send(opts.status, { error: { message: 'nope' } });
        if (opts.refuse) return send(200, { stop_reason: 'refusal', content: [], usage: { input_tokens: 3, output_tokens: 0 } });
        return send(200, {
          content: [{ type: 'text', text: opts.content ?? JSON.stringify(VERDICT) }],
          usage: { input_tokens: 12, output_tokens: 5 },
        });
      }

      if (req.url.includes('/interactions')) {
        if (opts.noInteractions) return send(404, { error: { message: 'not found' } });
        return send(200, {
          id: 'int_1', status: 'completed', model: 'gemini-2.5-pro',
          steps: [{ content: { parts: [{ text: opts.content ?? JSON.stringify(VERDICT) }] } }],
          usage: { total_input_tokens: 9, total_output_tokens: 4 },
        });
      }

      if (req.url.includes(':generateContent')) {
        return send(200, {
          candidates: [{ content: { parts: [{ text: opts.content ?? JSON.stringify(VERDICT) }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
        });
      }
      send(404, { error: 'unknown path' });
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    requests,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const CLAIM = { speaker: 'Alex', text: 'EV sales tripled between 2020 and 2023.' };

// --------------------------------------------------------------- registry

test('provider selection: explicit wins, otherwise the key present decides', () => {
  assert.equal(resolveProviderId({ LLM_PROVIDER: 'ollama' }), 'ollama');
  assert.equal(resolveProviderId({ LLM_PROVIDER: 'OpenAI' }), 'openai', 'case and spacing tolerated');
  assert.equal(resolveProviderId({ OPENAI_API_KEY: 'sk-x' }), 'openai');
  assert.equal(resolveProviderId({ GROQ_API_KEY: 'gsk' }), 'groq');
  // Anthropic outranks the rest when several keys are present.
  assert.equal(resolveProviderId({ OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-a' }), 'anthropic');
  // A local server is never auto-selected: we cannot tell if one is running,
  // and silently failing to reach localhost is worse than an honest mock.
  assert.equal(resolveProviderId({}), 'mock');
});

test('model resolution: per-task env beats the provider default', () => {
  const openai = getProviderSpec('openai');
  assert.equal(resolveModel(openai, 'extractor', {}), 'gpt-5.6-luna', 'fast model for the extraction loop');
  assert.equal(resolveModel(openai, 'judge', {}), 'gpt-5.6-terra', 'strong model for what reaches the screen');
  assert.equal(resolveModel(openai, 'judge', { JUDGE_MODEL: 'o3' }), 'o3');
  // Self-hosted providers have no defaults — we cannot know what is loaded.
  assert.equal(resolveModel(getProviderSpec('ollama'), 'judge', {}), '');
  assert.equal(resolveModel(getProviderSpec('ollama'), 'judge', { JUDGE_MODEL: 'qwen2.5' }), 'qwen2.5');
});

test('every registry entry can actually be built', () => {
  for (const [id, spec] of Object.entries(PROVIDERS)) {
    if (id === 'mock') continue;
    assert.ok(spec.label, `${id} has a label`);
    assert.ok(['openai', 'anthropic', 'gemini'].includes(spec.dialect), `${id} uses a known dialect`);
    assert.ok(spec.baseUrl || spec.requiresBaseUrl, `${id} has an endpoint or demands one`);
  }
});

// ------------------------------------------------------- misconfiguration

test('misconfiguration fails at startup with an actionable message', () => {
  assert.throws(
    () => createUniversalLlm({ providerId: 'openai', env: {} }),
    /OPENAI_API_KEY/,
    'names the variable to set',
  );
  assert.throws(
    () => createUniversalLlm({ providerId: 'custom', env: {} }),
    /LLM_BASE_URL/,
    'an endpoint-less provider says so',
  );
  assert.throws(
    () => createUniversalLlm({ providerId: 'ollama', env: {}, baseUrl: 'http://localhost:11434/v1' }),
    /LLM_MODEL/,
    'a local server needs to be told which model it is serving',
  );
  assert.throws(() => createUniversalLlm({ providerId: 'nope', env: {} }), /unknown LLM_PROVIDER/);
});

// -------------------------------------------------------------- dialects

test('openai dialect: real request shape, parsed result, usage counted', async (t) => {
  const fake = await startFakeLlm();
  t.after(() => fake.close());

  const llm = createUniversalLlm({
    providerId: 'openai',
    env: { OPENAI_API_KEY: 'sk-test' },
    baseUrl: `${fake.base}/v1`,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [], motion: 'Motion' });
  assert.deepEqual(verdict, VERDICT);

  const req = fake.requests.at(-1);
  assert.equal(req.headers.authorization, 'Bearer sk-test');
  assert.equal(req.body.model, 'gpt-5.6-terra', 'judging uses the strong model');
  assert.equal(req.body.response_format.type, 'json_schema', 'schema enforcement preferred');
  assert.match(req.body.messages[1].content, /EV sales tripled/);
  assert.match(req.body.messages[1].content, /Motion/, 'the motion reaches the judge here too');
});

test('azure authenticates with its own header', async (t) => {
  const fake = await startFakeLlm();
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'azure',
    env: { AZURE_OPENAI_API_KEY: 'az-key', LLM_MODEL: 'my-deployment' },
    baseUrl: `${fake.base}/openai/deployments/my-deployment`,
  });
  await llm.judgeClaim({ claim: CLAIM, results: [] });
  const req = fake.requests.at(-1);
  assert.equal(req.headers['api-key'], 'az-key');
  assert.equal(req.headers.authorization, undefined, 'no bearer token for Azure');
});

test('anthropic dialect speaks the messages API', async (t) => {
  const fake = await startFakeLlm();
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'anthropic',
    env: { ANTHROPIC_API_KEY: 'sk-ant' },
    baseUrl: fake.base,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [] });
  assert.deepEqual(verdict, VERDICT);
  const req = fake.requests.at(-1);
  assert.equal(req.headers['x-api-key'], 'sk-ant');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.output_config.format.type, 'json_schema');
});

test('anthropic refusal degrades to the safe verdict, never a guess', async (t) => {
  const fake = await startFakeLlm({ refuse: true });
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'anthropic',
    env: { ANTHROPIC_API_KEY: 'sk-ant' },
    baseUrl: fake.base,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [] });
  assert.equal(verdict.verdict, 'UNVERIFIABLE');
  assert.equal(verdict.confidence, 0);
});

test('gemini dialect posts generateContent with a schema it accepts', async (t) => {
  const fake = await startFakeLlm();
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'google',
    env: { GEMINI_API_KEY: 'g-key' },
    baseUrl: fake.base,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [] });
  assert.deepEqual(verdict, VERDICT);
  const req = fake.requests.at(-1);
  assert.match(req.url, /\/interactions$/, 'uses the current Interactions API');
  assert.equal(req.headers['x-goog-api-key'], 'g-key', 'key travels in a header, not the URL');
  assert.equal(req.body.model, 'gemini-2.5-pro');
  assert.equal(req.body.response_format.mime_type, 'application/json');
});

test('gemini falls back to generateContent when Interactions is unavailable', async (t) => {
  // Google runs two API generations at once; an account or endpoint that only
  // knows the older one must still work rather than silently yielding nothing.
  const fake = await startFakeLlm({ noInteractions: true });
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'google',
    env: { GEMINI_API_KEY: 'g-key' },
    baseUrl: fake.base,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [] });
  assert.deepEqual(verdict, VERDICT, 'still produced a verdict via the older endpoint');

  const urls = fake.requests.map((r) => r.url);
  assert.match(urls[0], /\/interactions$/, 'tried the current API first');
  assert.match(urls[1], /:generateContent$/, 'then fell back');
  const body = fake.requests.at(-1).body;
  assert.equal(
    JSON.stringify(body.generationConfig.responseSchema).includes('additionalProperties'),
    false,
    'the older endpoint rejects additionalProperties, so it is stripped',
  );
});

test('gemini schema translation keeps meaning, drops what it cannot parse', () => {
  const out = toGeminiSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } } },
      verdict: { type: 'string', enum: ['TRUE', 'FALSE'] },
    },
    required: ['verdict'],
  });
  assert.equal(out.additionalProperties, undefined);
  assert.equal(out.properties.items.items.additionalProperties, undefined, 'stripped at every depth');
  assert.deepEqual(out.properties.verdict.enum, ['TRUE', 'FALSE'], 'constraints that survive are kept');
  assert.deepEqual(out.required, ['verdict']);
});

// -------------------------------------------- structured output negotiation

test('a server without schema support is negotiated down, not abandoned', async (t) => {
  // Typical of a local llama.cpp or older Ollama build: it knows json_object
  // but not json_schema.
  const fake = await startFakeLlm({ reject: new Set(['json_schema']) });
  t.after(() => fake.close());

  const llm = createUniversalLlm({
    providerId: 'llamacpp',
    env: { LLM_MODEL: 'local-model' },
    baseUrl: `${fake.base}/v1`,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [] });
  assert.deepEqual(verdict, VERDICT, 'still produced a usable verdict');

  const kinds = fake.requests.map((r) => r.body.response_format?.type);
  assert.deepEqual(kinds, ['json_schema', 'json_object'], 'tried the best mode first, then stepped down');
  // The shape has to be stated in the prompt once the schema is not enforced.
  assert.match(fake.requests.at(-1).body.messages[0].content, /JSON Schema/);

  // The working mode is remembered: a second call must not re-pay the failure.
  const before = fake.requests.length;
  await llm.judgeClaim({ claim: CLAIM, results: [] });
  assert.equal(fake.requests.length - before, 1, 'one request, no repeated negotiation');
});

test('a server supporting neither still works, via plain prompting', async (t) => {
  const fake = await startFakeLlm({
    reject: new Set(['json_schema', 'json_object']),
    // ...and it wraps the answer in a markdown fence, as small models do.
    content: 'Sure! Here is the JSON:\n```json\n' + JSON.stringify(VERDICT) + '\n```',
  });
  t.after(() => fake.close());

  const llm = createUniversalLlm({
    providerId: 'custom',
    env: { LLM_API_KEY: '', LLM_MODEL: 'm' },
    baseUrl: `${fake.base}/v1`,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [] });
  assert.deepEqual(verdict, VERDICT, 'recovered from a fenced, prose-prefixed reply');
  assert.equal(fake.requests.length, 3, 'json_schema -> json_object -> plain');
});

test('auth and rate-limit failures are never mistaken for missing features', async (t) => {
  const fake = await startFakeLlm({ status: 401 });
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'openai',
    env: { OPENAI_API_KEY: 'sk-bad' },
    baseUrl: `${fake.base}/v1`,
  });
  // A bad key must surface as a bad key. Degrading the request shape would
  // retry three times and then report the wrong problem.
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [] }).catch((err) => err);
  assert.ok(verdict instanceof Error, 'the failure propagates for the caller to handle');
  assert.match(verdict.message, /401/);
  assert.equal(fake.requests.length, 1, 'no pointless downgrade attempts');
});

test('unusable output degrades to the safe result rather than crashing', async (t) => {
  const fake = await startFakeLlm({ content: 'I would rather write a poem about electric cars.' });
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'openai',
    env: { OPENAI_API_KEY: 'sk-test' },
    baseUrl: `${fake.base}/v1`,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [] });
  assert.equal(verdict.verdict, 'UNVERIFIABLE');
  const extracted = await llm.extractClaims({ speakers: ['A'], chunkText: 'hello' });
  assert.deepEqual(extracted, { claims: [], fallacies: [] }, 'extraction falls back to empty, not undefined');
});

test('describe() reports exactly what is running', async (t) => {
  const fake = await startFakeLlm();
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'groq',
    env: { GROQ_API_KEY: 'gsk', JUDGE_MODEL: 'llama-3.3-70b-versatile' },
    baseUrl: `${fake.base}/v1`,
  });
  const info = llm.describe();
  assert.equal(info.provider, 'groq');
  assert.equal(info.dialect, 'openai');
  assert.equal(info.keyed, true);
  assert.equal(info.models.judge, 'llama-3.3-70b-versatile');
});

// ------------------------------------------------------------ json recovery

test('JSON is recovered from whatever a small model wraps it in', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps!'), { a: 1 });
  // Braces inside strings must not end the object early.
  assert.deepEqual(extractJson('prose {"a":"}{","b":2} trailing'), { a: '}{', b: 2 });
  assert.deepEqual(extractJson('escaped {"a":"say \\"hi\\" }","b":3}'), { a: 'say "hi" }', b: 3 });
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('the endpoint is asked which models it serves, so a stale default is caught', async (t) => {
  const fake = await startFakeLlm({ served: ['llama3.3:70b', 'qwen2.5'] });
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'ollama',
    env: { LLM_MODEL: 'llama3.3:70b' },
    baseUrl: `${fake.base}/v1`,
  });
  const served = await llm.listModels();
  assert.deepEqual(served, ['llama3.3:70b', 'qwen2.5']);
  // This is what preflight compares against: a model id nobody serves is a
  // broken config, and the wrong time to discover it is mid-debate.
  assert.equal(served.includes('llama3.3:70b'), true);
  assert.equal(served.includes('claude-opus-5'), false);
});

test('a provider that cannot list models says so rather than failing', async (t) => {
  const fake = await startFakeLlm({ status: 404 });
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'custom',
    env: { LLM_MODEL: 'whatever' },
    baseUrl: `${fake.base}/v1`,
  });
  assert.equal(await llm.listModels(), null, 'null means unknown, not broken');
});

// ------------------------------------------------------ per-task routing
//
// Extraction is ~720 calls per debate and a local 7B handles it; judging is ~40
// calls where that same model will not commit to FALSE with cited sources, so
// the credibility gate downgrades a correct FALSE to UNVERIFIED. Routing the
// judge alone to a stronger backend is the cheap fix, so it has to work.

test('tasks can be routed to different backends', async (t) => {
  const local = await startFakeLlm();
  const hosted = await startFakeLlm();
  t.after(async () => {
    await local.close();
    await hosted.close();
  });

  const llm = getLlmProvider({
    env: {
      LLM_PROVIDER: 'custom',
      LLM_MODEL: 'local-7b',
      LLM_BASE_URL: `${local.base}/v1`,
      JUDGE_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant',
      JUDGE_MODEL: 'claude-haiku-4-5',
      JUDGE_BASE_URL: hosted.base,
    },
  });

  await llm.extractClaims({ speakers: ['A'], chunkText: 'A: something factual.' });
  await llm.judgeClaim({ claim: CLAIM, results: [] });

  assert.equal(local.requests.length, 1, 'extraction stayed local');
  assert.equal(local.requests[0].body.model, 'local-7b');
  assert.equal(hosted.requests.length, 1, 'judging went to the other backend');
  assert.equal(hosted.requests[0].body.model, 'claude-haiku-4-5');
  assert.equal(hosted.requests[0].headers['x-api-key'], 'sk-ant', 'and used that backend own auth');

  const info = llm.describe();
  assert.equal(info.routed, true, 'health reports that routing is active');
  assert.equal(info.tasks.extractor, 'custom:local-7b');
  assert.equal(info.tasks.judge, 'anthropic:claude-haiku-4-5');
});

test('a local model id never leaks to a hosted backend', async (t) => {
  // LLM_MODEL names a model on the DEFAULT provider. Sending "qwen2.5:7b" to
  // Anthropic because it happened to be the global default would be a confusing
  // 404 at the worst moment.
  const local = await startFakeLlm();
  t.after(() => local.close());

  const llm = getLlmProvider({
    env: {
      LLM_PROVIDER: 'custom',
      LLM_MODEL: 'qwen2.5:7b-instruct',
      LLM_BASE_URL: `${local.base}/v1`,
      JUDGE_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant',
    },
  });
  const info = llm.describe();
  assert.equal(info.tasks.extractor, 'custom:qwen2.5:7b-instruct', 'the global model applies to its own provider');
  assert.equal(
    info.tasks.judge,
    'anthropic:claude-opus-5',
    "the routed task falls back to its own provider's default rather than inheriting a foreign model id",
  );
});

test('routing is opt-in: one provider stays one provider', async (t) => {
  const fake = await startFakeLlm();
  t.after(() => fake.close());
  const llm = getLlmProvider({
    env: { LLM_PROVIDER: 'custom', LLM_MODEL: 'm', LLM_BASE_URL: `${fake.base}/v1` },
  });
  assert.equal(llm.describe().routed, false);
  assert.equal(llm.kind, 'custom');
});

test('the judge cites result numbers, and we resolve them to real sources', async (t) => {
  // Small models reliably emit "[1, 3]" and unreliably reproduce a long URL.
  // Measured: qwen2.5:7b returned a correct FALSE at 0.95 confidence with an
  // empty sources array, which gateVerdict then downgraded to UNVERIFIED —
  // a right answer thrown away over formatting.
  const fake = await startFakeLlm({
    content: JSON.stringify({
      verdict: 'FALSE',
      confidence: 0.95,
      evidence_summary: 'The sources contradict the claim.',
      source_indices: [3, 1, 9, 3],
    }),
  });
  t.after(() => fake.close());

  const llm = createUniversalLlm({
    providerId: 'openai',
    env: { OPENAI_API_KEY: 'sk-test' },
    baseUrl: `${fake.base}/v1`,
  });
  const results = [
    { title: 'Wikipedia', url: 'https://en.wikipedia.org/a', snippet: 'x' },
    { title: 'Blog', url: 'https://blog.example/b', snippet: 'y' },
    { title: 'Nature', url: 'https://nature.com/c', snippet: 'z' },
  ];
  const verdict = await llm.judgeClaim({ claim: CLAIM, results, motion: 'M' });

  assert.equal(verdict.verdict, 'FALSE');
  assert.deepEqual(
    verdict.sources,
    [
      { name: 'Nature', url: 'https://nature.com/c' },
      { name: 'Wikipedia', url: 'https://en.wikipedia.org/a' },
    ],
    'cited in the order given, 1-based, with the out-of-range 9 dropped and the repeat ignored',
  );
  // The prompt must actually number the results, or the indices mean nothing.
  assert.match(fake.requests.at(-1).body.messages[1].content, /\[1\] Wikipedia/);
  assert.match(fake.requests.at(-1).body.messages[1].content, /\[3\] Nature/);
});

test('a verdict citing nothing resolvable carries no sources, and the gate can catch it', async (t) => {
  const fake = await startFakeLlm({
    content: JSON.stringify({ verdict: 'FALSE', confidence: 0.99, evidence_summary: 'Trust me.', source_indices: [7] }),
  });
  t.after(() => fake.close());
  const llm = createUniversalLlm({
    providerId: 'openai',
    env: { OPENAI_API_KEY: 'sk-test' },
    baseUrl: `${fake.base}/v1`,
  });
  const verdict = await llm.judgeClaim({ claim: CLAIM, results: [{ title: 'A', url: 'https://a.test/1', snippet: 's' }] });
  assert.deepEqual(verdict.sources, [], 'an unresolvable citation is dropped rather than guessed at');
});

test('a model you host yourself is not billed at a hosted vendor rate', async () => {
  const { estimateCost } = await import('../src/pipeline/costMeter.js');

  // What the local run actually produced.
  const local = {
    'llm_in:qwen2.5:7b-instruct': 8842,
    'llm_out:qwen2.5:7b-instruct': 1900,
    'llm_free:qwen2.5:7b-instruct': 1,
    search_calls: 7,
  };
  // Same tokens on an unknown HOSTED model, which has no free marker.
  const hosted = {
    'llm_in:some-new-model': 8842,
    'llm_out:some-new-model': 1900,
    search_calls: 7,
  };

  const searchOnly = 7 * config.costRates.searchCall;
  assert.equal(estimateCost(local), Math.round(searchOnly * 10000) / 10000, 'local tokens cost nothing');
  assert.ok(estimateCost(hosted) > estimateCost(local), 'an unpriced hosted model still estimates a cost');
});
