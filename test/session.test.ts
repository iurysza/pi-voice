import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN, wrapDelegation } from '../src/delegation.ts';
import { beginStart, initialState, markBackendStarted, markTransportReady, statusLine } from '../src/domain.ts';
import { createFakeMedia } from '../src/media.ts';
import { HANDOFF_COMPLETE_ACK } from '../src/protocol.ts';
import { VoiceLoop, STARTUP_TIMEOUT_MS, type Host } from '../src/session.ts';
import { createFakeTransport } from '../src/transport.ts';
import { extractAssistantText, extractSpeakableAssistant } from '../src/text.ts';

function host(): Host & { delegations: string[]; statuses: Array<string | undefined>; notices: string[]; ends: number; retries: number } {
  const delegations: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];

  return {
    delegations,
    statuses,
    notices,
    ends: 0,
    retries: 0,
    sendDelegation(text) { delegations.push(text); },
    setStatus(state) { statuses.push(statusLine(state)); },
    notify(message) { notices.push(message); },
    endSession() { this.ends += 1; },
    retryOnce() { this.retries += 1; },
  };
}

async function activeLoop(input?: { readonly agentTurnRunning?: boolean; readonly interruptResponse?: boolean }) {
  const media = createFakeMedia();
  const transport = createFakeTransport();
  const ui = host();
  const loop = new VoiceLoop(media, transport, ui, initialState(), input?.interruptResponse);
  loop.attach();
  loop.begin(input);
  loop.markBackend();
  await transport.start({ instructions: 'speak', voice: 'marin', model: 'gpt-realtime' });

  return { media, transport, ui, loop };
}

test('fake transport two-model loop: handoff wraps XML, final answer is spoken back as BACKEND with a tool ack', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  assert.equal(loop.state.phase, 'active');
  transport.emit({ type: 'handoff', callId: 'call-1', input: 'list the files' });
  assert.equal(ui.delegations.length, 1);
  assert.ok(ui.delegations[0]?.startsWith(OPEN));
  loop.settled('src/session.ts and src/protocol.ts');
  const sent = transport.sent.map(value => JSON.stringify(value));
  assert.ok(sent.some(value => value.includes('[BACKEND] src/session.ts and src/protocol.ts')));
  assert.ok(sent.some(value => value.includes(HANDOFF_COMPLETE_ACK)));
  assert.equal(sent.filter(value => value.includes('[BACKEND] src/session.ts and src/protocol.ts')).length, 1);
  loop.detach();
  await transport.close();
  await media.close();
});

test('duplicate public Realtime handoff events become one coding-agent turn', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  const item = { type: 'handoff', callId: 'call-dup', input: 'run tests' } as const;
  transport.emit(item);
  transport.emit(item);
  transport.emit({ type: 'handoff', callId: 'call-dup', input: 'run tests' });
  assert.equal(ui.delegations.length, 1);
  loop.detach();
  await transport.close();
  await media.close();
});

test('typed input drops speaker audio and private answers are not spoken', async () => {
  const { media, transport, loop } = await activeLoop();
  loop.typed('use a different approach');
  transport.emit({ type: 'audio_out', audio: Buffer.from('abcd').toString('base64'), sampleRate: 24000 });
  assert.equal(media.playback.length, 0);
  const before = transport.sent.length;
  loop.settled('[ANALYSIS] do not read this');
  assert.equal(transport.sent.length, before);
  loop.mute();
  media.emitCapture(Buffer.alloc(16));
  assert.equal(media.captureEnabled, false);
  assert.equal(transport.sent.filter(value => JSON.stringify(value).includes('input_audio_buffer.append')).length, 0);
  loop.detach();
  await transport.close();
  await media.close();
});

test('capture frames are appended until muted; barge-in clears playback', async () => {
  const { media, transport, loop } = await activeLoop();
  media.emitCapture(Buffer.from('frame-bytes'));
  assert.ok(transport.sent.some(value => typeof value === 'object' && value !== null && (value as { type?: string }).type === 'input_audio_buffer.append'));
  transport.emit({ type: 'audio_out', audio: Buffer.from('speak').toString('base64'), sampleRate: 24000 });
  assert.equal(media.playback.length, 1);
  transport.emit({ type: 'speech_started', itemId: 'u1' });
  assert.equal(media.playback.length, 0);
  loop.detach();
  await transport.close();
  await media.close();
});

