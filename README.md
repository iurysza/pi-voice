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

Pi Voice is a [Pi](https://github.com/badlogic/pi-mono) extension for hands-free coding sessions. It uses OpenAI Realtime for conversation, but sends actual work to the Pi agent you already use. Each delegated request appears as a visible `voice` entry and expands to show the exact message Pi received.

## Demo

https://github.com/user-attachments/assets/733bb991-55f8-4768-9f03-16a6ea4be72d

## Why this exists

Voice should make a coding agent easier to use, not replace it with a second, isolated assistant. Pi Voice keeps the live model focused on listening, speaking, and deciding when work needs doing. Pi keeps its tools, project context, and normal model.

The idea follows [this short post](https://x.com/IurySza/status/2101016432406577186) on combining a realtime conversational model with a capable coding agent.

## Install

You need Pi `0.85.1`, Node `22.19.0` or later, [SoX](https://sox.sourceforge.net/) with `rec` and `play` on `PATH`, and an OpenAI API key with Realtime access.

Install a tagged release as a Pi Git package:

```sh
pi install git:github.com/iurysza/pi-voice@v0.1.0
```

Set the key only in the shell that starts Pi:

```sh
export OPENAI_API_KEY=[REDACTED]
pi
```

Then run `/voice` in Pi. Use `/voice start` and `/voice stop` for direct control.

## Use headphones

> [!WARNING]
> **Use headphones with Pi Voice.** Pi Voice does not cancel acoustic echo, so your microphone can hear audio from your speakers. That can create feedback or make the voice model react to its own spoken reply. Headphones keep playback out of the microphone.

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

Saving a session-affecting setting while Voice is live asks to restart. That restart drops unfinished speech instead of turning it into an unwanted Pi task.

## Settings

Use `/voice settings` to change options in Pi. You can also create `~/.config/pi-voice/settings.json` for a portable starting point:

```json
{
  "voice": "marin",
  "voiceInstructions": "Warm, concise, and conversational.",
  "liveInstructions": "",
  "vadThreshold": 0.7,
  "vadSilenceDurationMs": 700,
  "interruptResponse": true,
  "playbackPaddingMs": 150,
  "showBackendMessages": false,
  "showStatusLine": true
}
```

`liveInstructions` replaces the live model's base prompt. `voiceInstructions` adds speaking-style guidance. Higher `vadThreshold` values require louder speech. `vadSilenceDurationMs` controls how long a pause ends your turn. `interruptResponse` lets you cut off a response by speaking. `playbackPaddingMs` adds silence around a reply to reduce clipped audio.

Pi Voice reads the API key only from `OPENAI_API_KEY`; never add credentials to the settings file.

## Limits and costs

- Audio is pcm16 at 24 kHz.
- SoX capture and playback are portable but less responsive than WebRTC clients.
- There is no acoustic echo cancellation. Use headphones to prevent feedback.
- OpenAI bills Realtime audio and transcription usage. Pi coding turns use your selected Pi provider separately.

## Architecture

Start with the [Pi Voice knowledge base](./ai-artifacts/_index.md). It routes readers from the shared domain language to runtime boundaries, concrete type flow, and the architectural decisions behind the two-model and terminal-audio design.

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run quality
```

The quality check runs the vendored Oxlint anti-slop rules, type-checks, builds, runs deterministic tests, and checks the package contents with `npm pack --dry-run`.

Live microphone and Realtime checks are manual. They require SoX and an OpenAI API key; the automated suite uses fake media and transport implementations.

## Releases

GitHub Releases and version tags are the distribution boundary. Install a pinned release with:

```sh
pi install git:github.com/iurysza/pi-voice@vX.Y.Z
```

Pi Voice is an extension, not a standalone binary. Releases do not publish platform archives or checksums.

## Licence

[MIT](LICENSE)
