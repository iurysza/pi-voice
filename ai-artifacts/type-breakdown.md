# Pi Voice type breakdown

This reference maps the existing `/voice` path from the Pi command to audio playback. Every item marked `[existing]` is confirmed in the current source.

## Execution tree

### Start a session

```text
▼ [existing] voiceExtension
  defined: extensions/voice.ts:77
  input:   ExtensionAPI, VoiceDependencies
  output:  void
  effects: registers /voice, renderers, and Pi lifecycle handlers

  └─▶ [existing] /voice command handler
      defined: extensions/voice.ts:198
      input:   string, ExtensionContext
      output:  Promise<void>

      └─▶ [existing] startVoice
          defined: extensions/voice.ts:120
          input:   ExtensionContext, "toggle" | "replace"
          output:  Promise<void>
          effects: loads settings, acquires resources, publishes status

          ├─▶ [existing] loadSettings
          │   defined: src/settings.ts
          │   input:   settings path
          │   output:  Effect<LoadedSettings, VoiceError>
          │
          ├─▶ [existing] voiceInstructions
          │   defined: src/prompt.ts:19
          │   input:   speaking style, optional base prompt
          │   output:  string
          │
          ├─▶ [existing] acquireSoxMedia
          │   defined: src/media.ts:137
          │   input:   capture command, playback command, padding
          │   output:  Effect<Media, VoiceError>
          │   effects: starts and owns rec/play child processes
          │
          ├─▶ [existing] acquireWebsocketTransport
          │   defined: src/transport.ts:200
          │   input:   API key, model, voice, instructions, URL, VAD settings
          │   output:  Effect<Transport, VoiceError>
          │   effects: opens and owns the Realtime WebSocket
          │
          ├─▶ [existing] VoiceLoop.begin
          │   defined: src/session.ts:67
          │   input:   current Pi-turn and retry state
          │   output:  boolean
          │   effects: transitions VoiceState and enables capture
          │
          └─▶ [existing] Transport.start
              defined: src/transport.ts
              input:   model, voice, instructions
              output:  Promise<void>
              effects: sends session.update
```

### Delegate a spoken request

```text
▼ [existing] VoiceLoop.dispatch
  defined: src/session.ts:93
  input:   Inbound
  output:  void

  └─▶ [existing] VoiceLoop.handoff
      defined: src/session.ts:162
      input:   callId: string, input: string
      output:  void
      effects: deduplicates the call and updates VoiceState

      ├─▶ [existing] noteVoiceInput
      │   defined: src/domain.ts:198
      │   input:   VoiceState, input, optional source
      │   output:  { state: VoiceState; maySpeak: boolean }
      │
      ├─▶ [existing] wrapDelegation
      │   defined: src/delegation.ts:44
      │   input:   input, optional transcriptDelta, optional source
      │   output:  string
      │
      └─▶ [existing] Host.sendDelegation
          defined: extensions/voice.ts:49
          input:   wrapped delegation
          output:  void
          effects: sends a visible pi-voice.delegation message to Pi
```

### Return and speak the result

```text
▼ [existing] agent_end + agent_settled handlers
  defined: extensions/voice.ts:264, extensions/voice.ts:275
  input:   Pi lifecycle events
  output:  void
  effects: extracts and queues a user-facing result

  └─▶ [existing] VoiceLoop.settled
      defined: src/session.ts
      input:   string
      output:  void

      ├─▶ [existing] speakableFinalText
      │   defined: src/delegation.ts:96
      │   input:   string
      │   output:  string | undefined
      │
      ├─▶ [existing] queueSpeech + takeQueuedSpeech
      │   defined: src/domain.ts:233, src/domain.ts:246
      │   input:   VoiceState, result text
      │   output:  generation-safe Speech | undefined
      │
      └─▶ [existing] Transport.completeHandoff
          defined: src/transport.ts
          input:   callId, optional output
          output:  void
          effects: sends BACKEND text, function output, and response.create

          └─▶ [existing] VoiceLoop.play
              defined: src/session.ts:157
              input:   base64 audio, sample rate
              output:  void
              effects: writes accepted PCM bytes to Media
```

## Type flows

### Realtime input

```text
unknown WebSocket payload
  → Envelope                       parseInbound() decodes known fields
  → Inbound                        event names become a closed union
  → VoiceState transition          VoiceLoop.dispatch() applies the event
  → delegation, playback, or status side effect
```

Malformed and unknown Realtime events become `Option.none()` and do not enter the session coordinator.

### Microphone audio

```text
SoX stdout Buffer
  → fixed 9,600-byte frame         media.ts frames 200 ms of pcm16 audio
  → Uint8Array                     Media.onCapture
  → base64 string                  Transport.appendAudio
  → input_audio_buffer.append      protocol.ts
```

`VoiceLoop.capture()` drops a frame when the session is outside `starting` or `active`, or when the microphone is muted.

### Delegation

```text
Realtime function-call arguments
  → ToolArgs                       input, request, or task
  → Inbound.handoff                callId + input
  → DelegationFields               input + transcriptDelta + source
  → <realtime_delegation> string   XML-escaped and byte-bounded
  → visible Pi message             customType: pi-voice.delegation
```

