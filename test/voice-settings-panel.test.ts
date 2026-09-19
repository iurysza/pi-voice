import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { loadSettings, saveVoicePreferences, type VoicePreferences } from '../src/settings.ts';
import { showVoiceSettings, VOICE_STYLES } from '../src/voice-settings-panel.ts';
import { effectiveLiveInstructions, LIVE_INSTRUCTIONS, storedLiveInstructions, voiceInstructions } from '../src/prompt.ts';
import { runScriptedCustom } from './overlay-driver.ts';

function scratch(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-panel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'settings.json');
}

function prefs(patch: Partial<VoicePreferences> = {}): VoicePreferences {
  return {
    voice: 'cedar',
    liveInstructions: '',
    voiceInstructions: '',
    vadThreshold: 0.7,
    vadSilenceDurationMs: 700,
    interruptResponse: true,
    playbackPaddingMs: 150,
    showBackendMessages: false,
    showStatusLine: true,
    ...patch,
  };
}

function uiWithKeys(overlayKeys: string[], editorValue?: string) {
  const notices: string[] = [];
  const frames: string[][] = [];
  const keys = [...overlayKeys];
  const editorCalls: { title: string; prefill?: string }[] = [];
  return {
    notices,
    overlayKeys: keys,
    overlayFrames: frames,
    editorCalls,
    async custom<A>(factory: Parameters<typeof runScriptedCustom<A>>[0], options?: { overlay?: boolean }) {
      return runScriptedCustom(factory, options, { overlayKeys: keys, overlayFrames: frames });
    },
    async editor(title: string, prefill?: string) {
      editorCalls.push(prefill === undefined ? { title } : { title, prefill });
      return editorValue;
    },
    notify(message: string) { notices.push(message); },
  };
}

test('voice panel saves selected base voice and British gentleman style without changing extra fields', async t => {
  const file = scratch(t);
  fs.writeFileSync(file, JSON.stringify({ vadThreshold: 0.9, futureOption: { keep: true } }));
  const ui = uiWithKeys(['v', 'j', 's', 'b', 'a']);
  await showVoiceSettings(ui, file);
  const loaded = await Effect.runPromise(loadSettings(file));
  assert.equal(loaded.settings.voice, 'cedar');
  assert.match(loaded.settings.voiceInstructions, /British English accent/);
  assert.equal(loaded.settings.vadThreshold, 0.9);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).futureOption, { keep: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(ui.notices.at(-1) ?? '', /saved/);
  assert.ok(ui.overlayFrames.some(frame => frame.join('\n').includes('[v]') && frame.join('\n').includes('Voice settings')));
});

test('cancel after editing performs no writes', async t => {
  const file = scratch(t);
  const original = '{ "voice": "marin", "voiceInstructions": "Soft spoken" }';
  fs.writeFileSync(file, original);
  await showVoiceSettings(uiWithKeys(['v', 'j']), file);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.unlinkSync(file);
  await showVoiceSettings(uiWithKeys([]), file);
  assert.equal(fs.existsSync(file), false);
});

test('custom instructions save and Natural clears them', async t => {
  const file = scratch(t);
  await showVoiceSettings(uiWithKeys(['i', 'a'], '  Gentle Scottish accent  '), file);
  assert.equal((await Effect.runPromise(loadSettings(file))).settings.voiceInstructions, 'Gentle Scottish accent');
  await showVoiceSettings(uiWithKeys(['s', 'n', 'a']), file);
  assert.equal((await Effect.runPromise(loadSettings(file))).settings.voiceInstructions, '');
});

test('cancelled custom editor retains the existing style', async t => {
  const file = scratch(t);
  fs.writeFileSync(file, JSON.stringify({ voiceInstructions: 'Original style' }));
  await showVoiceSettings(uiWithKeys(['s', 'u', 'a']), file);
  assert.equal((await Effect.runPromise(loadSettings(file))).settings.voiceInstructions, 'Original style');
});

test('audio toggles and custom pause persist with other file keys', async t => {
  const file = scratch(t);
  fs.writeFileSync(file, JSON.stringify({ captureCommand: ['rec', '-'] }));
  const ui = uiWithKeys(['b', 'r', 'p', 's', 'a']);
  await showVoiceSettings(ui, file);
  const loaded = await Effect.runPromise(loadSettings(file));
  assert.equal(loaded.settings.interruptResponse, false);
  assert.equal(loaded.settings.showBackendMessages, true);
  assert.equal(loaded.settings.vadSilenceDurationMs, 1000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).captureCommand, ['rec', '-']);
});

test('malformed, credential-bearing and linked settings remain untouched', async t => {
  const file = scratch(t);
  for (const original of ['{broken', '[]', 'null', '{"apiKey":"placeholder"}']) {
    fs.writeFileSync(file, original);
    await assert.rejects(Effect.runPromise(saveVoicePreferences(prefs(), file)));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
  const target = file + '.target';
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  await assert.rejects(Effect.runPromise(saveVoicePreferences(prefs(), file)));
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"apiKey":"placeholder"}');
});

test('style changes delivery without replacing tool and handoff instructions', () => {
  assert.equal(voiceInstructions(''), LIVE_INSTRUCTIONS);
  assert.equal(voiceInstructions('  '), LIVE_INSTRUCTIONS);
  for (const preset of VOICE_STYLES) {
    const prompt = voiceInstructions(preset.instructions);
    assert.ok(prompt.startsWith(LIVE_INSTRUCTIONS));
    assert.ok(prompt.includes(preset.instructions));
    assert.match(prompt, /delegate_to_pi/);
  }
});

