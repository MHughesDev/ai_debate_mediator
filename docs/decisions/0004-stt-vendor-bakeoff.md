# Streaming STT vendor selection

## Status
Proposed

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
Deferred to a Phase 1 bake-off on real debate audio. Both integrate behind an `SttProvider` interface so the loser is swappable.
