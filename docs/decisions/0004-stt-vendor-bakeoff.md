# Streaming STT vendor selection

## Status
Accepted — **AssemblyAI** (decided by the owner; was "Proposed / bake-off pending")

## Context and Problem Statement
The pipeline needs streaming transcription at ~300ms latency with reliable speaker attribution. Platform identity from Recall.ai covers speaker labels in most cases; diarization is the fallback.

## Decision Drivers
- Streaming latency
- Accuracy on crosstalk/interruptions (debates!)
- Cost per audio-hour across up to 6 speakers

## Considered Options
- Deepgram (streaming)
- AssemblyAI (streaming)

## Decision Outcome
Chosen option: **AssemblyAI**, selected by the owner for the V1 build.

Both clients are implemented behind the `SttProvider` interface
(`src/providers/stt/`), so this is a one-env-var decision (`STT_PROVIDER`) and
Deepgram remains available without code changes. The originally planned Phase 1
bake-off on real debate audio can still be run later to confirm or reverse the
choice — the losing vendor stays swappable by design.

### Consequences
- Good: decision unblocked; `ASSEMBLYAI_API_KEY` is the only STT key needed
- Bad: latency and crosstalk accuracy on real debate audio remain unmeasured
  until the first live call; if AssemblyAI underperforms, switching to Deepgram
  is a config change, not a rewrite
