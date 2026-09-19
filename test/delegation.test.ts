import test from 'node:test';
import assert from 'node:assert/strict';
import { Option } from 'effect';
import { MAX_FIELD_BYTES, isVoiceDelegationTurn, parseDelegation, speakableFinalText, wrapDelegation } from '../src/delegation.ts';

test('delegation XML round-trips escaped fields and optional transcript delta', () => {
  const wrapped = wrapDelegation({ input: 'open <src/app.ts> & run', transcriptDelta: 'open files' });
  const parsed = Option.getOrThrow(parseDelegation(wrapped));
  assert.equal(parsed.input, 'open <src/app.ts> & run');
  assert.equal(parsed.transcriptDelta, 'open files');
  assert.equal(parsed.source, 'handoff');
  assert.equal(Option.isNone(parseDelegation('not xml')), true);
});

test('tail-flush source is preserved and fields are capped at 4KiB escaped', () => {
  const wrapped = wrapDelegation({ input: 'x'.repeat(8000), source: 'transcript_tail_flush' });
  const parsed = Option.getOrThrow(parseDelegation(wrapped));
  assert.equal(parsed.source, 'transcript_tail_flush');
  assert.ok(Buffer.byteLength(wrapped, 'utf8') < 8000);
  assert.ok(Buffer.byteLength(parsed.input, 'utf8') <= MAX_FIELD_BYTES);
});

test('private reasoning and oversized answers are not spoken', () => {
  assert.equal(speakableFinalText('[ANALYSIS] hidden'), undefined);
  assert.equal(speakableFinalText('[COMMENTARY] hidden'), undefined);
  assert.equal(speakableFinalText('a'.repeat(5000)), undefined);
  assert.equal(speakableFinalText('  files are listed  '), 'files are listed');
});

test('voice-originated turns are recognized from customType or XML', () => {
  assert.equal(isVoiceDelegationTurn({ messages: [{ role: 'user', content: 'typed' }] }), false);
  assert.equal(isVoiceDelegationTurn({ messages: [{ customType: 'pi-voice.delegation', content: wrapDelegation({ input: 'go' }) }] }), true);
  assert.equal(isVoiceDelegationTurn({ message: { customType: 'pi-voice.delegation' } }), true);
});
