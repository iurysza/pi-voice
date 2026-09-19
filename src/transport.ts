import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Effect, Option, Predicate, Redacted } from 'effect';
import { VoiceError, atomic, requireValue } from './domain.ts';
import { audioAppend, createBackendItem, createFunctionOutput, HANDOFF_COMPLETE_ACK, parseInbound, responseCreate, sessionUpdate, type Inbound, type TurnDetectionSettings } from './protocol.ts';

export const MAX_PENDING_FRAMES = 32;

export interface Transport {
  readonly kind: 'fake' | 'websocket';
  readonly start: (session: { readonly instructions: string; readonly voice: string; readonly model: string }) => Promise<void>;
  readonly send: (message: unknown) => void;
  readonly appendAudio: (audio: Uint8Array | string) => void;
  readonly appendSpeech: (text: string) => void;
  readonly completeHandoff: (input: { readonly callId?: string; readonly output?: string }) => void;
  readonly onEvent: (listener: (event: Inbound) => void) => () => void;
  readonly close: () => Promise<void>;
}

export interface FakeTransport extends Transport {
  readonly kind: 'fake';
  readonly sent: unknown[];
  readonly emit: (event: Inbound) => void;
}

export interface HeaderSocket {
  send(data: string): void;
  close(): void;
  on?(event: string, listener: (value?: unknown) => void): void;
  addEventListener?(event: string, listener: (event: { data?: unknown }) => void): void;
}

export type CreateSocket = (url: string, options: { readonly headers: Readonly<Record<string, string>> }) => HeaderSocket;

function sendHandoff(send: (message: unknown) => void, input: { readonly callId?: string; readonly output?: string }): void {
  if (input.output) send(createBackendItem(input.output));

  if (input.callId) send(createFunctionOutput({ callId: input.callId, output: HANDOFF_COMPLETE_ACK }));

  if (input.output) send(responseCreate());
}

function isAudioAppend(payload: string): boolean {
  return payload.includes('"input_audio_buffer.append"');
}

export function createFakeTransport(): FakeTransport {
  const events = new EventEmitter();
  const sent: unknown[] = [];
  let closed = false;

  const transport: FakeTransport = {
    kind: 'fake',
    sent,
    async start(session) {
      sent.push(['start', session]);
      events.emit('event', { type: 'session_ready', sessionId: 'fake' } satisfies Inbound);
    },
    send(message) { sent.push(message); },
    appendAudio(audio) { transport.send(audioAppend(typeof audio === 'string' ? audio : Buffer.from(audio).toString('base64'))); },
    appendSpeech(text) {
      transport.send(createBackendItem(text));
      transport.send(responseCreate());
    },
    completeHandoff(input) { sendHandoff(transport.send, input); },
    onEvent(listener) { events.on('event', listener);

 return () => { events.off('event', listener); }; },
    emit(event) { if (!closed) events.emit('event', event); },
    async close() { closed = true; events.emit('event', { type: 'closed' } satisfies Inbound); events.removeAllListeners(); },
  };

  return transport;
}

function encodeAudio(buffer: Uint8Array | string): string {
  return typeof buffer === 'string' ? buffer : Buffer.from(buffer).toString('base64');
}

const loadWebSocket = Effect.fn('loadWebSocket')(function*() {
  const specifier = 'ws';

  const loaded = yield* Effect.tryPromise({
    try: () => import(specifier) as Promise<unknown>,
    catch: error => new VoiceError({ code: 'transport-missing', message: error instanceof Error ? error.message : 'Voice realtime transport needs the `ws` package.' }),
  });

  return yield* atomic(() => {
    const record = Predicate.isObject(loaded) ? loaded as { default?: unknown; WebSocket?: unknown } : {};
    const ctor = record.default ?? record.WebSocket;
    requireValue(Predicate.isFunction(ctor), 'Voice realtime transport needs the `ws` package.', 'transport-missing');

    return (url: string, options: { readonly headers: Readonly<Record<string, string>> }) => new (ctor as new (url: string, options: { headers: Readonly<Record<string, string>> }) => HeaderSocket)(url, options);
  });
});

function bind(socket: HeaderSocket, event: string, listener: (value: unknown) => void): void {
  if (socket.on) socket.on(event, listener);
  else socket.addEventListener?.(event, listener);
}

export function transportErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;

  if (Predicate.isObject(value)) {
    const record = value as { error?: unknown; message?: unknown };

    if (record.error instanceof Error && record.error.message.trim()) return record.error.message;

    if (Predicate.isString(record.message) && record.message.trim()) return record.message;
  }

  return 'voice transport error';
}

