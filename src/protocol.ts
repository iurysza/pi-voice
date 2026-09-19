import { Option, Predicate, Schema } from 'effect';
import { decodeJson, type Json } from './domain.ts';
import { SAMPLE_RATE } from './media.ts';
import { DEFAULT_SETTINGS, type VoiceSettings } from './settings.ts';

export type TurnDetectionSettings = Pick<VoiceSettings, 'vadThreshold' | 'vadSilenceDurationMs' | 'interruptResponse'>;

export const DELEGATE_TOOL_NAME = 'delegate_to_pi';
export const HANDOFF_COMPLETE_ACK = 'Background agent finished. Use the preceding [BACKEND] messages as the result.';

export const DELEGATE_TOOL = {
  type: 'function',
  name: DELEGATE_TOOL_NAME,
  description: 'Hand work to the Pi coding agent. Use for any action, file work, commands, or tasks that are not a self-contained spoken answer.',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The user request or spoken task to execute.' },
    },
    required: ['input'],
  },
} as const;

const ToolArgs = Schema.Struct({
  input: Schema.optionalKey(Schema.String),
  request: Schema.optionalKey(Schema.String),
  task: Schema.optionalKey(Schema.String),
});

export const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal('session_ready'), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal('speech_started'), itemId: Schema.String }),
  Schema.Struct({ type: Schema.Literal('input_transcript_delta'), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal('input_transcript_done'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('output_transcript_delta'), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal('output_transcript_done'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('audio_done') }),
  Schema.Struct({ type: Schema.Literal('audio_out'), audio: Schema.String, sampleRate: Schema.Number }),
  Schema.Struct({ type: Schema.Literal('handoff'), callId: Schema.String, input: Schema.String }),
  Schema.Struct({ type: Schema.Literal('error'), message: Schema.String, fatal: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal('closed'), reason: Schema.optionalKey(Schema.String) }),
]);

export type Inbound = typeof Inbound.Type;

const Envelope = Schema.Struct({
  type: Schema.String,
  session: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
  realtime_session_id: Schema.optionalKey(Schema.String),
  item_id: Schema.optionalKey(Schema.String),
  delta: Schema.optionalKey(Schema.String),
  transcript: Schema.optionalKey(Schema.String),
  audio: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
  sample_rate: Schema.optionalKey(Schema.Number),
  input_transcript: Schema.optionalKey(Schema.String),
  handoff_id: Schema.optionalKey(Schema.String),
  call_id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.Unknown),
  item: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});

const FunctionCallItem = Schema.Struct({
  type: Schema.Literal('function_call'),
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
  input: Schema.optionalKey(Schema.Unknown),
  call_id: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
});

const DelegationItem = Schema.Struct({
  type: Schema.Literal('delegation'),
  target: Schema.String,
  content: Schema.optionalKey(Schema.Unknown),
  input_transcript: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
});

const ContentPart = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
});

function jsonObject(value: unknown): unknown {
  if (!Predicate.isString(value)) return value;
  try { return JSON.parse(value); }
  catch { return { input: value }; }
}

function toolInput(raw: unknown): string | undefined {
  const decoded = Schema.decodeUnknownOption(ToolArgs)(jsonObject(raw));
  if (Option.isNone(decoded)) return Predicate.isString(raw) ? raw : undefined;
  return decoded.value.input ?? decoded.value.request ?? decoded.value.task;
}

function textParts(content: unknown): string {
  const parts = Schema.decodeUnknownOption(Schema.Array(ContentPart))(content);
  if (Option.isNone(parts)) return '';
  return parts.value.filter(part => part.type === 'input_text').map(part => part.text ?? '').join('');
}

function inbound(value: Inbound): Option.Option<Inbound> {
  return Schema.decodeUnknownOption(Inbound)(value);
}

function delegationFromItem(item: unknown): Option.Option<Inbound> {
  const call = Schema.decodeUnknownOption(FunctionCallItem)(item);
  if (Option.isSome(call) && call.value.name === DELEGATE_TOOL_NAME) {
    const input = toolInput(call.value.arguments ?? call.value.input);
    if (!input) return Option.none();
    return inbound({ type: 'handoff', callId: call.value.call_id ?? call.value.id ?? '', input });
  }
  const delegation = Schema.decodeUnknownOption(DelegationItem)(item);
  if (Option.isNone(delegation) || delegation.value.target !== 'client') return Option.none();
  const input = textParts(delegation.value.content) || delegation.value.input_transcript || '';
  if (!input) return Option.none();
  return inbound({ type: 'handoff', callId: delegation.value.id ?? '', input });
}

