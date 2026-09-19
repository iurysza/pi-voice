import { Effect, Option, Predicate, Schema } from 'effect';

export const PI_VERSION = '0.85.1';

export class VoiceError extends Schema.TaggedError<VoiceError>()('VoiceError', { code: Schema.String, message: Schema.String }) {}

export function isError(error: unknown): error is Error {
  return Predicate.isError(error);
}

export function errorMessage(error: Error): string {
  return error.message;
}

export function errorCode(error: Error): string | undefined {
  const parsed = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(error);

  return Option.isSome(parsed) ? parsed.value.code : undefined;
}

export const boundaryError = (error: Error): VoiceError => error instanceof VoiceError ? error : new VoiceError({ code: errorCode(error) ?? 'voice-failed', message: errorMessage(error) });

export const atomic = <A>(operation: () => A): Effect.Effect<A, VoiceError> => Effect.try({
  try: operation,
  catch: error => isError(error) ? boundaryError(error) : new VoiceError({ code: 'voice-failed', message: 'Local voice operation failed' }),
});

export function requireValue<T>(condition: T, message: string, code = 'invalid-request'): asserts condition {
  if (!condition) throw new VoiceError({ code, message });
}

export type Json = typeof Schema.Json.Type;

export function decodeJson<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, value: unknown, label = 'Invalid input'): S['Type'] {
  try { return Schema.decodeUnknownSync(schema)(value); }
  catch { throw new VoiceError({ code: 'invalid-request', message: label }); }
}

export const Phase = Schema.Literals(['inactive', 'starting', 'active', 'stopping']);

export type Phase = typeof Phase.Type;

export const StartupRetry = Schema.Literals(['available', 'used', 'waitingForStop']);

export type StartupRetry = typeof StartupRetry.Type;

export const Speech = Schema.Struct({ id: Schema.Number, text: Schema.String, generation: Schema.Number });

export type Speech = typeof Speech.Type;

export const Interleaved = Schema.Struct({ role: Schema.String, text: Schema.String });

export const VoiceState = Schema.Struct({
  phase: Phase,
  attemptId: Schema.Number,
  startupRetry: StartupRetry,
  microphoneMuted: Schema.Boolean,
  speakerSuppressed: Schema.Boolean,
  inputGeneration: Schema.Number,
  latestInputWasVoice: Schema.Boolean,
  pendingTypedInput: Schema.NullOr(Schema.String),
  latestVoiceFingerprint: Schema.NullOr(Schema.String),
  transcriptRole: Schema.NullOr(Schema.String),
  transcript: Schema.String,
  interleaved: Schema.NullOr(Interleaved),
  pendingSpeech: Schema.Array(Speech),
  nextSpeechId: Schema.Number,
  backendStarted: Schema.Boolean,
  transportReady: Schema.Boolean,
  agentTurnRunning: Schema.Boolean,
  awaitingDelegation: Schema.Boolean,
  failure: Schema.NullOr(Schema.String),
});

export type VoiceState = typeof VoiceState.Type;

export const MAX_TRANSCRIPT_BYTES = 1024;

export function initialState(): VoiceState {
  return {
    phase: 'inactive',
    attemptId: 0,
    startupRetry: 'available',
    microphoneMuted: false,
    speakerSuppressed: false,
    inputGeneration: 0,
    latestInputWasVoice: false,
    pendingTypedInput: null,
    latestVoiceFingerprint: null,
    transcriptRole: null,
    transcript: '',
    interleaved: null,
    pendingSpeech: [],
    nextSpeechId: 1,
    backendStarted: false,
    transportReady: false,
    agentTurnRunning: false,
    awaitingDelegation: false,
    failure: null,
  };
}

export function boundText(text: string, limit = MAX_TRANSCRIPT_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let end = text.length;

  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > limit) end -= 1;

  return text.slice(0, end);
}

export function fingerprint(text: string): string {
  const input = text.trim();
  let hash = 0xcbf29ce484222325n;

  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }

  return `${input.length}:${hash.toString(16)}`;
}

function maybeActivate(state: VoiceState): VoiceState {
  if (state.phase !== 'starting' || !state.backendStarted || !state.transportReady) return state;

  return {
    ...state,
    phase: 'active',
    latestInputWasVoice: !state.agentTurnRunning || state.awaitingDelegation,
    failure: null,
  };
}

export function beginStart(state: VoiceState, input?: { readonly agentTurnRunning?: boolean; readonly startupRetry?: StartupRetry }): VoiceState {
  if (state.phase === 'stopping') return { ...state, startupRetry: 'used', failure: 'Voice conversation is still stopping.' };

  if (state.phase !== 'inactive') return beginStop(state);

  return {
    ...initialState(),
    microphoneMuted: state.microphoneMuted,
    attemptId: state.attemptId + 1,
    phase: 'starting',
    agentTurnRunning: input?.agentTurnRunning === true,
    startupRetry: input?.startupRetry ?? 'available',
  };
}

export function markBackendStarted(state: VoiceState): VoiceState {
  if (state.phase !== 'starting') return state;

  return maybeActivate({ ...state, backendStarted: true });
}

export function markTransportReady(state: VoiceState): VoiceState {
  if (state.phase !== 'starting') return state;

  return maybeActivate({ ...state, transportReady: true });
}

export function beginStop(state: VoiceState): VoiceState {
  if (state.phase === 'inactive' || state.phase === 'stopping') return state;

  return { ...state, phase: 'stopping', startupRetry: 'used', speakerSuppressed: true };
}

