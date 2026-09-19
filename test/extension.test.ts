import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ExtensionAPI, MessageRenderer } from '@earendil-works/pi-coding-agent';
import { Redacted } from 'effect';
import { createFakeMedia } from '../src/media.ts';
import { createFakeTransport } from '../src/transport.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import voiceExtension from '../extensions/voice.ts';
import { STATUS_GLYPH } from '../src/domain.ts';
import { runScriptedCustom } from './overlay-driver.ts';

class FakeUi {
  widget: unknown;
  status = new Map<string, string | undefined>();
  overlayKeys: string[] = [];
  overlayFrames: string[][] = [];
  entries: Array<{ customType: string; data: unknown }> = [];
  theme = { fg(role: string, text: string) { return `${role}:${text}`; } };
  async custom<A>(factory: Parameters<typeof runScriptedCustom<A>>[0], options?: { overlay?: boolean }) {
    return runScriptedCustom(factory, options, this);
  }
  async editor() { return undefined; }
  notices: Array<{ message: string; level: string }> = [];
  setWidget(_id: string, value: unknown) { this.widget = value; }
  setStatus(key: string, text: string | undefined) { this.status.set(key, text); }
  notify(message: string, level = 'info') { this.notices.push({ message, level }); }
}

function renderedWidget(ui: FakeUi): string | undefined {
  if (typeof ui.widget !== 'function') return undefined;
  const factory = ui.widget as (tui: { requestRender(): void }, theme: FakeUi['theme']) => { render: (width: number) => string[] };
  return factory({ requestRender() {} }, ui.theme).render(80)[0];
}

function fakeBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    records: [] as Array<{ channel: string; data: unknown }>,
    emit(channel: string, data: unknown) {
      this.records.push({ channel, data });
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const channelHandlers = handlers.get(channel) ?? new Set();
      channelHandlers.add(handler);
      handlers.set(channel, channelHandlers);
      return () => channelHandlers.delete(handler);
    },
  };
}

function fakePi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }>();
  const events = new EventEmitter();
  const bus = fakeBus();
  const renderers = new Map<string, MessageRenderer>();
  const messages: Array<{ content: string; display: boolean; customType: string }> = [];
  const ui = new FakeUi();
  let idle = true;
  const api = {
    events: bus,
    registerMessageRenderer(name: string, renderer: MessageRenderer) { renderers.set(name, renderer); },
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) { ui.entries.push({ customType, data }); },
    registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<unknown> }) { commands.set(name, spec); },
    on(name: string, handler: (...args: unknown[]) => unknown) { events.on(name, handler); },
    sendUserMessage() { throw new Error('voice handoffs must not use sendUserMessage'); },
    sendMessage(message: { customType: string; content: string; display: boolean }) {
      messages.push(message);
      idle = false;
    },
    getAllTools() { return []; },
    getCommands() { return [...commands.keys()].map(name => ({ name })); },
  };
  const ctx = {
    mode: 'tui',
    ui,
    isIdle: () => idle,
    hasPendingMessages: () => !idle,
    sessionManager: { getSessionId: () => 's', getSessionFile: () => '/tmp/session.jsonl' },
  };
  return { api: api as unknown as ExtensionAPI, commands, events, bus, messages, ctx, ui, renderers };
}

test('voice command starts a fake session and delegates through a visible custom message', async () => {
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, apiKey: Redacted.make('test-key'), settings: DEFAULT_SETTINGS });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  assert.equal(renderedWidget(pi.ui), `accent:${STATUS_GLYPH.listening}  listening`);
  assert.equal(pi.ui.status.get('pi-voice'), `accent:${STATUS_GLYPH.listening}`);
  assert.ok(pi.bus.records.some(record =>
    record.channel === '@iurysza/pi-ext/footer-slot/register/v1'
    && (record.data as { id?: string; placement?: string }).id === 'pi-voice'
    && (record.data as { placement?: string }).placement === 'core'));
  transport.emit({ type: 'handoff', callId: 'c1', input: 'run the tests' });
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0]?.display, true);
  assert.ok(pi.renderers.has('pi-voice.delegation'));
  assert.equal(pi.messages[0]?.customType, 'pi-voice.delegation');
  assert.match(pi.messages[0]?.content ?? '', /<realtime_delegation>/);
  pi.events.emit('agent_end', { messages: [
    { customType: 'pi-voice.delegation', content: pi.messages[0]?.content },
    { role: 'assistant', content: 'tests passed' },
  ] });
  pi.events.emit('agent_settled', {}, pi.ctx);
  assert.ok(transport.sent.some(value => JSON.stringify(value).includes('[BACKEND] tests passed')));
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
  assert.equal(pi.ui.status.get('pi-voice'), undefined);
  await pi.events.emit('session_shutdown');
});

