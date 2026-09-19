import test from 'node:test';
import assert from 'node:assert/strict';
import { Redacted } from 'effect';
import { audioAppend } from '../src/protocol.ts';
import { LIVE_INSTRUCTIONS } from '../src/prompt.ts';
import { createWebsocketTransport, MAX_PENDING_FRAMES, transportErrorMessage, type HeaderSocket } from '../src/transport.ts';

test('websocket ErrorEvent-shaped payloads keep the underlying cause', () => {
  assert.equal(transportErrorMessage(new Error('connect ECONNREFUSED')), 'connect ECONNREFUSED');
  assert.equal(transportErrorMessage({ error: new Error('Unexpected server response: 401') }), 'Unexpected server response: 401');
  assert.equal(transportErrorMessage({ message: 'dns failed' }), 'dns failed');
  assert.equal(transportErrorMessage({}), 'voice transport error');
});

test('GA websocket handshake omits the retired beta header', async () => {
  let headers: Readonly<Record<string, string>> | undefined;
  const socket: HeaderSocket = {
    send() { /* unused */ },
    close() { /* unused */ },
    on() { /* unused */ },
  };
  const transport = createWebsocketTransport({
    apiKey: Redacted.make('sk-test'),
    model: 'gpt-realtime',
    voice: 'marin',
    instructions: LIVE_INSTRUCTIONS,
    wsUrl: 'wss://api.openai.com/v1/realtime',
    createSocket: (_url, options) => {
      headers = options.headers;
      return socket;
    },
  });
  assert.equal(headers?.Authorization?.startsWith('Bearer '), true);
  assert.equal(headers && Object.hasOwn(headers, 'OpenAI-Beta'), false);
  await transport.close();
});

test('pre-open audio frames preserve session.update and configured interruption settings', async () => {
  const sent: string[] = [];
  const listeners = new Map<string, (value?: unknown) => void>();
  const socket: HeaderSocket = {
    send(data) { sent.push(data); },
    close() { /* unused */ },
    on(event, listener) { listeners.set(event, listener); },
  };
  const transport = createWebsocketTransport({
    apiKey: Redacted.make('sk-test'),
    model: 'gpt-realtime',
    voice: 'marin',
    instructions: LIVE_INSTRUCTIONS,
    wsUrl: 'wss://api.openai.com/v1/realtime',
    turnDetection: { vadThreshold: 0.9, vadSilenceDurationMs: 1200, interruptResponse: false },
    createSocket: () => socket,
  });
  await transport.start({ instructions: LIVE_INSTRUCTIONS, voice: 'marin', model: 'gpt-realtime' });
  for (let index = 0; index < MAX_PENDING_FRAMES + 5; index += 1) {
    transport.send(audioAppend('qq=='));
  }
  listeners.get('open')?.();
  const first = JSON.parse(sent[0] ?? '{}') as { type?: string; session?: { type?: string; output_modalities?: string[]; audio?: { input?: { turn_detection?: unknown }; output?: unknown } } };
  assert.equal(first.type, 'session.update');
  assert.equal(first.session?.type, 'realtime');
  assert.deepEqual(first.session?.output_modalities, ['audio']);
  assert.equal(Boolean(first.session?.audio?.input && first.session?.audio?.output), true);
  assert.deepEqual(first.session?.audio?.input?.turn_detection, { type: 'server_vad', threshold: 0.9, prefix_padding_ms: 300, silence_duration_ms: 1200, interrupt_response: false });
  assert.ok(sent.some(value => value.includes('delegate_to_pi')));
  assert.equal(sent.filter(value => value.includes('input_audio_buffer.append')).length, MAX_PENDING_FRAMES);
  await transport.close();
});

test('live instructions keep always-delegate and do-not-read-formatted-content rules', () => {
  assert.match(LIVE_INSTRUCTIONS, /Never refuse/);
  assert.match(LIVE_INSTRUCTIONS, /tables, diffs, code blocks/);
});
