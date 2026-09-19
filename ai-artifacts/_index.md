---
description: Start here to understand Pi Voice's language, architecture, type flow, and accepted decisions.
---

# Pi Voice knowledge base

Pi Voice adds spoken interaction to Pi without moving coding work out of the active Pi agent. Start with the [domain language](./CONTEXT.md) when a term such as *live model*, *delegation*, or *user-facing result* is unclear. Those definitions explain the actors used throughout the [runtime architecture](./architecture.md).

Use the [runtime architecture](./architecture.md) to understand where work belongs: the Pi extension hosts the command and UI, the session coordinator owns lifecycle policy, SoX implements local audio, and the Realtime transport carries validated events. When changing an implementation path, follow the [execution and type flow](./type-breakdown.md) to identify its input, output, effects, and trust boundary before editing code.

The [architectural decision records](./docs/adr/INDEX.md) explain why Pi Voice uses two model roles and SoX. Read the relevant decision before proposing a different delegation model, audio backend, or runtime boundary.

## Suggested routes

If you need to change a spoken request or returned answer, start with [delegation and user-facing-result language](./CONTEXT.md#language), then read the [delegation sequence](./architecture.md#delegating-a-coding-request) and the [delegation type flow](./type-breakdown.md#delegation).

If you need to change capture, playback, or latency handling, start with the [SoX decision](./docs/adr/ADR-0002-use-sox-for-terminal-audio.md), then use the [media boundary](./architecture.md#component-boundaries) and [microphone audio flow](./type-breakdown.md#microphone-audio) to find the owning port.

If you need to change session startup, retries, or shutdown, read the [session state model](./architecture.md#session-state) alongside the [startup execution tree](./type-breakdown.md#start-a-session).