test('transport error tears the session down through the host', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  transport.emit({ type: 'error', message: 'quota', fatal: true });
  assert.equal(ui.ends, 1);
  assert.ok(ui.notices.includes('quota'));
  assert.equal(loop.state.phase, 'inactive');
  loop.detach();
  await transport.close();
  await media.close();
});

test('settled answers from a typed in-flight turn are not spoken after /voice starts', async () => {
  const { media, transport, loop } = await activeLoop({ agentTurnRunning: true });
  assert.equal(loop.state.latestInputWasVoice, false);
  loop.settled('typed answer that must stay quiet');
  assert.equal(transport.sent.filter(value => JSON.stringify(value).includes('[BACKEND]')).length, 0);
  transport.emit({ type: 'handoff', callId: 'call-2', input: 'voice work' });
  loop.settled('voice result');
  assert.ok(transport.sent.some(value => JSON.stringify(value).includes('[BACKEND] voice result')));
  loop.detach();
  await transport.close();
  await media.close();
});

test('stop flushes leftover user transcript as a tail-flush delegation', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  transport.emit({ type: 'input_transcript_done', text: 'one last request' });
  loop.requestStop();
  assert.equal(ui.delegations.length, 1);
  assert.match(ui.delegations[0] ?? '', /transcript_tail_flush/);
  loop.detach();
  await transport.close();
  await media.close();
});

test('abandon tears the session down without submitting leftover speech', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  transport.emit({ type: 'input_transcript_done', text: 'change the voice' });
  loop.abandon();
  assert.equal(ui.delegations.length, 0);
  assert.equal(loop.state.phase, 'stopping');
  loop.detach();
  await transport.close();
  await media.close();
});

test('stop does not re-delegate a transcript that already produced a handoff', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  transport.emit({ type: 'input_transcript_done', text: 'list the files' });
  transport.emit({ type: 'handoff', callId: 'call-tail', input: 'list the files' });
  assert.equal(ui.delegations.length, 1);
  loop.requestStop();
  assert.equal(ui.delegations.length, 1);
  loop.detach();
  await transport.close();
  await media.close();
});

test('assistant text extraction prefers the last assistant message and skips failures', () => {
  assert.equal(extractAssistantText({
    messages: [
      { role: 'user', content: 'ignore' },
      { role: 'assistant', content: [{ text: 'first' }] },
      { role: 'assistant', content: [{ text: 'final answer' }] },
    ],
  }), 'final answer');
  assert.equal(extractSpeakableAssistant({ messages: [{ role: 'assistant', content: 'boom', errorMessage: 'failed' }] }), undefined);
  assert.equal(extractSpeakableAssistant({ willRetry: true, messages: [{ role: 'assistant', content: 'retrying' }] }), undefined);
  assert.equal(extractSpeakableAssistant({ messages: [{ role: 'assistant', content: 'ok' }] }), 'ok');
});

test('wrapDelegation helper stays available for host assertions', () => {
  assert.match(wrapDelegation({ input: 'go' }), /<input>go<\/input>/);
});

test('beginStart while a coding turn is running does not mark the in-flight answer as voice', () => {
  const state = markTransportReady(markBackendStarted(beginStart(initialState(), { agentTurnRunning: true })));
  assert.equal(state.phase, 'active');
  assert.equal(state.latestInputWasVoice, false);
});

test('two overlapping handoffs complete in request order', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  transport.emit({ type: 'handoff', callId: 'call-A', input: 'first' });
  transport.emit({ type: 'handoff', callId: 'call-B', input: 'second' });
  assert.equal(ui.delegations.length, 2);
  loop.settled('answer A');
  loop.settled('answer B');
  const sent = transport.sent.map(value => JSON.stringify(value));
  const answerA = sent.findIndex(value => value.includes('[BACKEND] answer A'));
  const ackA = sent.findIndex(value => value.includes('"call_id":"call-A"'));
  const answerB = sent.findIndex(value => value.includes('[BACKEND] answer B'));
  const ackB = sent.findIndex(value => value.includes('"call_id":"call-B"'));
  assert.ok(answerA >= 0 && ackA >= 0 && answerB >= 0 && ackB >= 0);
  assert.ok(answerA < ackA && ackA < answerB && answerB < ackB);
  loop.detach();
  await transport.close();
  await media.close();
});