test('overlapping stop and start does not throw and leaves at most one session', async () => {
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, apiKey: Redacted.make('test-key'), settings: DEFAULT_SETTINGS });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  const stop = pi.commands.get('voice')?.handler('stop', pi.ctx);
  const start = pi.commands.get('voice')?.handler('start', pi.ctx);
  await Promise.all([stop, start]);
  await pi.events.emit('session_shutdown');
  assert.equal(pi.ui.notices.filter(notice => notice.level === 'error').length, 0);
});

test('failed agent turns are not spoken as backend answers', async () => {
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, apiKey: Redacted.make('test-key'), settings: DEFAULT_SETTINGS });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  transport.emit({ type: 'handoff', callId: 'c-fail', input: 'break' });
  pi.events.emit('agent_end', { messages: [
    { customType: 'pi-voice.delegation', content: '<realtime_delegation>\n  <input>break</input>\n</realtime_delegation>' },
    { role: 'assistant', content: 'boom', errorMessage: 'tool failed' },
  ] });
  pi.events.emit('agent_settled', {}, pi.ctx);
  assert.equal(transport.sent.filter(value => JSON.stringify(value).includes('[BACKEND] boom')).length, 0);
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});

test('an in-flight coding turn is not spoken as the voice handoff result', async () => {
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, apiKey: Redacted.make('test-key'), settings: DEFAULT_SETTINGS });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  transport.emit({ type: 'handoff', callId: 'c-voice', input: 'voice work' });
  pi.events.emit('agent_end', { messages: [{ role: 'user', content: 'typed first' }, { role: 'assistant', content: 'old typed answer' }] });
  pi.events.emit('agent_settled', {}, pi.ctx);
  assert.equal(transport.sent.filter(value => JSON.stringify(value).includes('[BACKEND] old typed answer')).length, 0);
  pi.events.emit('message_start', { message: { customType: 'pi-voice.delegation', content: pi.messages[0]?.content } });
  pi.events.emit('agent_end', { messages: [{ role: 'assistant', content: 'voice result' }] });
  pi.events.emit('agent_settled', {}, pi.ctx);
  assert.ok(transport.sent.some(value => JSON.stringify(value).includes('[BACKEND] voice result')));
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});

test('a retried voice turn keeps the successful extract instead of acking twice', async () => {
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, apiKey: Redacted.make('test-key'), settings: DEFAULT_SETTINGS });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  transport.emit({ type: 'handoff', callId: 'c-retry', input: 'retry work' });
  pi.events.emit('agent_end', { messages: [
    { customType: 'pi-voice.delegation', content: pi.messages[0]?.content },
    { role: 'assistant', content: 'partial', errorMessage: 'retrying' },
  ] });
  pi.events.emit('agent_end', { messages: [{ role: 'assistant', content: 'final after retry' }] });
  pi.events.emit('agent_settled', {}, pi.ctx);
  const sent = transport.sent.map(value => JSON.stringify(value));
  assert.equal(sent.filter(value => value.includes('[BACKEND] final after retry')).length, 1);
  assert.equal(sent.filter(value => value.includes('"call_id":"c-retry"')).length, 1);
  assert.equal(sent.filter(value => value.includes('[BACKEND] partial')).length, 0);
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});


test('settings command saves preferences without starting audio, then startup uses them', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-command-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, settingsPath: path.join(root, 'settings.json') });
  pi.ui.overlayKeys = ['v', 'j', 's', 'b', 'a'];
  await pi.commands.get('voice')?.handler('settings', pi.ctx);
  assert.equal(transport.sent.length, 0);
  assert.equal(pi.messages.length, 0);
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  const start = JSON.stringify(transport.sent[0]);
  assert.match(start, /cedar/);
  assert.match(start, /British English accent/);
  assert.match(start, /delegate_to_pi/);
  pi.ui.overlayKeys = ['l', 'a'];
  await pi.commands.get('voice')?.handler('settings', pi.ctx);
  assert.equal(pi.ui.widget, undefined);
  assert.equal(pi.ui.status.get('pi-voice'), `accent:${STATUS_GLYPH.listening}`);
  assert.match(pi.ui.notices.at(-1)?.message ?? '', /Voice preferences saved\.$/);
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});

