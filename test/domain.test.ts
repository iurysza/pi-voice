import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTranscriptDelta,
  beginStart,
  beginStop,
  fail,
  fingerprint,
  initialState,
  markBackendStarted,
  markTransportReady,
  noteTypedInput,
  noteVoiceInput,
  queueSpeech,
  requestRetry,
  statusLine,
  statusPresentation,
  footerIconRole,
  FOOTER_ICON,
  STATUS_GLYPH,
  takeQueuedSpeech,
  toggleMute,
} from '../src/domain.ts';

test('activation requires backend started and transport ready', () => {
  let state = beginStart(initialState());
  assert.equal(state.phase, 'starting');
  state = markBackendStarted(state);
  assert.equal(state.phase, 'starting');
  state = markTransportReady(state);
  assert.equal(state.phase, 'active');
  assert.equal(statusLine(state), `${STATUS_GLYPH.listening}  listening`);
  assert.deepEqual(statusPresentation(state), { glyph: STATUS_GLYPH.listening, label: 'listening', role: 'accent' });
  assert.equal(footerIconRole(state), 'accent');
  assert.equal(FOOTER_ICON, STATUS_GLYPH.listening);
});

test('bare start while active becomes a stop', () => {
  let state = markTransportReady(markBackendStarted(beginStart(initialState())));
  state = beginStart(state);
  assert.equal(state.phase, 'stopping');
  assert.equal(statusLine(state), `${STATUS_GLYPH.connecting}  stopping`);
  assert.equal(footerIconRole(state), 'dim');
});

test('footer icon is absent when inactive, muted when capture is off', () => {
  assert.equal(footerIconRole(initialState()), undefined);
  assert.equal(statusPresentation(beginStart(initialState()))?.glyph, STATUS_GLYPH.connecting);
  const active = markTransportReady(markBackendStarted(beginStart(initialState())));
  assert.equal(footerIconRole(toggleMute(active)), 'muted');
  assert.equal(statusLine(toggleMute(active)), `${STATUS_GLYPH.muted}  muted`);
});

test('typed input suppresses speaker and invalidates queued speech', () => {
  let state = markTransportReady(markBackendStarted(beginStart(initialState())));
  state = noteVoiceInput(state, 'list the files').state;
  state = queueSpeech(state, 'do not speak this');
  assert.equal(state.pendingSpeech.length, 1);
  state = noteTypedInput(state, 'typed steer');
  assert.equal(state.latestInputWasVoice, false);
  assert.equal(state.speakerSuppressed, true);
  assert.equal(state.pendingSpeech.length, 0);
  assert.equal(statusLine(state), `${STATUS_GLYPH.typing}  typing`);
  assert.equal(footerIconRole(state), 'warning');
  const taken = takeQueuedSpeech(queueSpeech(state, 'still typed'));
  assert.equal(taken.speech, undefined);
});

test('a new voice handoff can supersede a typed turn', () => {
  let state = noteTypedInput(markTransportReady(markBackendStarted(beginStart(initialState()))), 'typed');
  const voiced = noteVoiceInput(state, 'list the files');
  assert.equal(voiced.maySpeak, true);
  assert.equal(voiced.state.latestInputWasVoice, true);
  assert.equal(voiced.state.speakerSuppressed, false);
});

test('duplicate voice fingerprint after typed input is stale', () => {
  const first = noteVoiceInput(markTransportReady(markBackendStarted(beginStart(initialState()))), 'same request');
  const typed = noteTypedInput(first.state, 'steer');
  const stale = noteVoiceInput(typed, 'same request');
  assert.equal(stale.maySpeak, false);
  assert.equal(fingerprint('same request'), fingerprint(' same request '));
});

test('mute, retry, and failure preserve microphone preference', () => {
  let state = toggleMute(beginStart(initialState()));
  assert.equal(state.microphoneMuted, true);
  const retry = requestRetry(state);
  assert.equal(retry?.phase, 'stopping');
  state = fail(state, 'helper lost');
  assert.equal(state.phase, 'inactive');
  assert.equal(state.microphoneMuted, true);
  assert.equal(state.failure, 'helper lost');
  assert.equal(beginStop(initialState()).phase, 'inactive');
});

test('transcripts stay within the 1KiB caption budget', () => {
  const state = applyTranscriptDelta(beginStart(initialState()), 'user', 'a'.repeat(5000));
  assert.ok(Buffer.byteLength(state.transcript, 'utf8') <= 1024);
});