test('repeat requests without a call id are not swallowed', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  transport.emit({ type: 'handoff', callId: '', input: 'same spoken request' });
  transport.emit({ type: 'handoff', callId: '', input: 'same spoken request' });
  assert.equal(ui.delegations.length, 2);
  loop.settled('first spoken');
  loop.settled('second spoken');
  const sent = transport.sent.map(value => JSON.stringify(value));
  assert.ok(sent.some(value => value.includes('[BACKEND] first spoken')));
  assert.ok(sent.some(value => value.includes('[BACKEND] second spoken')));
  loop.detach();
  await transport.close();
  await media.close();
});

test('a stale replay after typed input acks the tool without a second coding turn', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  transport.emit({ type: 'handoff', callId: 'call-1', input: 'list the files' });
  assert.equal(ui.delegations.length, 1);
  loop.typed('use a different approach');
  transport.emit({ type: 'handoff', callId: 'call-stale', input: 'list the files' });
  assert.equal(ui.delegations.length, 1);
  const sent = transport.sent.map(value => JSON.stringify(value));
  assert.equal(sent.filter(value => value.includes('"call_id":"call-stale"')).length, 1);
  assert.equal(sent.filter(value => value.includes('"type":"response.create"')).length, 0);
  loop.detach();
  await transport.close();
  await media.close();
});

test('a private final after a real handoff acks the tool without creating a spoken response', async () => {
  const { media, transport, loop } = await activeLoop();
  transport.emit({ type: 'handoff', callId: 'call-private', input: 'work' });
  const before = transport.sent.length;
  loop.settled('[ANALYSIS] hidden');
  const added = transport.sent.slice(before).map(value => JSON.stringify(value));
  assert.equal(added.filter(value => value.includes('"type":"message"')).length, 0);
  assert.equal(added.filter(value => value.includes('function_call_output')).length, 1);
  assert.equal(added.filter(value => value.includes('"type":"response.create"')).length, 0);
  loop.detach();
  await transport.close();
  await media.close();
});

test('benign realtime errors do not tear the session down', async () => {
  const { media, transport, ui, loop } = await activeLoop();
  transport.emit({ type: 'error', message: 'conversation_already_has_an_active_response', fatal: false });
  assert.equal(ui.ends, 0);
  assert.equal(loop.state.phase, 'active');
  loop.detach();
  await transport.close();
  await media.close();
});

test('startup timer does not fire after detach', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const media = createFakeMedia();
  const transport = createFakeTransport();
  const ui = host();
  const loop = new VoiceLoop(media, transport, ui, initialState());
  loop.attach();
  loop.begin();
  loop.armStartup(STARTUP_TIMEOUT_MS);
  loop.detach();
  t.mock.timers.tick(STARTUP_TIMEOUT_MS + 1);
  assert.equal(ui.retries, 0);
  assert.equal(ui.ends, 0);
});


test('disabled spoken interruption leaves queued playback intact', async () => {
  const { media, transport, loop } = await activeLoop({ interruptResponse: false });
  transport.emit({ type: 'audio_out', audio: Buffer.from('reply').toString('base64'), sampleRate: 24000 });
  transport.emit({ type: 'speech_started', itemId: 'noise' });
  assert.equal(Buffer.concat(media.playback).toString(), 'reply');
  loop.detach();
  await media.close();
  await transport.close();
});

test('audio completion finishes playback without clearing speech', async () => {
  const media = createFakeMedia();
  const transport = createFakeTransport();
  const ui = host();
  let finishCalls = 0;

  const trackedMedia = {
    ...media,
    finishPlayback() {
      finishCalls += 1;
      media.finishPlayback();
    },
  };

  const loop = new VoiceLoop(trackedMedia, transport, ui, initialState());
  loop.attach();
  loop.begin();
  loop.markBackend();
  await transport.start({ instructions: 'speak', voice: 'marin', model: 'gpt-realtime' });
  transport.emit({ type: 'audio_out', audio: Buffer.from('last word').toString('base64'), sampleRate: 24000 });
  transport.emit({ type: 'audio_done' });
  assert.equal(finishCalls, 1);
  assert.equal(Buffer.concat(media.playback).toString(), 'last word');
  loop.detach();
  await media.close();
  await transport.close();
});
