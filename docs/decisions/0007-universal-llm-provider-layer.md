# One LLM layer for every backend, hosted or self-hosted

## Status
Accepted (extends ADR-0005's provider/mock pattern to the LLM tier)

## Context and Problem Statement
The pipeline was wired to Anthropic specifically. The owner asked for the
opposite: any provider, any key type, including models he runs himself — on a
laptop or on the same cloud the app is deployed to — switchable from a single
global.

Three forces make this cheap to do well:
- The three LLM tasks (extract, judge, receipts) all funnel through one
  `structured(system, prompt, schema)` call. The vendor only affects transport.
- Nearly every vendor speaks the OpenAI chat-completions dialect. Counting
  distinct request shapes, not brands, there are **three**.
- Self-hosting is the strongest form of "any provider": it removes per-token
  cost and keeps debate transcripts on infrastructure we control.

### Subscriptions are not an option, and pretending otherwise would be a bug
The request included consumer subscriptions (ChatGPT Plus, Claude Pro/Max).
Those are separate products from the APIs and expose no endpoint an application
may call; there is no supported credential that turns one into API access.
Building a "subscription mode" would mean shipping something that cannot work.
The honest substitutes are recorded instead: pay-as-you-go API billing and
self-hosting, which has no per-token cost at all. Note that "use a free tier"
is mostly not a substitute either — extraction sustains ~12 requests/minute,
which is above Cerebras (5 RPM) and Fireworks (10 RPM), while Groq's 1,000/day
and OpenRouter's 50/day are spent by a single debate. See docs/VENDOR-TIERS.md.

## Decision Drivers
- One switch, not a code change, to move between backends
- Must run entirely on infrastructure the owner controls, if he wants that
- Structured output must survive servers that implement it partially or not at
  all — precisely the situation when self-hosting
- A misconfiguration must be obvious at startup, not at 3am mid-debate
- Adding a vendor should be a table entry, not a new code path

## Considered Options
1. Keep Anthropic; add providers case by case as needed
2. Adopt a framework (LangChain, LiteLLM, Vercel AI SDK)
3. A registry plus three dialect adapters, written here

## Decision Outcome
Chosen: **option 3**.

Option 2 was rejected because the abstraction we need is roughly 300 lines, and
these frameworks bring a large dependency surface, their own release cadence and
their own opinions about prompts and retries — for a layer whose entire job is
one JSON call. Option 1 was rejected as the status quo that prompted the ask.

```
LLM_PROVIDER ──► registry.js (endpoint, auth style, default models)
                      │
                      ▼
              dialects/{openai,anthropic,gemini}.js   ← transport only
                      │
                      ▼
                  tasks.js  ← prompts + schemas, written once
```

- **`registry.js`** — every backend as data: endpoint, auth style, default
  models, docs link. Adding a vendor is a table entry. Model ids drift, so
  defaults are explicitly a starting point and `preflight` prints what it
  resolved.
- **`dialects/`** — three request shapes cover everything: `openai`
  (OpenAI, Azure, Groq, Together, Fireworks, DeepSeek, Mistral, xAI,
  OpenRouter, Ollama, vLLM, LM Studio, llama.cpp, LocalAI), `anthropic`,
  `gemini`.
- **`tasks.js`** — prompts and schemas live once, so a prompt change (like the
  judge's SCOPE rule) applies to every backend at once.
- **Model selection** — `LLM_MODEL` sets one model for everything, which is the
  normal case when self-hosting; per-task variables override it. Extraction is
  the cheap high-frequency loop, the rest decide what reaches the screen.

### Structured output is negotiated, not assumed
Schema support is uneven and weakest exactly where we most need tolerance: a
self-hosted server. The OpenAI dialect steps down rather than failing —
`json_schema` (real enforcement) → `json_object` (valid JSON, shape requested in
the prompt) → plain completion with JSON recovered from the text, fences and
preamble included. The working mode is cached per endpoint+model, so
negotiation costs one failed request per process rather than one per call.

Auth (401/403) and rate-limit (429) failures are deliberately excluded from that
downgrade path. Retrying a bad key with a weaker request shape would waste three
requests and then report the wrong problem.

### Consequences
- Good: any backend via one env var; self-hosting is first class, so a debate
  can run with zero per-token cost and no transcript leaving our infrastructure;
  prompts are shared, so quality changes are not per-vendor work.
- Good: misconfiguration throws at construction naming the exact variable to
  set, and `/healthz` reports the live provider, dialect, endpoint and models.
- Bad: we own three transports as vendors evolve their APIs. Contained by the
  fake-vendor server in `test/llm.test.js`, which exercises all three dialects
  and the whole negotiation ladder offline.
- Bad: default model ids will go stale. Mitigated by making them overridable and
  by preflight reporting the resolved id, but they will need occasional edits.
- The cost meter prices per model id; unknown ids simply do not get priced, so
  `COST_*` rates need extending when switching vendor if the estimate matters.

### Verified
16 tests against a local server impersonating each vendor: real requests,
headers and bodies; the full downgrade ladder including a model that wraps its
answer in a markdown fence; refusals and unparseable output degrading to the
documented safe result; and 401 propagating without downgrade attempts.

## Amendment (2026-08-17): tasks route to different backends

Running a full debate on a self-hosted `qwen2.5:7b` produced a precise failure.
Extraction was fine — 18 claims from 16 utterances. Search was fine — the
deliberately false claim about EV lifetime emissions retrieved a Nature life
cycle study and matching Wikipedia passages. **Judging was not.** The model
would not commit to FALSE with cited sources, so `gateVerdict` correctly
downgraded it to `UNVERIFIED — "Insufficient sourced evidence"`. The gate did
its job; the model could not clear the bar it sets, and a fact-checker that
never says FALSE is not a fact-checker.

The economics make the fix obvious once the numbers are written down:

| Task | Calls per debate | Needs |
|---|---|---|
| Extraction | ~720 | cheap and fast; a small local model is fine |
| Judging | ~40 | the strongest model available — it decides what appears on screen |
| Receipts | 1 | quality, but once |

Chosen: **each task resolves its own provider, model and endpoint**, defaulting
to the global one. `JUDGE_PROVIDER` / `JUDGE_MODEL` / `JUDGE_BASE_URL` (and the
equivalents for extractor and receipts) route one task without disturbing the
rest. Two shapes are now practical that were not before: local extraction with
hosted judging for a few cents a debate, and two local servers on different
ports — which matters because one server serialises every request behind one
loaded model, so `verifyConcurrency` buys nothing against a single instance.

Three rules keep the routing from surprising anyone:
1. `LLM_MODEL`, `LLM_BASE_URL` and `LLM_API_KEY` describe the **default**
   provider only. A routed task falls back to its own vendor's defaults instead
   of inheriting them — otherwise a local model id gets sent to a hosted vendor,
   which fails as a confusing 404 at the worst possible moment.
2. Instances are keyed by **endpoint as well as vendor**, so two local servers
   are two instances rather than one shared by accident.
3. Every backend is built eagerly at startup, so a misconfigured route fails
   with an actionable message rather than mid-debate on first use.

`/healthz` reports the per-task routing, because "which model judged this claim"
is the first question worth asking when a verdict looks wrong.

### Measured: why routing is necessary, not merely convenient

Benchmarked on the development machine (GTX 1080 Ti, ~11 GB VRAM, 31 GB RAM),
warm timings unless noted:

| Model | Extraction | Judging | Verdict quality |
|---|---|---|---|
| `qwen2.5:7b-instruct` (4.7 GB) | 1.7 s | 4 s | **Never returns FALSE** with cited sources; the gate downgrades to UNVERIFIED |
| `qwen2.5-coder:14b` (9 GB) | 12 s | 7–15 s | **Correct FALSE**, confidence 1.0, sources cited |
| `qwen2.5-coder:32b` (19 GB) | — | — | Never loaded; exceeds VRAM and stalls on CPU |
| 7B + 14B together | **294 s per swap** | — | Unworkable: one is evicted to load the other |

Two conclusions follow, and neither is about software quality:

1. **Two local models on one GPU is not a configuration.** Every alternation
   pays a full model load. Where VRAM cannot hold both, routing must send one
   task off-box rather than to a second local model.
2. **A model big enough to judge is too slow to extract.** Extraction ticks
   every 5 s; at 12 s per call the 14B runs back-to-back and saturates the GPU,
   leaving judging to queue behind it and blow the 8–20 s verdict budget. The 7B
   extracts in 1.7 s — roughly a third duty cycle, with headroom to spare — but
   cannot clear the FALSE bar.

So on constrained hardware the working configuration is **local extraction plus
hosted judging**: the 720 cheap calls stay free and local, the 40 expensive ones
go where the quality is, and the two never contend for the same GPU. That is
precisely what per-task routing buys, and it is the reason it exists.

On a machine with enough VRAM for a strong model, `LLM_MODEL` alone is still the
simplest correct answer.
