import test from 'node:test';
import assert from 'node:assert/strict';
import { Option, Schema } from 'effect';
import { DELEGATE_TOOL_NAME, HANDOFF_COMPLETE_ACK, isFatalRealtimeError, parseInbound, sessionUpdate } from '../src/protocol.ts';

function event(value: unknown) {
  return Option.getOrThrow(parseInbound(JSON.stringify(value)));
}

test('session tools stay registered when instructions omit delegate_to_pi', () => {
  const payload = sessionUpdate({ instructions: 'Always delegate file work. Never mention Pi.', voice: 'marin' });
  const session = Schema.decodeUnknownSync(Schema.Struct({
    session: Schema.Struct({
      instructions: Schema.String,
      tools: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  }))(payload).session;
  assert.equal(session.tools[0]?.name, DELEGATE_TOOL_NAME);
  assert.equal(session.instructions.includes(DELEGATE_TOOL_NAME), false);
});

test('session update uses the GA Realtime schema', () => {
  const payload = sessionUpdate({ instructions: 'speak', voice: 'marin', model: 'gpt-realtime' });
  const session = Schema.decodeUnknownSync(Schema.Struct({
    session: Schema.Struct({
      type: Schema.Literal('realtime'),
      model: Schema.optionalKey(Schema.String),
      output_modalities: Schema.Array(Schema.String),
      audio: Schema.Struct({
        input: Schema.Struct({
          format: Schema.Struct({ type: Schema.String, rate: Schema.Number }),
          transcription: Schema.Struct({ model: Schema.String }),
          turn_detection: Schema.Struct({ type: Schema.String }),
        }),
        output: Schema.Struct({
          format: Schema.Struct({ type: Schema.String, rate: Schema.Number }),
          voice: Schema.String,
        }),
      }),
      tools: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  }))(payload).session;
  assert.equal(session.type, 'realtime');
  assert.deepEqual(session.output_modalities, ['audio']);
  assert.equal(session.audio.input.format.type, 'audio/pcm');
  assert.equal(session.audio.input.format.rate, 24000);
  assert.equal(session.audio.input.transcription.model, 'whisper-1');
  assert.equal(session.audio.input.turn_detection.type, 'server_vad');
  assert.equal(session.audio.output.format.type, 'audio/pcm');
  assert.equal(session.audio.output.format.rate, 24000);
  assert.equal(session.audio.output.voice, 'marin');
  assert.equal(session.model, 'gpt-realtime');
  assert.equal(session.tools[0]?.name, DELEGATE_TOOL_NAME);
  const raw = (payload as { session: Record<string, unknown> }).session;
  assert.equal('modalities' in raw, false);
  assert.equal('input_audio_format' in raw, false);
  assert.equal('output_audio_format' in raw, false);
  assert.equal('voice' in raw, false);
});

test('one public function-call family and Codex dialects become handoff; duplicates are ignored at parse time', () => {
  const item = { type: 'function_call', name: DELEGATE_TOOL_NAME, call_id: 'c1', arguments: '{"input":"list files"}' };
  assert.equal(event({ type: 'response.output_item.done', item }).type, 'handoff');
  assert.equal(event({
    type: 'delegation.created',
    item: { type: 'delegation', target: 'client', id: 'd1', content: [{ type: 'input_text', text: 'run tests' }] },
  }).type, 'handoff');
  assert.equal(event({ type: 'conversation.handoff.requested', handoff_id: 'h1', input_transcript: 'open the file' }).type, 'handoff');
  assert.equal(Option.isNone(parseInbound(JSON.stringify({ type: 'response.function_call_arguments.done', name: DELEGATE_TOOL_NAME, call_id: 'c1', arguments: '{"input":"list files"}' }))), true);
  assert.equal(Option.isNone(parseInbound(JSON.stringify({ type: 'conversation.item.added', item }))), true);
  assert.equal(Option.isNone(parseInbound(JSON.stringify({ type: 'conversation.item.done', item }))), true);
});

test('session, audio, and errors still map; unrelated events stay none', () => {
  assert.equal(event({ type: 'session.created', session: { id: 's1' } }).type, 'session_ready');
  assert.equal(event({ type: 'response.output_audio.delta', delta: 'qq==', sample_rate: 24000 }).type, 'audio_out');
  assert.equal(event({ type: 'error', error: { message: 'quota' } }).type, 'error');
  assert.equal((event({ type: 'error', error: { message: 'quota' } }) as { fatal: boolean }).fatal, true);
  assert.equal((event({ type: 'error', error: { code: 'conversation_already_has_an_active_response' } }) as { fatal: boolean }).fatal, false);
  assert.equal((event({ type: 'error', error: { code: 'conversation_already_has_an_active_response', message: 'invalid request' } }) as { fatal: boolean }).fatal, false);
  assert.equal(isFatalRealtimeError('conversation_already_has_an_active_response'), false);
  assert.equal(Option.isNone(parseInbound('{"type":"response.done"}')), true);
  assert.equal(Option.isNone(parseInbound('not-json')), true);
});

test('non-delegate function calls are ignored', () => {
  assert.equal(Option.isNone(parseInbound(JSON.stringify({
    type: 'response.output_item.done',
    item: { type: 'function_call', name: 'other_tool', call_id: 'c2', arguments: '{"input":"nope"}' },
  }))), true);
});

test('handoff ack text stays an acknowledgement, not the coding-agent answer', () => {
  assert.match(HANDOFF_COMPLETE_ACK, /Background agent finished/);
  assert.notEqual(HANDOFF_COMPLETE_ACK.startsWith('[BACKEND]'), true);
});


test('GA session carries configured VAD threshold, silence and interruption policy', () => {
  const payload = sessionUpdate({ instructions: 'speak', voice: 'marin', turnDetection: { vadThreshold: 0.85, vadSilenceDurationMs: 1100, interruptResponse: false } });
  const decoded = Schema.decodeUnknownSync(Schema.Struct({ session: Schema.Struct({ audio: Schema.Struct({ input: Schema.Struct({ turn_detection: Schema.Unknown }) }) }) }))(payload);
  assert.deepEqual(decoded.session.audio.input.turn_detection, {
    type: 'server_vad', threshold: 0.85, prefix_padding_ms: 300, silence_duration_ms: 1100, interrupt_response: false,
  });
  assert.deepEqual(event({ type: 'response.output_audio.done' }), { type: 'audio_done' });
});