test('custom base replaces compiled prompt, empty storage falls back, and style still suffixes', () => {
  assert.equal(effectiveLiveInstructions(''), LIVE_INSTRUCTIONS);
  assert.equal(effectiveLiveInstructions('  Always delegate file work.  '), 'Always delegate file work.');
  assert.equal(storedLiveInstructions(''), '');
  assert.equal(storedLiveInstructions(`  ${LIVE_INSTRUCTIONS}  `), '');
  assert.equal(storedLiveInstructions('Always delegate file work.'), 'Always delegate file work.');
  const composed = voiceInstructions('Keep it brief.', 'Always delegate file work.');
  assert.equal(composed, 'Always delegate file work.\nSpeaking style, without changing the task or tool rules above:\nKeep it brief.');
  assert.equal(composed.includes('delegate_to_pi'), false);
  assert.equal(voiceInstructions('Keep it brief.', ''), `${LIVE_INSTRUCTIONS}\nSpeaking style, without changing the task or tool rules above:\nKeep it brief.`);
});

test('custom base prompt saves, empty or compiled default stores empty, and style stays attached', async t => {
  const file = scratch(t);
  fs.writeFileSync(file, JSON.stringify({ voiceInstructions: 'Keep it brief.', futureOption: { keep: true } }));
  const customUi = uiWithKeys(['o', 'a'], '  Always delegate file work. Never mention Pi.  ');
  await showVoiceSettings(customUi, file);
  assert.equal(customUi.editorCalls[0]?.prefill, LIVE_INSTRUCTIONS);
  const custom = await Effect.runPromise(loadSettings(file));
  assert.equal(custom.settings.liveInstructions, 'Always delegate file work. Never mention Pi.');
  assert.equal(custom.settings.voiceInstructions, 'Keep it brief.');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).futureOption, { keep: true });
  assert.ok(voiceInstructions(custom.settings.voiceInstructions, custom.settings.liveInstructions).startsWith('Always delegate file work. Never mention Pi.'));
  assert.match(voiceInstructions(custom.settings.voiceInstructions, custom.settings.liveInstructions), /Keep it brief/);
  const compiledUi = uiWithKeys(['o', 'a'], `  ${LIVE_INSTRUCTIONS}  `);
  await showVoiceSettings(compiledUi, file);
  assert.equal(compiledUi.editorCalls[0]?.prefill, 'Always delegate file work. Never mention Pi.');
  assert.equal((await Effect.runPromise(loadSettings(file))).settings.liveInstructions, '');
  await showVoiceSettings(uiWithKeys(['o', 'a'], '  Always delegate file work. Never mention Pi.  '), file);
  await showVoiceSettings(uiWithKeys(['o', 'a'], '   '), file);
  const restored = await Effect.runPromise(loadSettings(file));
  assert.equal(restored.settings.liveInstructions, '');
  assert.equal(restored.settings.voiceInstructions, 'Keep it brief.');
  assert.equal(voiceInstructions(restored.settings.voiceInstructions, restored.settings.liveInstructions), `${LIVE_INSTRUCTIONS}\nSpeaking style, without changing the task or tool rules above:\nKeep it brief.`);
});

test('cancelled base-prompt editor retains the existing prompt', async t => {
  const file = scratch(t);
  fs.writeFileSync(file, JSON.stringify({ liveInstructions: 'Original prompt' }));
  await showVoiceSettings(uiWithKeys(['o', 'a']), file);
  assert.equal((await Effect.runPromise(loadSettings(file))).settings.liveInstructions, 'Original prompt');
});

test('status line toggle saves without asking to restart', async t => {
  const file = scratch(t);
  const ui = uiWithKeys(['l', 'a']);
  const result = await showVoiceSettings(ui, file, { sessionLive: true });
  assert.equal(result.saved, true);
  assert.equal(result.restart, false);
  assert.equal((await Effect.runPromise(loadSettings(file))).settings.showStatusLine, false);
  assert.equal(ui.overlayFrames.some(frame => frame.join('\n').includes('Restart Voice?')), false);
  assert.equal(ui.notices.at(-1), 'Voice preferences saved.');
});

test('live session field changes confirm before save and can keep editing', async t => {
  const file = scratch(t);
  fs.writeFileSync(file, JSON.stringify({ voice: 'marin' }));
  const cancelled = uiWithKeys(['v', 'j', 'a', 'k']);
  const cancelledResult = await showVoiceSettings(cancelled, file, { sessionLive: true });
  assert.equal(cancelledResult.saved, false);
  assert.equal(cancelledResult.restart, false);
  assert.equal((await Effect.runPromise(loadSettings(file))).settings.voice, 'marin');
  assert.ok(cancelled.overlayFrames.some(frame => frame.join('\n').includes('Restart Voice?')));
  const saved = uiWithKeys(['v', 'j', 'a', 'r']);
  const result = await showVoiceSettings(saved, file, { sessionLive: true });
  assert.equal(result.saved, true);
  assert.equal(result.restart, true);
  assert.equal((await Effect.runPromise(loadSettings(file))).settings.voice, 'cedar');
  assert.equal(saved.notices.at(-1), 'Voice preferences saved. Restarting.');
});
