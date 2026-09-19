---
description: Routes Pi Voice changes to the accepted decisions behind its model separation and terminal audio boundary.
---

# Architectural decision records

Read this index after the [knowledge-base overview](../../_index.md) identifies a decision-shaped question. The [runtime architecture](../../architecture.md) shows where these decisions take effect, and the [execution and type flow](../../type-breakdown.md) shows the concrete modules that enforce them. Open an ADR when its decision or impact matches the work at hand.

## Active decisions

| ADR | Decision | Impact | Date |
| --- | --- | --- | --- |
| [0001](./ADR-0001-separate-conversation-from-coding.md) | Use a live model for conversation and Pi for tool-based work | Session orchestration, delegation, result filtering, billing | 2026-09-19 |
| [0002](./ADR-0002-use-sox-for-terminal-audio.md) | Use SoX behind the `Media` interface | Installation, media lifecycle, latency, echo behavior, tests | 2026-09-19 |

## Superseded decisions

None.

## By category

### Architecture

- [ADR-0001](./ADR-0001-separate-conversation-from-coding.md): Separate conversation from coding work.

### Media

- [ADR-0002](./ADR-0002-use-sox-for-terminal-audio.md): Use SoX for terminal audio.
