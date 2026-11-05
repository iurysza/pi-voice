import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { MessageRenderOptions } from '@earendil-works/pi-coding-agent';
import { renderBackend, renderDelegation } from '../src/delegation-renderer.ts';
import { DELEGATION_CUSTOM_TYPE, wrapDelegation } from '../src/delegation.ts';

// No theme styling, so the assertion compares the actual visible text.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const keybindingHints: Pick<MessageRenderOptions, 'keyText' | 'keyHint'> = {
  keyText: () => '',
  keyHint: (_keybinding, description) => description,
};

test('expanded delegation shows the complete sent wrapper, not a paraphrase', () => {
  const content = wrapDelegation({ input: 'Explain <audio> & buffering', transcriptDelta: 'um, explain this', source: 'transcript_tail_flush' });
  const message = { role: 'custom' as const, customType: DELEGATION_CUSTOM_TYPE, content, display: true, timestamp: 0 };
  const expanded = renderDelegation(message, { ...keybindingHints, expanded: true, outputPad: 0 }, theme).render(200).map(line => line.trimEnd()).join('\n');
  assert.equal(expanded, `🎙  voice Explain <audio> & buffering\n${content}`);
  const collapsed = renderDelegation(message, { ...keybindingHints, expanded: false, outputPad: 0 }, theme).render(200).join('\n');
  assert.match(collapsed, /🎙  voice Explain <audio> & buffering/);
  assert.doesNotMatch(collapsed, /<realtime_delegation>/);

  for (const width of [20, 40]) {
    assert.ok(renderDelegation(message, { ...keybindingHints, expanded: true, outputPad: 0 }, theme).render(width).every(line => visibleWidth(line) <= width));
  }
});


test('collapsed requests fit one line with padding; expansion retains the full message', () => {
  const content = wrapDelegation({ input: 'First line of a much longer request\nSecond line that must not disappear from the expanded message' });
  const message = { role: 'custom' as const, customType: DELEGATION_CUSTOM_TYPE, content, display: true, timestamp: 0 };

  for (const width of [20, 40, 80]) {
    const rows = renderDelegation(message, { ...keybindingHints, expanded: false, outputPad: 1 }, theme).render(width);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]?.startsWith('🎙  voice '));
    assert.ok(rows.every(row => visibleWidth(row) <= width));
  }

  const expanded = renderDelegation(message, { ...keybindingHints, expanded: true, outputPad: 0 }, theme).render(200).map(row => row.trimEnd()).slice(1).join('\n');
  assert.equal(expanded, content);
});


test('collapsed and expanded rows use the completed-tool background', () => {
  const message = { role: 'custom' as const, customType: DELEGATION_CUSTOM_TYPE, content: wrapDelegation({ input: 'Check audio' }), display: true, timestamp: 0 };

  for (const expanded of [false, true]) {
    const backgrounds: string[] = [];

    const styled = { ...theme, bg: (color: string, text: string) => { backgrounds.push(color);

 return text; } };

    renderDelegation(message, { ...keybindingHints, expanded, outputPad: 1 }, styled).render(80);
    assert.ok(backgrounds.length > 0);
    assert.ok(backgrounds.every(color => color === 'toolSuccessBg'));
  }
});

test('backend cards preview the speakable answer and expand to the exact [BACKEND] payload', () => {
  const expanded = renderBackend({ data: { text: 'tests passed' } }, { expanded: true, outputPad: 0 }, theme).render(200).map(line => line.trimEnd()).join('\n');
  assert.equal(expanded, '↩  pi tests passed\n[BACKEND] tests passed');
  const collapsed = renderBackend({ data: { text: 'tests passed' } }, { expanded: false }, theme).render(200).join('\n');
  assert.match(collapsed, /↩  pi tests passed/);
  assert.doesNotMatch(collapsed, /\[BACKEND\]/);
});
