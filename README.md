<p align="center">
  <img src="./assets/pi-voice-cover.png" alt="A pixel-art microphone, waveform, and code screens at a midnight terminal desk" width="100%">
</p>

<h1 align="center">Pi Voice</h1>

<p align="center">Talk to Pi. It hears the request, delegates real work to your coding agent, and speaks the useful result back.</p>

<p align="center">
  <a href="https://github.com/iurysza/pi-voice/actions/workflows/ci.yml"><img src="https://github.com/iurysza/pi-voice/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6" alt="MIT licence"></a>
  <a href="https://github.com/badlogic/pi-mono"><img src="https://img.shields.io/badge/Pi-0.85.1-7c3aed" alt="Pi 0.85.1"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-2563eb" alt="macOS and Linux">
</p>

Pi Voice is a [Pi](https://github.com/badlogic/pi-mono) extension for hands-free coding sessions. It uses OpenAI Realtime for speech, but hands actual work to the Pi agent you already use. Your delegated request stays visible as a `voice` entry and expands to show the exact message Pi received.

## Install

You need Pi `0.85.1`, Node `22.19.0` or later, [SoX](https://sox.sourceforge.net/) with `rec` and `play` on `PATH`, and an OpenAI API key with Realtime access.

Install a tagged release as a Pi Git package:

```sh
pi install git:github.com/iurysza/pi-voice@v0.1.0
```

Set the key only in the shell that starts Pi:

```sh
export OPENAI_API_KEY='...'
pi
```

Then run `/voice` in Pi. Use `/voice start` and `/voice stop` for direct control.

## Pi Voice is right for you if

- [x] You want to talk through a coding task without giving up Pi's normal tool use.
- [x] You want to see the exact request sent from voice to the coding agent.
- [x] You use headphones and can install SoX locally.
- [x] You want one place to tune voice, delivery style, VAD, interruptions, and playback padding.
- [x] You are happy to pay OpenAI API usage for live speech and your normal Pi provider for coding work.

## What happens when you speak

```text
microphone
  -> OpenAI Realtime listens and replies
  -> Pi Voice detects work that needs tools
  -> Pi receives a visible <realtime_delegation>
  -> Pi completes the task with your normal model and tools
  -> Pi Voice speaks the safe, useful result
```

Pi Voice only speaks user-facing results. Private reasoning, tool output, failed turns, code blocks, tables, and oversize answers stay in the terminal.

## Controls

| Control | What it does |
| --- | --- |
| `/voice` | Open the voice menu. |
| `/voice start` | Start listening and speaking. |
| `/voice stop` | Stop Voice. Leftover spoken text is submitted as a final coding request. |
| `/voice mute` | Release the microphone without ending the session. |
| `/voice settings` | Change voice, speaking style, base prompt, VAD, interruption, playback, and display settings. |
| `Ctrl+X`, then `v` | Open Voice through Leader Key when it is enabled. |

Saving a session-affecting setting while Voice is live asks to restart. That restart drops unfinished speech instead of turning it into an unwanted Pi task.

## Limits and costs

- Audio is pcm16 at 24 kHz.
- SoX capture and playback are portable but less responsive than WebRTC clients.
- There is no acoustic echo cancellation. Use headphones to prevent feedback.
- OpenAI bills Realtime audio and transcription usage. Pi coding turns use your selected Pi provider separately.
- The API key is read from `OPENAI_API_KEY`. It is never written to settings.

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run quality
```

`npm run quality` type-checks, builds, runs 88 deterministic tests, and checks the package contents with `npm pack --dry-run`.

Live microphone and Realtime checks are manual. They require SoX and an OpenAI API key; the automated suite uses fake media and transport implementations.

## Releases

This repository uses Conventional Commits and Release Please.

1. Merge conventional commits to `main`.
2. Release Please opens or updates a release PR with the version and changelog.
3. Merge that PR to create the GitHub Release and version tag.
4. Install a pinned release with `pi install git:github.com/iurysza/pi-voice@vX.Y.Z`.

Set the repository secret `RELEASE_PLEASE_TOKEN` to a fine-grained personal access token that can write repository contents and pull requests. Use it instead of the automatic `GITHUB_TOKEN` when a release must trigger another workflow.

Pi Voice is an extension, not a standalone binary. Git tags are the distribution boundary, so releases do not publish platform archives or checksums.

Dependabot checks npm dependencies weekly. Patch and minor updates are grouped; major updates remain separate. Enable Dependabot alerts and security-update pull requests in the repository security settings.

## Licence

[MIT](LICENSE)
