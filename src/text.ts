import { Option, Predicate, Schema } from 'effect';

const TextPart = Schema.Struct({ text: Schema.optionalKey(Schema.String) });

function textFromContent(value: unknown): string {
  if (Predicate.isString(value)) return value;
  const parts = Schema.decodeUnknownOption(Schema.Array(Schema.Union([Schema.String, TextPart])))(value);

  if (Option.isNone(parts)) return '';

  return parts.value.map(part => Predicate.isString(part) ? part : part.text ?? '').filter(Boolean).join(' ');
}

const Message = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
  entry: Schema.optionalKey(Schema.Unknown),
  errorMessage: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Unknown),
  stopReason: Schema.optionalKey(Schema.String),
});

function failedStop(reason: string | undefined): boolean {
  return reason === 'error' || reason === 'aborted' || reason === 'cancelled';
}

function textFromMessage(value: unknown): string {
  const message = Schema.decodeUnknownOption(Message)(value);

  if (Option.isNone(message)) return '';
  const nested = Schema.decodeUnknownOption(Message)(message.value.message ?? message.value.entry);

  return textFromContent(message.value.content)
    || (Option.isSome(nested) ? textFromContent(nested.value.content) : '');
}

function messageFailed(value: unknown): boolean {
  const message = Schema.decodeUnknownOption(Message)(value);

  if (Option.isNone(message)) return false;

  if (message.value.errorMessage || message.value.error) return true;

  if (failedStop(message.value.stopReason)) return true;
  const nested = Schema.decodeUnknownOption(Message)(message.value.message ?? message.value.entry);

  return Option.isSome(nested) && Boolean(nested.value.errorMessage || nested.value.error || failedStop(nested.value.stopReason));
}

export function extractAssistantText(event: unknown): string {
  const payload = Schema.decodeUnknownOption(Schema.Struct({ messages: Schema.optionalKey(Schema.Array(Schema.Unknown)) }))(event);
  const messages = Option.isSome(payload) ? payload.value.messages ?? [] : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = Schema.decodeUnknownOption(Message)(messages[index]);

    if (Option.isSome(message) && message.value.role === 'assistant') return textFromMessage(message.value);
  }

  return textFromMessage(event);
}

export function extractSpeakableAssistant(event: unknown): string | undefined {
  const payload = Schema.decodeUnknownOption(Schema.Struct({
    messages: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    errorMessage: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.Unknown),
    willRetry: Schema.optionalKey(Schema.Boolean),
  }))(event);

  if (Option.isSome(payload)) {
    if (payload.value.willRetry || payload.value.errorMessage || payload.value.error) return undefined;
    const messages = payload.value.messages ?? [];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = Schema.decodeUnknownOption(Message)(messages[index]);

      if (Option.isNone(message) || message.value.role !== 'assistant') continue;

      if (messageFailed(message.value)) return undefined;
      const text = textFromMessage(message.value);

      return text || undefined;
    }

    return undefined;
  }

  if (messageFailed(event)) return undefined;
  const text = extractAssistantText(event);

  return text || undefined;
}
