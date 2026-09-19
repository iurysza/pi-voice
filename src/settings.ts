import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Effect, Option, Result, Schema } from 'effect';
import { VoiceError, atomic, decodeJson, requireValue, type Json } from './domain.ts';
import { SAMPLE_RATE, commandSampleRate } from './media.ts';
import { storedLiveInstructions } from './prompt.ts';

export const DEFAULT_SETTINGS_PATH = join(homedir(), '.config/pi-voice/settings.json');
export const DEFAULT_WS_URL = 'wss://api.openai.com/v1/realtime';
export const DEFAULT_REALTIME_VOICE = 'marin';
export const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;

export const VoiceSettings = Schema.Struct({
  model: Schema.String,
  voice: Schema.String,
  liveInstructions: Schema.String,
  voiceInstructions: Schema.String,
  wsUrl: Schema.String,
  sampleRate: Schema.Number,
  vadThreshold: Schema.Number,
  vadSilenceDurationMs: Schema.Number,
  interruptResponse: Schema.Boolean,
  playbackPaddingMs: Schema.Number,
  showBackendMessages: Schema.Boolean,
  showStatusLine: Schema.Boolean,
  captureCommand: Schema.NullOr(Schema.Array(Schema.String)),
  playbackCommand: Schema.NullOr(Schema.Array(Schema.String)),
});

export type VoiceSettings = typeof VoiceSettings.Type;

export const DEFAULT_SETTINGS: VoiceSettings = {
  model: 'gpt-realtime',
  voice: DEFAULT_REALTIME_VOICE,
  liveInstructions: '',
  voiceInstructions: '',
  wsUrl: DEFAULT_WS_URL,
  sampleRate: SAMPLE_RATE,
  vadThreshold: 0.7,
  vadSilenceDurationMs: 700,
  interruptResponse: true,
  playbackPaddingMs: 150,
  showBackendMessages: false,
  showStatusLine: true,
  captureCommand: null,
  playbackCommand: null,
};

const FileSettings = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  voice: Schema.optionalKey(Schema.String),
  liveInstructions: Schema.optionalKey(Schema.String),
  voiceInstructions: Schema.optionalKey(Schema.String),
  wsUrl: Schema.optionalKey(Schema.String),
  sampleRate: Schema.optionalKey(Schema.Number),
  vadThreshold: Schema.optionalKey(Schema.Unknown),
  vadSilenceDurationMs: Schema.optionalKey(Schema.Unknown),
  interruptResponse: Schema.optionalKey(Schema.Unknown),
  playbackPaddingMs: Schema.optionalKey(Schema.Unknown),
  showBackendMessages: Schema.optionalKey(Schema.Unknown),
  showStatusLine: Schema.optionalKey(Schema.Unknown),
  captureCommand: Schema.optionalKey(Schema.Array(Schema.String)),
  playbackCommand: Schema.optionalKey(Schema.Array(Schema.String)),
});

// Local tuning ranges: threshold is a fraction; pauses are at most two seconds.
export const VadThreshold = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const VadSilence = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 }));
export const PlaybackPadding = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2000 }));

export function parseBoundedNumber(raw: string, schema: typeof VadThreshold | typeof VadSilence | typeof PlaybackPadding): Option.Option<number> {
  const trimmed = raw.trim();
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return Option.none();
  return Schema.decodeUnknownOption(schema)(Number(trimmed));
}

function audioControls(value: typeof FileSettings.Type) {
  const diagnostics: string[] = [];
  function read<A>(name: string, raw: unknown, schema: Schema.ConstraintDecoder<A>, fallback: A): A {
    if (raw === undefined) return fallback;
    const decoded = Schema.decodeUnknownOption(schema)(raw);
    if (Option.isSome(decoded)) return decoded.value;
    diagnostics.push(`Invalid voice ${name}; using ${String(fallback)}.`);
    return fallback;
  }
  return {
    settings: {
      vadThreshold: read('vadThreshold', value.vadThreshold, VadThreshold, DEFAULT_SETTINGS.vadThreshold),
      vadSilenceDurationMs: read('vadSilenceDurationMs', value.vadSilenceDurationMs, VadSilence, DEFAULT_SETTINGS.vadSilenceDurationMs),
      interruptResponse: read('interruptResponse', value.interruptResponse, Schema.Boolean, DEFAULT_SETTINGS.interruptResponse),
      playbackPaddingMs: read('playbackPaddingMs', value.playbackPaddingMs, PlaybackPadding, DEFAULT_SETTINGS.playbackPaddingMs),
      showBackendMessages: read('showBackendMessages', value.showBackendMessages, Schema.Boolean, DEFAULT_SETTINGS.showBackendMessages),
      showStatusLine: read('showStatusLine', value.showStatusLine, Schema.Boolean, DEFAULT_SETTINGS.showStatusLine),
    },
    diagnostics,
  };
}