export function reset(state: VoiceState): VoiceState {
  return {
    ...initialState(),
    microphoneMuted: state.microphoneMuted,
    attemptId: state.attemptId,
    startupRetry: state.startupRetry === 'waitingForStop' ? 'used' : 'available',
  };
}

export function fail(state: VoiceState, message: string): VoiceState {
  return { ...reset(state), failure: message };
}

export function requestRetry(state: VoiceState): VoiceState | undefined {
  if (state.phase !== 'starting' || state.startupRetry !== 'available') return undefined;

  return { ...state, phase: 'stopping', startupRetry: 'waitingForStop', failure: 'Voice connection timed out. Retrying once after cleanup.' };
}

export function toggleMute(state: VoiceState): VoiceState {
  if (state.phase !== 'active' && state.phase !== 'starting') return state;

  return { ...state, microphoneMuted: !state.microphoneMuted };
}

export function setSpeakerSuppressed(state: VoiceState, suppressed: boolean): VoiceState {
  if (state.phase !== 'active' && state.phase !== 'starting') return state;

  return { ...state, speakerSuppressed: suppressed };
}

export function noteTypedInput(state: VoiceState, text: string): VoiceState {
  if (state.phase !== 'active') return state;

  return {
    ...state,
    latestInputWasVoice: false,
    inputGeneration: state.inputGeneration + 1,
    speakerSuppressed: true,
    pendingTypedInput: text,
    pendingSpeech: [],
  };
}

export function noteVoiceInput(state: VoiceState, input: string, source?: string): { state: VoiceState; maySpeak: boolean } {
  if (state.phase !== 'starting' && state.phase !== 'active') return { state, maySpeak: false };
  const tailFlush = source === 'transcript_tail_flush';
  const voiceFingerprint = fingerprint(input);
  const stale = !state.latestInputWasVoice && state.latestVoiceFingerprint === voiceFingerprint;
  const maySpeak = !tailFlush && !stale;

  if (!maySpeak) return { state, maySpeak };

  return {
    state: {
      ...state,
      inputGeneration: state.latestInputWasVoice ? state.inputGeneration : state.inputGeneration + 1,
      latestInputWasVoice: true,
      speakerSuppressed: false,
      pendingTypedInput: null,
      latestVoiceFingerprint: voiceFingerprint,
      awaitingDelegation: !tailFlush,
    },
    maySpeak,
  };
}

export function applyTranscriptDelta(state: VoiceState, role: string, delta: string): VoiceState {
  if (state.phase === 'inactive') return state;

  const interleaved = state.transcriptRole && state.transcriptRole !== role && state.transcript
    ? { role: state.transcriptRole, text: state.transcript }
    : state.interleaved;

  const transcript = state.transcriptRole === role ? state.transcript : '';

  return { ...state, interleaved, transcriptRole: role, transcript: boundText(`${transcript}${delta}`) };
}

export function completeTranscript(state: VoiceState, role: string, text: string): VoiceState {
  const next = applyTranscriptDelta(state, role, '');

  return { ...next, transcript: boundText(text || next.transcript), transcriptRole: role };
}

export function queueSpeech(state: VoiceState, text: string): VoiceState {
  if (state.phase !== 'active' || !state.latestInputWasVoice || !state.awaitingDelegation) return state;

  return {
    ...state,
    nextSpeechId: state.nextSpeechId + 1,
    pendingSpeech: [...state.pendingSpeech, { id: state.nextSpeechId, text, generation: state.inputGeneration }],
  };
}

export function completeDelegation(state: VoiceState): VoiceState {
  return { ...state, awaitingDelegation: false };
}

export function takeQueuedSpeech(state: VoiceState): { state: VoiceState; speech: Speech | undefined } {
  if (state.pendingSpeech.length === 0) return { state, speech: undefined };
  const speech = state.pendingSpeech[0];
  const next = { ...state, pendingSpeech: state.pendingSpeech.slice(1) };

  if (!speech || speech.generation !== next.inputGeneration || !next.latestInputWasVoice) return { state: next, speech: undefined };

  return { state: next, speech };
}

export type FooterIconRole = 'accent' | 'dim' | 'muted' | 'warning';

export type StatusPresentation = {
  readonly glyph: string;
  readonly label: string;
  readonly role: FooterIconRole;
};

/** Nerd Font glyphs. Connecting uses Font Awesome `fa-spinner`, not Codicon loading. */
export const STATUS_GLYPH = {
  listening: '\u{EC1C}',
  muted: '\u{EB24}',
  connecting: '\u{F110}',
  typing: '\u{F097B}',
} as const;

export function statusPresentation(state: VoiceState): StatusPresentation | undefined {
  if (state.phase === 'inactive') return undefined;

  if (state.phase === 'starting') return { glyph: STATUS_GLYPH.connecting, label: 'connecting', role: 'dim' };

  if (state.phase === 'stopping') return { glyph: STATUS_GLYPH.connecting, label: 'stopping', role: 'dim' };

  if (state.microphoneMuted) return { glyph: STATUS_GLYPH.muted, label: 'muted', role: 'muted' };

  if (state.speakerSuppressed) return { glyph: STATUS_GLYPH.typing, label: 'typing', role: 'warning' };

  return { glyph: STATUS_GLYPH.listening, label: 'listening', role: 'accent' };
}

export function statusLine(state: VoiceState): string | undefined {
  const presentation = statusPresentation(state);

  return presentation ? `${presentation.glyph}  ${presentation.label}` : undefined;
}

export const FOOTER_ICON = STATUS_GLYPH.listening;

export const FOOTER_STATUS_KEY = 'pi-voice';

export function footerIconRole(state: VoiceState): FooterIconRole | undefined {
  return statusPresentation(state)?.role;
}
