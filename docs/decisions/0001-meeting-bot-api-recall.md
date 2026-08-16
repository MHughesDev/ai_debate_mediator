# Use Recall.ai as the meeting bot provider

## Status
Accepted

## Context and Problem Statement
V1 must work on Zoom, Meet, and Teams with zero participant installs, capture per-speaker audio, and display live visuals inside the call.

## Decision Drivers
- One integration for all three platforms
- Per-participant audio + platform speaker identity (avoids diarization errors)
- In-call visual output without building native overlays

## Considered Options
- Recall.ai
- Meeting BaaS
- Native Zoom/Meet/Teams SDKs (one integration each)

## Decision Outcome
Chosen option: **Recall.ai**, because its Output Media API renders any webpage as the bot's camera/screenshare with low latency — the display surface and audio capture live in one integration.

### Consequences
- Good: zero-install UX; bot tile is the product surface; fastest path to demo
- Bad: vendor dependency and per-bot-hour cost

Mitigation: isolate behind a `MeetingProvider` interface; Meeting BaaS as fallback.
