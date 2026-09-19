import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect, Option } from 'effect';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, parseBoundedNumber, settingsDiagnostics, VadSilence, VadThreshold } from '../src/settings.ts';
import { LIVE_INSTRUCTIONS } from '../src/prompt.ts';

test('missing settings files use defaults and never invent API keys', async () => {
  const missing = path.join(os.tmpdir(), `pi-voice-missing-${process.pid}.json`);
  const loaded = await Effect.runPromise(loadSettings(missing));
  assert.equal(loaded.loaded, false);
  assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
  assert.equal('apiKey' in loaded.settings, false);
});

test('malformed and valid files stay key-free', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-voice-settings-'));
  try {
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, '{');
    const failed = await Effect.runPromise(loadSettings(bad));
    assert.equal(failed.loaded, false);
    assert.match(failed.diagnostics[0] ?? '', /Failed to read voice settings/);
    const good = path.join(root, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ model: 'gpt-realtime', voice: 'marin', apiKey: 'secret-must-drop' }));
    const loaded = await Effect.runPromise(loadSettings(good));
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.settings.voice, 'marin');
    assert.equal('apiKey' in loaded.settings, false);
    assert.deepEqual(normalizeSettings({ sampleRate: 0, model: '  ' }), DEFAULT_SETTINGS);
    assert.equal(normalizeSettings({ voice: 'cove', sampleRate: 48000, wsUrl: 'http://example.com' }).voice, 'marin');
    assert.equal(normalizeSettings({ voice: 'cove', sampleRate: 48000, wsUrl: 'http://example.com' }).sampleRate, 24000);
    assert.equal(normalizeSettings({ voice: 'cove', sampleRate: 48000, wsUrl: 'http://example.com' }).wsUrl, 'wss://api.openai.com/v1/realtime');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('canonicalize reports why cove, sampleRate, and bad websocket URLs were ignored', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-voice-settings-'));
  try {
    const file = path.join(root, 'odd.json');
    fs.writeFileSync(file, JSON.stringify({ voice: 'cove', sampleRate: 16000, wsUrl: 'https://evil.example/v1' }));
    const loaded = await Effect.runPromise(loadSettings(file));
    assert.equal(loaded.settings.voice, 'marin');
    assert.equal(loaded.settings.sampleRate, 24000);
    assert.ok(loaded.diagnostics.some(line => /cove/.test(line)));
    assert.ok(loaded.diagnostics.some(line => /24 kHz/.test(line)));
    assert.ok(loaded.diagnostics.some(line => /wss:\/\//.test(line)));
    const hijack = path.join(root, 'hijack.json');
    fs.writeFileSync(hijack, JSON.stringify({ wsUrl: 'wss://evil.example/v1/realtime' }));
    const hijacked = await Effect.runPromise(loadSettings(hijack));
    assert.equal(hijacked.settings.wsUrl, 'wss://api.openai.com/v1/realtime');
    assert.ok(hijacked.diagnostics.some(line => /evil.example/.test(line)));
    const custom = path.join(root, 'custom.json');
    fs.writeFileSync(custom, JSON.stringify({ captureCommand: ['rec', '-r', '48000', '-'] }));
    const customRate = await Effect.runPromise(loadSettings(custom));
    assert.ok(customRate.diagnostics.some(line => /48000/.test(line)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('audio controls retain valid values and reject invalid fields independently', () => {
  const valid = normalizeSettings({ voice: 'cedar', vadThreshold: 0.85, vadSilenceDurationMs: 1000, interruptResponse: false, playbackPaddingMs: 0 });
  assert.equal(valid.vadThreshold, 0.85);
  assert.equal(valid.vadSilenceDurationMs, 1000);
  assert.equal(valid.interruptResponse, false);
  assert.equal(valid.playbackPaddingMs, 0);
  const bad = { voice: 'cedar', vadThreshold: 1.1, vadSilenceDurationMs: 0, interruptResponse: 'false', playbackPaddingMs: -1 };
  const fallback = normalizeSettings(bad);
  assert.equal(fallback.voice, 'cedar');
  assert.equal(fallback.vadThreshold, DEFAULT_SETTINGS.vadThreshold);
  assert.equal(fallback.vadSilenceDurationMs, DEFAULT_SETTINGS.vadSilenceDurationMs);
  assert.equal(fallback.interruptResponse, true);
  assert.equal(fallback.playbackPaddingMs, DEFAULT_SETTINGS.playbackPaddingMs);
  assert.equal(settingsDiagnostics(bad).length, 4);
  for (const vadThreshold of [NaN, Infinity, -0.1, '0.7', null]) {
    assert.equal(normalizeSettings({ vadThreshold }).vadThreshold, DEFAULT_SETTINGS.vadThreshold);
  }
});

test('empty liveInstructions uses the compiled prompt; copies of the default store as empty', () => {
  assert.equal(normalizeSettings({}).liveInstructions, '');
  assert.equal(normalizeSettings({ liveInstructions: '  Talk like a radio host.  ' }).liveInstructions, 'Talk like a radio host.');
  assert.equal(normalizeSettings({ liveInstructions: LIVE_INSTRUCTIONS }).liveInstructions, '');
  assert.equal(normalizeSettings({ liveInstructions: `  ${LIVE_INSTRUCTIONS}  ` }).liveInstructions, '');
});

test('showBackendMessages is opt-in and invalid values fall back independently', () => {
  assert.equal(normalizeSettings({}).showBackendMessages, false);
  assert.equal(normalizeSettings({ showBackendMessages: true }).showBackendMessages, true);
  assert.equal(normalizeSettings({ showBackendMessages: 'yes' }).showBackendMessages, false);
  assert.ok(settingsDiagnostics({ showBackendMessages: 'yes' }).some(line => /showBackendMessages/.test(line)));
  assert.equal(normalizeSettings({}).showStatusLine, true);
  assert.equal(normalizeSettings({ showStatusLine: false }).showStatusLine, false);
  assert.equal(normalizeSettings({ showStatusLine: 'no' }).showStatusLine, true);
  assert.ok(settingsDiagnostics({ showStatusLine: 'no' }).some(line => /showStatusLine/.test(line)));
  assert.ok(Option.isSome(parseBoundedNumber('0.85', VadThreshold)));
  assert.ok(Option.isNone(parseBoundedNumber('', VadThreshold)));
  assert.ok(Option.isNone(parseBoundedNumber('1.2', VadThreshold)));
  assert.ok(Option.isSome(parseBoundedNumber('700', VadSilence)));
  assert.ok(Option.isNone(parseBoundedNumber('700.5', VadSilence)));
});