export function sessionUpdate(input: { readonly instructions: string; readonly voice: string; readonly model?: string; readonly turnDetection?: TurnDetectionSettings }): Json {
  const detection = input.turnDetection ?? DEFAULT_SETTINGS;
  const pcm = { type: 'audio/pcm', rate: SAMPLE_RATE };
  const session: Record<string, Json> = {
    type: 'realtime',
    instructions: input.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        format: pcm,
        transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: detection.vadThreshold,
          prefix_padding_ms: 300,
          silence_duration_ms: detection.vadSilenceDurationMs,
          interrupt_response: detection.interruptResponse,
        },
      },
      output: {
        format: pcm,
        voice: input.voice,
      },
    },
    tools: [DELEGATE_TOOL],
    tool_choice: 'auto',
  };
  if (input.model) session.model = input.model;
  return { type: 'session.update', session };
}

export function audioAppend(audio: string): Json {
  return { type: 'input_audio_buffer.append', audio };
}

export function createBackendItem(text: string): Json {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `[BACKEND] ${text}` }],
    },
  };
}

export function createFunctionOutput(input: { readonly callId: string; readonly output: string }): Json {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: input.callId,
      output: input.output,
    },
  };
}

export function responseCreate(): Json {
  return { type: 'response.create' };
}

function envelopeFrom(payload: unknown): Option.Option<typeof Envelope.Type> {
  if (Predicate.isString(payload) || Predicate.isUint8Array(payload) || Buffer.isBuffer(payload)) {
    try { return Schema.decodeUnknownOption(Envelope)(decodeJson(Schema.Json, JSON.parse(payload.toString()), 'Malformed realtime JSON')); }
    catch { return Option.none(); }
  }
  return Schema.decodeUnknownOption(Envelope)(payload);
}

export function parseInbound(payload: unknown): Option.Option<Inbound> {
  const message = envelopeFrom(payload);
  if (Option.isNone(message)) return Option.none();
  const value = message.value;
  const type = value.type;
  if (type === 'session.created' || type === 'session.updated' || type === 'session.started') {
    return inbound({ type: 'session_ready', sessionId: value.session?.id ?? value.realtime_session_id ?? '' });
  }
  if (type === 'input_audio_buffer.speech_started') return inbound({ type: 'speech_started', itemId: value.item_id ?? '' });
  if (type === 'conversation.item.input_audio_transcription.delta' || type === 'conversation.input_transcript.delta' || type === 'input_transcript.added') {
    const delta = value.delta ?? '';
    return delta ? inbound({ type: 'input_transcript_delta', delta }) : Option.none();
  }
  if (type === 'conversation.item.input_audio_transcription.completed' || type === 'conversation.input_transcript.turn_marked') {
    const text = value.transcript ?? '';
    return text ? inbound({ type: 'input_transcript_done', text }) : Option.none();
  }
  if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta' || type === 'conversation.output_transcript.delta' || type === 'output_transcript.added') {
    const delta = value.delta ?? '';
    return delta ? inbound({ type: 'output_transcript_delta', delta }) : Option.none();
  }
  if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
    const text = value.transcript ?? '';
    return text ? inbound({ type: 'output_transcript_done', text }) : Option.none();
  }
  if (type === 'response.output_audio.done' || type === 'response.audio.done') return inbound({ type: 'audio_done' });
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta' || type === 'conversation.output_audio.delta') {
    const audio = value.delta ?? value.audio ?? value.data ?? '';
    return audio ? inbound({ type: 'audio_out', audio, sampleRate: value.sample_rate ?? SAMPLE_RATE }) : Option.none();
  }
  if (type === 'conversation.handoff.requested') {
    const input = value.input_transcript ?? '';
    return input ? inbound({ type: 'handoff', callId: value.handoff_id ?? value.item_id ?? '', input }) : Option.none();
  }
  if (type === 'response.output_item.done' || type === 'delegation.created') {
    return delegationFromItem(value.item);
  }
  if (type === 'error') {
    let message = 'realtime error';
    if (Predicate.isString(value.error)) message = value.error;
    else {
      const detail = Schema.decodeUnknownOption(Schema.Struct({
        message: Schema.optionalKey(Schema.String),
        code: Schema.optionalKey(Schema.String),
      }))(value.error);
      if (Option.isSome(detail)) {
        const code = detail.value.code ?? '';
        const text = detail.value.message ?? '';
        message = text || code || 'realtime error';
        return inbound({ type: 'error', message, fatal: isFatalRealtimeError(`${code} ${text}`) });
      }
    }
    return inbound({ type: 'error', message, fatal: isFatalRealtimeError(message) });
  }
  return Option.none();
}

export function isFatalRealtimeError(message: string): boolean {
  return !/already_has_an_active_response|already has an active response/i.test(message);
}