function nonempty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function canonicalizeWsUrl(raw: string): { url: string; diagnostics: string[] } {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'wss:') {
      if (parsed.hostname === 'api.openai.com') return { url: parsed.toString(), diagnostics: [] };
      return { url: DEFAULT_WS_URL, diagnostics: [`Voice websocket host ${parsed.hostname} is not api.openai.com. Using ${DEFAULT_WS_URL}.`] };
    }
    if (parsed.protocol === 'ws:' && loopback(parsed.hostname)) return { url: parsed.toString(), diagnostics: [] };
    return { url: DEFAULT_WS_URL, diagnostics: [`Voice websocket URL must be wss:// (or ws:// on localhost). Using ${DEFAULT_WS_URL}.`] };
  } catch {
    return { url: DEFAULT_WS_URL, diagnostics: [`Voice websocket URL is invalid. Using ${DEFAULT_WS_URL}.`] };
  }
}

export function canonicalizeSettings(input: VoiceSettings): { settings: VoiceSettings; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const voice = REALTIME_VOICES.includes(input.voice as typeof REALTIME_VOICES[number]) ? input.voice : DEFAULT_REALTIME_VOICE;
  if (voice !== input.voice) diagnostics.push(`Voice "${input.voice}" is not a public Realtime voice. Using ${DEFAULT_REALTIME_VOICE}.`);
  const sampleRate = input.sampleRate === SAMPLE_RATE ? input.sampleRate : SAMPLE_RATE;
  if (sampleRate !== input.sampleRate) diagnostics.push(`Realtime PCM is 24 kHz only. Ignoring sampleRate ${input.sampleRate}.`);
  const ws = canonicalizeWsUrl(input.wsUrl);
  diagnostics.push(...ws.diagnostics);
  for (const [label, command] of [['capture', input.captureCommand], ['playback', input.playbackCommand]] as const) {
    const rate = commandSampleRate(command);
    if (rate && rate !== String(SAMPLE_RATE)) diagnostics.push(`Voice ${label} uses sample rate ${rate}; Realtime PCM is ${SAMPLE_RATE} Hz.`);
  }
  return {
    settings: { ...input, voice, sampleRate, wsUrl: ws.url },
    diagnostics,
  };
}

export function normalizeSettings(raw: unknown): VoiceSettings {
  const parsed = Schema.decodeUnknownOption(FileSettings)(raw);
  const value = Option.isSome(parsed) ? parsed.value : {};
  const sampleRate = value.sampleRate !== undefined && Number.isFinite(value.sampleRate) && value.sampleRate > 0 ? value.sampleRate : DEFAULT_SETTINGS.sampleRate;
  return canonicalizeSettings({
    model: nonempty(value.model, DEFAULT_SETTINGS.model),
    voice: nonempty(value.voice, DEFAULT_SETTINGS.voice),
    liveInstructions: storedLiveInstructions(value.liveInstructions ?? DEFAULT_SETTINGS.liveInstructions),
    voiceInstructions: value.voiceInstructions?.trim() ?? DEFAULT_SETTINGS.voiceInstructions,
    wsUrl: nonempty(value.wsUrl, DEFAULT_SETTINGS.wsUrl),
    sampleRate,
    ...audioControls(value).settings,
    captureCommand: value.captureCommand ?? null,
    playbackCommand: value.playbackCommand ?? null,
  }).settings;
}

