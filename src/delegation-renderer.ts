import type { MessageRenderer } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Option, Predicate, Schema } from 'effect';
import { parseDelegation } from './delegation.ts';

export const BACKEND_ENTRY_TYPE = 'pi-voice.backend';

type ThemeColors = Pick<Parameters<MessageRenderer>[2], 'fg' | 'bg' | 'bold'>;

function renderRow(theme: ThemeColors, glyph: string, title: string, preview: string, body: string, expanded: boolean, outputPad: number) {
  const background = (text: string) => theme.bg('toolSuccessBg', text);
  const content = new Text(body, outputPad, 0, background);
  return {
    render(width: number): string[] {
      const header = `${glyph}  ${theme.fg('toolTitle', theme.bold(title))} ${theme.fg('text', preview)}`;
      const heading = new Text(truncateToWidth(header, width), 0, 0, background);
      return [...heading.render(width), ...(expanded ? content.render(width) : [])];
    },
    invalidate() { content.invalidate(); },
  };
}

export function renderDelegation(
  message: Parameters<MessageRenderer>[0],
  { expanded, outputPad }: Parameters<MessageRenderer>[1],
  theme: ThemeColors,
) {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);
  const parsed = parseDelegation(content);
  const preview = (Option.isSome(parsed) ? parsed.value.input : content).replace(/\s+/g, ' ').trim();
  return renderRow(theme, '🎙', 'voice', preview, content, expanded, outputPad);
}

const BackendEntry = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
});

const BackendData = Schema.Struct({
  text: Schema.String,
});

export function renderBackend(
  entry: unknown,
  { expanded, outputPad }: { expanded: boolean; outputPad?: number },
  theme: ThemeColors,
) {
  const parsed = Schema.decodeUnknownOption(BackendEntry)(entry);
  const data = Option.isSome(parsed) ? Schema.decodeUnknownOption(BackendData)(parsed.value.data) : Option.none();
  const text = Option.isSome(data) ? data.value.text : Predicate.isObject(entry) && Predicate.hasProperty(entry, 'data') && Predicate.isString(entry.data) ? entry.data : JSON.stringify(entry);
  const preview = text.replace(/\s+/g, ' ').trim();
  return renderRow(theme, '↩', 'pi', preview, `[BACKEND] ${text}`, expanded, outputPad ?? 0);
}
