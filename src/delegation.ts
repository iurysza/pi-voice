import { Option, Predicate, Schema } from 'effect';

export const OPEN = '<realtime_delegation>';

export const CLOSE = '</realtime_delegation>';

export const DELEGATION_CUSTOM_TYPE = 'pi-voice.delegation';

export const MAX_FIELD_BYTES = 4 * 1024;

export const TRUNCATION = '…';

export const MAX_SPEAKABLE_TOKENS = 990;

const DelegationFields = Schema.Struct({
  input: Schema.String,
  transcriptDelta: Schema.optionalKey(Schema.String),
  source: Schema.Literals(['handoff', 'transcript_tail_flush']),
});

export type DelegationFields = typeof DelegationFields.Type;

export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

export function escapeXml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function unescapeXml(input: string): string {
  return input.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function boundField(input: string, retain: 'start' | 'end'): string {
  const escaped = escapeXml(input);

  if (Buffer.byteLength(escaped, 'utf8') <= MAX_FIELD_BYTES) return escaped;
  const budget = MAX_FIELD_BYTES - Buffer.byteLength(TRUNCATION, 'utf8');

  if (retain === 'start') {
    let end = escaped.length;

    while (end > 0 && Buffer.byteLength(escaped.slice(0, end), 'utf8') > budget) end -= 1;

    return `${escaped.slice(0, end)}${TRUNCATION}`;
  }

  let start = 0;

  while (start < escaped.length && Buffer.byteLength(escaped.slice(start), 'utf8') > budget) start += 1;

  return `${TRUNCATION}${escaped.slice(start)}`;
}

export function wrapDelegation(input: { readonly input: string; readonly transcriptDelta?: string; readonly source?: string }): string {
  const body = boundField(input.input, 'start');
  const sourceLine = input.source === 'transcript_tail_flush' ? '  <source>transcript_tail_flush</source>\n' : '';

  if (input.transcriptDelta !== undefined) {
    return `${OPEN}\n${sourceLine}  <input>${body}</input>\n  <transcript_delta>${boundField(input.transcriptDelta, 'end')}</transcript_delta>\n${CLOSE}`;
  }

  return `${OPEN}\n${sourceLine}  <input>${body}</input>\n${CLOSE}`;
}

const InputField = Schema.String.check(Schema.makeFilter(value => value.includes('<input>') && value.includes('</input>')));

export function isVoiceDelegationMessage(value: unknown): boolean {
  const parsed = Schema.decodeUnknownOption(Schema.Struct({
    customType: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(Schema.Unknown),
    role: Schema.optionalKey(Schema.String),
  }))(value);

  if (Option.isNone(parsed)) return false;

  if (parsed.value.customType === DELEGATION_CUSTOM_TYPE) return true;

  if (Predicate.isString(parsed.value.content) && parsed.value.content.includes(OPEN)) return true;

  return false;
}

export function isVoiceDelegationTurn(event: unknown): boolean {
  const payload = Schema.decodeUnknownOption(Schema.Struct({
    messages: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    message: Schema.optionalKey(Schema.Unknown),
  }))(event);

  if (Option.isNone(payload)) return false;

  if (payload.value.message && isVoiceDelegationMessage(payload.value.message)) return true;

  return (payload.value.messages ?? []).some(isVoiceDelegationMessage);
}

export function parseDelegation(text: string): Option.Option<DelegationFields> {
  const raw = text.trim();

  if (!raw.startsWith(OPEN) || !raw.endsWith(CLOSE)) return Option.none();
  const inner = raw.slice(OPEN.length, raw.length - CLOSE.length);
  const checked = Schema.decodeUnknownOption(InputField)(inner);

  if (Option.isNone(checked)) return Option.none();
  const input = inner.match(/<input>([\s\S]*?)<\/input>/)?.[1];

  if (input === undefined) return Option.none();
  const transcriptDelta = inner.match(/<transcript_delta>([\s\S]*?)<\/transcript_delta>/)?.[1];

  return Schema.decodeUnknownOption(DelegationFields)(transcriptDelta === undefined
    ? { input: unescapeXml(input), source: inner.includes('<source>transcript_tail_flush</source>') ? 'transcript_tail_flush' : 'handoff' }
    : { input: unescapeXml(input), source: inner.includes('<source>transcript_tail_flush</source>') ? 'transcript_tail_flush' : 'handoff', transcriptDelta: unescapeXml(transcriptDelta) });
}

export function isPrivateAgentText(text: string): boolean {
  const value = text.trimStart();

  return value.startsWith('[ANALYSIS]') || value.startsWith('[COMMENTARY]');
}

export function speakableFinalText(text: string): string | undefined {
  const value = text.trim();

  if (!value || isPrivateAgentText(value)) return undefined;

  if (approxTokens(value) > MAX_SPEAKABLE_TOKENS) return undefined;

  return value;
}