The wrapper retains the start of the request and the end of transcript context when either field exceeds 4 KiB.

### Pi result

```text
unknown Pi lifecycle event
  → extracted assistant text
  → user-facing result             private and oversize text rejected
  → Speech                         result + input generation
  → BACKEND conversation item
  → Realtime audio deltas
  → PCM playback bytes
```

The input generation prevents a result from an earlier voice turn from playing after typed input changes the active turn.

### Settings

```text
unknown JSON
  → FileSettings                   optional persisted fields
  → bounded audio controls         threshold, silence, and padding schemas
  → canonical VoiceSettings        valid voice, URL, and 24 kHz sample rate
  → VoicePreferences               fields owned by the settings overlay
```

`saveVoicePreferences()` merges only overlay-owned fields. It preserves custom capture commands, custom playback commands, and unknown user-owned keys.

## Important types

The definitions below are abbreviated from the code.

```ts
type Phase = "inactive" | "starting" | "active" | "stopping";

type VoiceState = {
  phase: Phase;
  attemptId: number;
  microphoneMuted: boolean;
  speakerSuppressed: boolean;
  inputGeneration: number;
  latestInputWasVoice: boolean;
  transcriptRole: string | null;
  transcript: string;
  pendingSpeech: ReadonlyArray<Speech>;
  transportReady: boolean;
  agentTurnRunning: boolean;
  awaitingDelegation: boolean;
  failure: string | null;
};

type Speech = {
  id: number;
  text: string;
  generation: number;
};
```

```ts
type Inbound =
  | { type: "session_ready"; sessionId: string }
  | { type: "speech_started"; itemId: string }
  | { type: "input_transcript_delta"; delta: string }
  | { type: "input_transcript_done"; text: string }
  | { type: "output_transcript_delta"; delta: string }
  | { type: "output_transcript_done"; text: string }
  | { type: "audio_done" }
  | { type: "audio_out"; audio: string; sampleRate: number }
  | { type: "handoff"; callId: string; input: string }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "closed"; reason?: string };
```

```ts
interface Media {
  onCapture(listener: (frame: Uint8Array) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  writePlayback(buffer: Uint8Array): void;
  setCaptureEnabled(enabled: boolean): void;
  finishPlayback(): void;
  clearPlayback(): void;
  close(): Promise<void>;
}

interface Transport {
  start(session: {
    instructions: string;
    voice: string;
    model: string;
  }): Promise<void>;
  appendAudio(audio: Uint8Array | string): void;
  appendSpeech(text: string): void;
  completeHandoff(input: {
    callId?: string;
    output?: string;
  }): void;
  onEvent(listener: (event: Inbound) => void): () => void;
  close(): Promise<void>;
}

interface Host {
  sendDelegation(text: string): void;
  setStatus(state: VoiceState): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
  endSession(): void;
  retryOnce(): void;
}
```

The three ports keep Pi APIs, media processes, and network events outside the state machine.

```ts
type DelegationFields = {
  input: string;
  transcriptDelta?: string;
  source: "handoff" | "transcript_tail_flush";
};

class VoiceError extends Schema.TaggedError {
  readonly _tag: "VoiceError";
  readonly code: string;
  readonly message: string;
}
```

## Error flow

```text
missing rec/play or child-process failure
  → VoiceError("media-missing") or Media.onError
  → Inbound.error(fatal: true)
  → fail(VoiceState)
  → host notification + session cleanup
```

```text
WebSocket error or fatal Realtime error
  → Inbound.error(fatal: true)
  → fail(VoiceState)
  → host notification + session cleanup
```

```text
already_has_an_active_response
  → Inbound.error(fatal: false)
  → warning
  → session remains active
```

```text
private, empty, or oversize Pi result
  → speakableFinalText() returns undefined
  → function call is acknowledged without spoken output
```

Settings read failures fall back to defaults and return diagnostics. Settings writes fail closed: malformed files, symbolic links, credentials, and permission errors leave the file unchanged.

## Change map

| Change | Primary owner | Related boundary |
| --- | --- | --- |
| Add a Realtime event | `src/protocol.ts` | Add an `Inbound` variant, then handle it in `VoiceLoop` |
| Change lifecycle rules | `src/domain.ts` | Keep transitions independent of Pi, SoX, and WebSocket APIs |
| Change orchestration | `src/session.ts` | Use only `Media`, `Transport`, and `Host` ports |
| Add an audio backend | `src/media.ts` | Implement `Media`; preserve 24 kHz pcm16 at the transport boundary |
| Add a transport backend | `src/transport.ts` | Emit only validated `Inbound` events |
| Change the visible handoff | `src/delegation.ts` and `extensions/voice.ts` | Preserve visibility, bounds, and private-result filtering |
| Add a setting | `src/settings.ts` and the settings UI | Define ownership, validation, persistence, and restart behavior |

Known constraints remain explicit rather than hidden in types: the live transport requires 24 kHz PCM, SoX provides no acoustic echo cancellation, and a live settings restart abandons unfinished speech.
