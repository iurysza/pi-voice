---
description: Records the decision to keep spoken conversation in OpenAI Realtime and coding work in the active Pi agent.
---

# ADR-0001: Separate conversation from coding work

This decision gives the [delegation sequence](../../architecture.md#delegating-a-coding-request) its two-model shape. Use the [domain language](../../CONTEXT.md#language) to distinguish the live model from the Pi agent, then follow the [delegation type flow](../../type-breakdown.md#delegation) when changing the handoff contract.

> **Quick Reference** | Status: Accepted | Date: 2026-09-19
> **Decision**: Use a live model for spoken conversation and delegate tool-based work to the active Pi agent.
> **Context**: Low-latency speech and repository-aware coding need different runtimes and context.
> **Alternatives**: Give all work to the live model, make Pi own speech directly
> **Impact**: Session orchestration, delegation, result filtering, billing

---

## Context

A Realtime model can hold a natural spoken conversation, but it does not share the active Pi agent's project context, tools, or selected coding model. Pi can complete the work, but it does not provide the same streaming speech loop.

## Decision

**We will use the live model for conversation and the active Pi agent for tool-based work.**

The live model calls `delegate_to_pi`. Pi Voice adds a visible delegation to the Pi transcript and returns only the user-facing result for speech.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| Let the live model do all work | One model and no handoff | Loses Pi context and tools; duplicates coding-agent behavior | Coding work must stay with Pi |
| Make Pi own speech directly | One reasoning context | Requires Pi to manage streaming audio and turn-taking | Pi is not a low-latency speech runtime |
| Separate conversation and coding | Each model keeps a focused role | Adds handoff latency and a second billing path | Chosen |

## Consequences

- **Positive**: Pi keeps its normal tools, project context, provider, and visible transcript.
- **Negative**: Delegated turns cross two model boundaries and can cost more than either model alone.
- **Requires**: Pi Voice must expose delegations, filter return text, and prevent stale results from being spoken.

## Related

The [runtime architecture](../../architecture.md) shows the resulting boundary between the Realtime conversation and Pi coding work. The [SoX decision](./ADR-0002-use-sox-for-terminal-audio.md) supplies the local audio boundary that feeds this conversation loop.