test('startup uses a saved custom base prompt without replacing style or tool rules', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-live-prompt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
    liveInstructions: 'Always delegate file work. Never mention Pi.',
    voiceInstructions: 'Keep it brief.',
  }));
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, settingsPath: path.join(root, 'settings.json') });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  const start = JSON.stringify(transport.sent[0]);
  assert.match(start, /Always delegate file work/);
  assert.match(start, /Keep it brief/);
  assert.equal(start.includes('You are the spoken face'), false);
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});

test('empty /voice opens the overlay and Start begins a session', async () => {
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, apiKey: Redacted.make('test-key'), settings: DEFAULT_SETTINGS });
  pi.ui.overlayKeys = ['s'];
  await pi.commands.get('voice')?.handler('', pi.ctx);
  assert.equal(renderedWidget(pi.ui), `accent:${STATUS_GLYPH.listening}  listening`);
  assert.ok(pi.ui.overlayFrames.some(frame => frame.join('\n').includes('[s]') && frame.join('\n').includes('Start')));
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});

test('Pi → voice cards are session entries, not coding-agent messages', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-backend-card-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ showBackendMessages: true }));
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, settingsPath: path.join(root, 'settings.json') });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  transport.emit({ type: 'handoff', callId: 'c-back', input: 'summarise' });
  pi.events.emit('agent_end', { messages: [
    { customType: 'pi-voice.delegation', content: pi.messages[0]?.content },
    { role: 'assistant', content: 'done' },
  ] });
  pi.events.emit('agent_settled', {}, pi.ctx);
  assert.deepEqual(pi.ui.entries, [{ customType: 'pi-voice.backend', data: { text: 'done' } }]);
  assert.equal(pi.messages.filter(message => message.customType === 'pi-voice.backend').length, 0);
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});

test('live session settings that change the voice restart after confirm', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-live-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, settingsPath: path.join(root, 'settings.json') });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  pi.ui.overlayKeys = ['v', 'j', 'a', 'r'];
  await pi.commands.get('voice')?.handler('settings', pi.ctx);
  assert.match(pi.ui.notices.at(-1)?.message ?? '', /Restarting/);
  assert.ok(transport.sent.some(value => JSON.stringify(value).includes('cedar')));
  assert.equal(renderedWidget(pi.ui), `accent:${STATUS_GLYPH.listening}  listening`);
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});

test('stop still submits leftover user transcript as a coding turn', async () => {
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, apiKey: Redacted.make('test-key'), settings: DEFAULT_SETTINGS });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  transport.emit({ type: 'input_transcript_done', text: 'one last request' });
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0]?.content ?? '', /transcript_tail_flush/);
  assert.equal(pi.ctx.isIdle(), false);
});

test('live restart does not submit leftover speech and audio still works', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-restart-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pi = fakePi();
  const media = createFakeMedia();
  const transport = createFakeTransport();
  voiceExtension(pi.api, { media, transport, fake: true, settingsPath: path.join(root, 'settings.json') });
  await pi.commands.get('voice')?.handler('start', pi.ctx);
  transport.emit({ type: 'input_transcript_done', text: 'change the voice' });
  pi.ui.overlayKeys = ['v', 'j', 'a', 'r'];
  await pi.commands.get('voice')?.handler('settings', pi.ctx);
  assert.match(pi.ui.notices.at(-1)?.message ?? '', /Restarting/);
  assert.equal(transport.sent.filter(value => Array.isArray(value) && value[0] === 'start').length, 2);
  assert.equal(pi.messages.length, 0);
  assert.equal(pi.ctx.isIdle(), true);
  assert.equal(renderedWidget(pi.ui), `accent:${STATUS_GLYPH.listening}  listening`);
  media.clearPlayback();
  transport.emit({ type: 'audio_out', audio: Buffer.from('after-restart').toString('base64'), sampleRate: 24000 });
  assert.equal(Buffer.concat(media.playback).toString(), 'after-restart');
  const sentBeforeCapture = transport.sent.length;
  media.emitCapture(Buffer.from('frame-bytes'));
  assert.ok(transport.sent.slice(sentBeforeCapture).some(value => typeof value === 'object' && value !== null && (value as { type?: string }).type === 'input_audio_buffer.append'));
  transport.emit({ type: 'handoff', callId: 'after-restart', input: 'list the files' });
  assert.equal(pi.messages.length, 1);
  await pi.commands.get('voice')?.handler('stop', pi.ctx);
});