function closeReason(value: unknown): string | undefined {
  if (Predicate.isNumber(value) && value !== 1000) return `Voice websocket closed (${value})`;

  if (Predicate.isObject(value)) {
    const record = value as { code?: unknown; reason?: unknown };
    const code = Predicate.isNumber(record.code) ? record.code : undefined;
    const reason = Predicate.isString(record.reason) && record.reason.trim() ? record.reason : undefined;

    if (reason) return reason;

    if (code && code !== 1000) return `Voice websocket closed (${code})`;
  }

  if (Predicate.isString(value) && value.trim()) return value;

  return undefined;
}

export function createWebsocketTransport(options: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly model: string;
  readonly voice: string;
  readonly instructions: string;
  readonly wsUrl: string;
  readonly turnDetection?: TurnDetectionSettings;
  readonly createSocket: CreateSocket;
}): Transport {
  const url = new URL(options.wsUrl);

  if (options.model && !url.searchParams.has('model')) url.searchParams.set('model', options.model);

  const socket = options.createSocket(url.toString(), {
    headers: {
      Authorization: `Bearer ${Redacted.value(options.apiKey)}`,
    },
  });

  const events = new EventEmitter();
  let opened = false;
  const pending: string[] = [];

  function send(message: unknown) {
    const payload = JSON.stringify(message);

    if (!opened) {
      if (isAudioAppend(payload)) {
        const audioCount = pending.filter(isAudioAppend).length;

        if (audioCount >= MAX_PENDING_FRAMES) {
          const index = pending.findIndex(isAudioAppend);

          if (index >= 0) pending.splice(index, 1);
        }
      }

      pending.push(payload);

      return;
    }

    socket.send(payload);
  }

  bind(socket, 'open', () => {
    opened = true;

    for (const payload of pending.splice(0)) socket.send(payload);
  });
  bind(socket, 'message', value => {
    const data = PredicateStringData(value);
    const parsed = parseInbound(data);

    if (Option.isSome(parsed)) events.emit('event', parsed.value);
  });
  bind(socket, 'close', value => {
    const reason = closeReason(value);
    events.emit('event', reason ? { type: 'closed', reason } satisfies Inbound : { type: 'closed' } satisfies Inbound);
  });
  bind(socket, 'error', value => {
    events.emit('event', { type: 'error', message: transportErrorMessage(value), fatal: true } satisfies Inbound);
  });

  const transport: Transport = {
    kind: 'websocket',
    async start() {
      const input: { instructions: string; voice: string; model: string; turnDetection?: TurnDetectionSettings } = {
        instructions: options.instructions,
        voice: options.voice,
        model: options.model,
      };

      if (options.turnDetection) input.turnDetection = options.turnDetection;

      send(sessionUpdate(input));
    },
    send,
    appendAudio(audio) { send(audioAppend(encodeAudio(audio))); },
    appendSpeech(text) {
      send(createBackendItem(text));
      send(responseCreate());
    },
    completeHandoff(input) { sendHandoff(send, input); },
    onEvent(listener) { events.on('event', listener);

 return () => { events.off('event', listener); }; },
    async close() {
      try { socket.close(); } catch { /* already closed */ }

      events.removeAllListeners();
    },
  };

  return transport;
}

function PredicateStringData(value: unknown): unknown {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value.toString();

  if (value && typeof value === 'object' && 'data' in value) return (value as { data: unknown }).data;

  return value;
}

export const acquireFakeTransport = Effect.fnUntraced(function*() {
  const transport = createFakeTransport();
  yield* Effect.acquireRelease(Effect.succeed(transport), resource => Effect.promise(() => resource.close()));

  return transport;
});

export const acquireWebsocketTransport = Effect.fn('acquireWebsocketTransport')(function*(options: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly model: string;
  readonly voice: string;
  readonly instructions: string;
  readonly wsUrl: string;
  readonly turnDetection?: TurnDetectionSettings;
  readonly createSocket?: CreateSocket;
}) {
  yield* atomic(() => { requireValue(Redacted.value(options.apiKey).trim(), 'Voice requires OPENAI_API_KEY in the environment.', 'missing-key'); });
  const createSocket = options.createSocket ?? (yield* loadWebSocket());
  const transport = createWebsocketTransport({ ...options, createSocket });
  yield* Effect.acquireRelease(Effect.succeed(transport), resource => Effect.promise(() => resource.close()));

  return transport;
});
