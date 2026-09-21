# AGENTS.md — Pi Voice

> Map, not manual. Start here, then follow pointers. Keep this file short so the task stays in context.

## Purpose

Pi Voice is a [Pi](https://github.com/badlogic/pi-mono) extension: OpenAI Realtime handles live speech, then Pi Voice delegates coding work to the Pi agent the user already uses. The live model listens, speaks, and decides when work needs tools; Pi keeps context, tools, and the actual coding.

## ai-artifacts

Project how-it-works docs live under [`ai-artifacts/`](./ai-artifacts/). **Start at [`ai-artifacts/_index.md`](./ai-artifacts/_index.md).** Keep those docs up to date when architecture or agent-facing behavior changes. Point to them; do not duplicate their content here.

| Need | Read |
| --- | --- |
| Knowledge-base map | [`ai-artifacts/_index.md`](./ai-artifacts/_index.md) |
| Domain language | [`ai-artifacts/CONTEXT.md`](./ai-artifacts/CONTEXT.md) |
| Runtime architecture | [`ai-artifacts/architecture.md`](./ai-artifacts/architecture.md) |
| Type / execution flow | [`ai-artifacts/type-breakdown.md`](./ai-artifacts/type-breakdown.md) |
| ADRs | [`ai-artifacts/docs/adr/INDEX.md`](./ai-artifacts/docs/adr/INDEX.md) |
| User-facing setup | [`README.md`](./README.md) |

## Closed loop

1. Read [`ai-artifacts/_index.md`](./ai-artifacts/_index.md) and [`README.md`](./README.md).
2. Make the change.
3. Lint: `npm run lint`
4. Typecheck: `npm run typecheck`
5. Build: `npm run build`
6. Test: `npm test` (needs a prior build)
7. Quality / pack check: `npm run quality`

Prefer step 7 as the one-liner gate before pushing.

## Commands

Requires **Node >= 22.19.0** (see [`.nvmrc`](./.nvmrc)).

```sh
npm ci                 # or: npm install
npm run lint           # oxlint
npm run typecheck      # tsc --noEmit
npm run build          # tsc; `prepare` also runs build
npm test               # node --test dist/test/*.test.js  (build first)
npm run test:all       # typecheck && build && test
npm run pack:check     # npm pack --dry-run
npm run quality        # lint && test:all && pack:check  ← prefer this
```

CI installs with `npm ci --ignore-scripts --no-audit --no-fund`. Automated tests use fake media and transport; live microphone / Realtime checks are manual.

## CI

GitHub Actions [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs `npm run quality` plus `git diff --check` on pull requests and pushes to `main`. Releases go through [`.github/workflows/release-please.yml`](./.github/workflows/release-please.yml) (`release-please-config.json`). Match `npm run quality` locally before pushing.

## Git commits

Never include Cursor (or any Cursor agent/bot) as git author, committer, or in a Co-authored-by / similar trailer.
