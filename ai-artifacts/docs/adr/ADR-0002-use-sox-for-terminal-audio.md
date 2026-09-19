# ADR-0002: Use SoX for terminal audio

> **Quick Reference** | Status: Accepted | Date: 2026-09-19
> **Decision**: Run SoX `rec` and `play` subprocesses behind the `Media` interface for microphone capture and playback.
> **Context**: A native Pi TUI extension needs audio without a browser, service, or platform-specific SDK.
> **Alternatives**: Browser WebRTC, platform audio APIs, Node native audio modules
> **Impact**: Installation, media lifecycle, latency, echo behavior, tests

---

## Context

Pi Voice runs inside the native Pi TUI. It needs a small audio boundary that can stream raw PCM and can be replaced with a fake in deterministic tests.

## Decision

**We will use SoX subprocesses as the default implementation of the `Media` interface.**

Pi Voice reads signed mono 16-bit PCM from `rec` and writes the same 24 kHz format to `play`.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| Browser WebRTC | Built-in echo cancellation and mature media controls | Requires a browser or companion service | Breaks the native TUI-only boundary |
| Platform audio APIs | Fine device control and lower-level processing | Separate macOS and Linux implementations | Too much platform-specific code for the first backend |
| Node native audio module | Direct process integration | Native builds and package compatibility risks | Harder Git-package installation |
| SoX subprocesses | Portable commands, raw PCM, replaceable port | External dependency; no acoustic echo cancellation | Chosen |

## Consequences

- **Positive**: The implementation stays small, portable, and testable through `Media` fakes.
- **Negative**: Users must install SoX, and speaker playback can feed back into the microphone.
- **Requires**: Pi Voice must own child-process cleanup, queue playback across restarts, and recommend headphones.

## Related

- [Architecture](../../architecture.md): Media boundary and session lifecycle.
- [ADR-0001](./ADR-0001-separate-conversation-from-coding.md): Conversation and coding roles.