export function settingsDiagnostics(raw: unknown): string[] {
  const parsed = Schema.decodeUnknownOption(FileSettings)(raw);
  const value = Option.isSome(parsed) ? parsed.value : {};
  const sampleRate = value.sampleRate !== undefined && Number.isFinite(value.sampleRate) && value.sampleRate > 0 ? value.sampleRate : DEFAULT_SETTINGS.sampleRate;
  return canonicalizeSettings({
    model: nonempty(value.model, DEFAULT_SETTINGS.model),
    voice: nonempty(value.voice, DEFAULT_SETTINGS.voice),
    liveInstructions: storedLiveInstructions(value.liveInstructions ?? DEFAULT_SETTINGS.liveInstructions),
    voiceInstructions: value.voiceInstructions?.trim() ?? DEFAULT_SETTINGS.voiceInstructions,
    wsUrl: nonempty(value.wsUrl, DEFAULT_SETTINGS.wsUrl),
    sampleRate,
    ...audioControls(value).settings,
    captureCommand: value.captureCommand ?? null,
    playbackCommand: value.playbackCommand ?? null,
  }).diagnostics.concat(audioControls(value).diagnostics);
}

export const LoadedSettings = Schema.Struct({
  path: Schema.String,
  loaded: Schema.Boolean,
  settings: VoiceSettings,
  diagnostics: Schema.Array(Schema.String),
});

export type LoadedSettings = typeof LoadedSettings.Type;

export const loadSettings = Effect.fn('loadSettings')(function*(path = DEFAULT_SETTINGS_PATH): Effect.fn.Return<LoadedSettings, VoiceError> {
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, 'utf8'),
    catch: error => error,
  }).pipe(Effect.result);
  if (Result.isFailure(text)) {
    const code = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(text.failure);
    if (Option.isSome(code) && code.value.code === 'ENOENT') {
      return { path, loaded: false, settings: DEFAULT_SETTINGS, diagnostics: [] };
    }
    const message = text.failure instanceof Error ? text.failure.message : 'unknown settings error';
    return { path, loaded: false, settings: DEFAULT_SETTINGS, diagnostics: [`Failed to read voice settings: ${message}`] };
  }
  return yield* atomic(() => {
    const json = decodeJson(Schema.Json, JSON.parse(text.success), 'Malformed voice settings JSON');
    const settings = normalizeSettings(json);
    return { path, loaded: true, settings, diagnostics: settingsDiagnostics(json) };
  }).pipe(Effect.catch((error: VoiceError) => Effect.succeed({
    path,
    loaded: false,
    settings: DEFAULT_SETTINGS,
    diagnostics: [`Failed to read voice settings: ${error.message}`],
  })));
});


const VoicePreferences = Schema.Struct({
  voice: Schema.Literals(REALTIME_VOICES),
  liveInstructions: Schema.String,
  voiceInstructions: Schema.String,
  vadThreshold: VadThreshold,
  vadSilenceDurationMs: VadSilence,
  interruptResponse: Schema.Boolean,
  playbackPaddingMs: PlaybackPadding,
  showBackendMessages: Schema.Boolean,
  showStatusLine: Schema.Boolean,
});
export type VoicePreferences = typeof VoicePreferences.Type;

// Save panel fields only, preserving capture/playback commands and other user-owned keys.
// Invalid files and credential-bearing files must not be rewritten or backed up.
export const saveVoicePreferences = Effect.fn('saveVoicePreferences')(function*(preferences: VoicePreferences, path = DEFAULT_SETTINGS_PATH) {
  const checked = yield* atomic(() => decodeJson(VoicePreferences, {
    ...preferences,
    liveInstructions: storedLiveInstructions(preferences.liveInstructions),
    voiceInstructions: preferences.voiceInstructions.trim(),
  }, 'Invalid voice preferences'));
  yield* Effect.tryPromise({
    try: async () => {
      let current: Record<string, Json> = {};
      try {
        const info = await lstat(path);
        requireValue(info.isFile() && !info.isSymbolicLink(), 'Voice settings must be a regular file.', 'settings-write');
        const text = await readFile(path, 'utf8');
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new VoiceError({ code: 'settings-write', message: 'Voice settings contain invalid JSON; file left unchanged.' }); }
        current = decodeJson(Schema.Record(Schema.String, Schema.Json), parsed, 'Voice settings must be a JSON object; file left unchanged.');
        requireValue(!('apiKey' in current) && !('OPENAI_API_KEY' in current), 'Remove credentials from voice settings before saving preferences. Use the process environment.', 'settings-write');
      } catch (error) {
        const code = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(error);
        if (Option.isNone(code) || code.value.code !== 'ENOENT') throw error;
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ ...current, ...checked }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    },
    catch: error => error instanceof VoiceError ? error : new VoiceError({ code: 'settings-write', message: 'Could not save voice preferences. Check settings file permissions.' }),
  });
});
