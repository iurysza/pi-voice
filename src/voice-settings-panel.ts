import { Effect, Option } from 'effect';
import { ActionMenu, type ActionItem } from './action-menu.ts';
import { OVERLAY_FOOTER, PromptOverlay, presentOverlay, type OverlayUi } from './overlay.ts';
import {
  DEFAULT_REALTIME_VOICE,
  DEFAULT_SETTINGS_PATH,
  PlaybackPadding,
  REALTIME_VOICES,
  VadSilence,
  VadThreshold,
  loadSettings,
  parseBoundedNumber,
  saveVoicePreferences,
  type VoiceSettings,
} from './settings.ts';
import { effectiveLiveInstructions, storedLiveInstructions } from './prompt.ts';

export const VOICE_STYLES = [
  { label: 'Natural', instructions: '' },
  { label: 'British older gentleman', instructions: 'Use a British English accent and the delivery of an older gentleman: warm, measured, articulate, and understated. Keep replies concise. Avoid exaggerated mannerisms and do not claim a real age or identity.' },
  { label: 'Warm conversational', instructions: 'Use a warm, relaxed conversational delivery with natural intonation. Keep replies concise.' },
  { label: 'Calm and concise', instructions: 'Use a calm, even delivery and a measured pace. Be brief and direct, without filler.' },
] as const;

type SettingsUi = OverlayUi & {
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
};

type PanelAction = 'voice' | 'style' | 'instructions' | 'prompt' | 'threshold' | 'silence' | 'interrupt' | 'padding' | 'backend' | 'statusLine' | 'save';

export type VoiceSettingsResult = {
  readonly saved: boolean;
  readonly restart: boolean;
};

export type VoiceSettingsOptions = {
  readonly sessionLive?: boolean;
};

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function onOff(value: boolean): string {
  return value ? 'On' : 'Off';
}

function styleLabel(instructions: string): string {
  return VOICE_STYLES.find(preset => preset.instructions === instructions)?.label ?? 'Custom';
}

function promptLabel(instructions: string): string {
  return storedLiveInstructions(instructions) ? 'Custom' : 'Default';
}

function menu<T>(ui: SettingsUi, title: string, items: readonly ActionItem<T>[], options?: { subtitle?: string; footer?: string }): Promise<T | undefined> {
  return presentOverlay(ui, (theme, done) => new ActionMenu(title, items, theme, done, { footer: OVERLAY_FOOTER, ...options }));
}

function prompt(ui: SettingsUi, title: string, initial: string, subtitle?: string): Promise<string | undefined> {
  return presentOverlay(ui, (theme, done) => new PromptOverlay(title, initial, theme, done, subtitle));
}

const THRESHOLDS = [
  { key: 'a', label: '0.50', value: 0.5, description: 'more ambient sound counts as speech' },
  { key: 'd', label: '0.70', value: 0.7, description: 'default' },
  { key: 'q', label: '0.90', value: 0.9, description: 'only louder speech' },
] as const;

const PAUSES = [
  { key: 'f', label: '400 ms', value: 400, description: 'end the turn sooner' },
  { key: 'd', label: '700 ms', value: 700, description: 'default' },
  { key: 's', label: '1000 ms', value: 1000, description: 'wait longer before replying' },
] as const;

const PADDINGS = [
  { key: 'z', label: '0 ms', value: 0, description: 'no extra silence' },
  { key: 'd', label: '150 ms', value: 150, description: 'default' },
  { key: 'm', label: '300 ms', value: 300, description: 'more space around replies' },
] as const;

async function pickNumber(
  ui: SettingsUi,
  title: string,
  subtitle: string,
  current: number,
  presets: readonly { key: string; label: string; value: number; description: string }[],
  schema: typeof VadThreshold | typeof VadSilence | typeof PlaybackPadding,
  format: (value: number) => string,
): Promise<number | undefined> {
  const selected = await menu(ui, title, [
    ...presets.map(preset => ({
      key: preset.key,
      label: preset.value === current ? `${preset.label} (current)` : preset.label,
      description: preset.description,
      value: String(preset.value),
    })),
    { key: 'c', label: 'Custom', description: format(current), value: 'custom' },
  ], { subtitle });

  if (selected === undefined) return undefined;

  if (selected !== 'custom') return Number(selected);
  const edited = await prompt(ui, title, String(current), subtitle);

  if (edited === undefined) return undefined;
  const parsed = parseBoundedNumber(edited, schema);

  if (Option.isNone(parsed)) {
    ui.notify(`Enter a value in range. Keeping ${format(current)}.`, 'warning');

    return undefined;
  }

  return parsed.value;
}

type Draft = {
  voice: typeof REALTIME_VOICES[number];
  liveInstructions: string;
  voiceInstructions: string;
  vadThreshold: number;
  vadSilenceDurationMs: number;
  interruptResponse: boolean;
  playbackPaddingMs: number;
  showBackendMessages: boolean;
  showStatusLine: boolean;
};

function draftFrom(settings: VoiceSettings): Draft {
  const voice = REALTIME_VOICES.find(value => value === settings.voice) ?? DEFAULT_REALTIME_VOICE;

  return {
    voice,
    liveInstructions: storedLiveInstructions(settings.liveInstructions),
    voiceInstructions: settings.voiceInstructions,
    vadThreshold: settings.vadThreshold,
    vadSilenceDurationMs: settings.vadSilenceDurationMs,
    interruptResponse: settings.interruptResponse,
    playbackPaddingMs: settings.playbackPaddingMs,
    showBackendMessages: settings.showBackendMessages,
    showStatusLine: settings.showStatusLine,
  };
}

function sessionFieldsChanged(draft: Draft, original: Draft): boolean {
  return draft.voice !== original.voice
    || draft.liveInstructions !== original.liveInstructions
    || draft.voiceInstructions !== original.voiceInstructions
    || draft.vadThreshold !== original.vadThreshold
    || draft.vadSilenceDurationMs !== original.vadSilenceDurationMs
    || draft.interruptResponse !== original.interruptResponse
    || draft.playbackPaddingMs !== original.playbackPaddingMs;
}

function savedNotice(sessionLive: boolean, restart: boolean): string {
  if (restart) return 'Voice preferences saved. Restarting.';

  if (sessionLive) return 'Voice preferences saved.';

  return 'Voice preferences saved. Start /voice to hear the changes.';
}

async function confirmRestart(ui: SettingsUi): Promise<boolean> {
  const choice = await menu<'restart' | 'keep'>(ui, 'Restart Voice?', [
    { key: 'r', label: 'Restart now', description: 'end this session and apply the new settings', value: 'restart' },
    { key: 'k', label: 'Keep editing', description: 'leave the session running', value: 'keep' },
  ], { subtitle: 'These settings take effect only after Voice restarts' });

  return choice === 'restart';
}

export async function showVoiceSettings(
  ui: SettingsUi,
  path = DEFAULT_SETTINGS_PATH,
  options: VoiceSettingsOptions = {},
): Promise<VoiceSettingsResult> {
  const sessionLive = options.sessionLive === true;
  const loaded = await Effect.runPromise(loadSettings(path));

  for (const diagnostic of loaded.diagnostics) ui.notify(diagnostic, 'warning');
  const draft = draftFrom(loaded.settings);
  const original = { ...draft };

  for (;;) {
    const action = await menu<PanelAction>(ui, 'Voice settings', [
      { key: 'v', label: 'Voice', description: titleCase(draft.voice), value: 'voice' },
      { key: 's', label: 'Speaking style', description: styleLabel(draft.voiceInstructions), value: 'style' },
      { key: 'i', label: 'Custom instructions', description: draft.voiceInstructions ? 'Edit…' : '', value: 'instructions' },
      { key: 'o', label: 'Base prompt', description: promptLabel(draft.liveInstructions), value: 'prompt' },
      { key: 'h', label: 'Speech threshold', description: draft.vadThreshold.toFixed(2), value: 'threshold' },
      { key: 'p', label: 'Pause before replying', description: `${draft.vadSilenceDurationMs} ms`, value: 'silence' },
      { key: 'b', label: 'Allow interruptions', description: onOff(draft.interruptResponse), value: 'interrupt' },
      { key: 'd', label: 'Playback padding', description: `${draft.playbackPaddingMs} ms`, value: 'padding' },
      { key: 'r', label: 'Show Pi → voice messages', description: onOff(draft.showBackendMessages), value: 'backend' },
      { key: 'l', label: 'Show status line', description: onOff(draft.showStatusLine), value: 'statusLine' },
      { key: 'a', label: 'Save changes', value: 'save' },
    ], { subtitle: sessionLive ? 'Session changes restart a live session' : 'Changes apply to your next voice session' });

    if (action === undefined) return { saved: false, restart: false };

    if (action === 'interrupt') {
      draft.interruptResponse = !draft.interruptResponse;
      continue;
    }

    if (action === 'backend') {
      draft.showBackendMessages = !draft.showBackendMessages;
      continue;
    }

    if (action === 'statusLine') {
      draft.showStatusLine = !draft.showStatusLine;
      continue;
    }

    if (action === 'voice') {
      const picked = await menu(ui, 'Voice › Base voice', REALTIME_VOICES.map((voice, index) => ({
        key: String.fromCharCode(97 + index),
        label: titleCase(voice),
        description: voice === draft.voice ? 'current' : '',
        value: voice,
      })), { subtitle: 'Accent and age are guidance, not guarantees' });

      if (picked) draft.voice = picked;
      continue;
    }

    if (action === 'style') {
      const picked = await menu(ui, 'Voice › Speaking style', [
        ...VOICE_STYLES.map((preset, index) => ({
          key: ['n', 'b', 'w', 'c'][index]!,
          label: preset.label,
          description: preset.instructions === draft.voiceInstructions ? 'current' : '',
          value: preset.label,
        })),
        { key: 'u', label: 'Custom', description: styleLabel(draft.voiceInstructions) === 'Custom' ? 'current' : '', value: 'Custom' },
      ], { subtitle: 'Accent and age are guidance, not guarantees' });

      if (picked === undefined) continue;

      if (picked === 'Custom') {
        const edited = await ui.editor('Speaking style instructions', draft.voiceInstructions);

        if (edited !== undefined) draft.voiceInstructions = edited.trim();
      } else {
        const preset = VOICE_STYLES.find(value => value.label === picked);

        if (preset) draft.voiceInstructions = preset.instructions;
      }

      continue;
    }

    if (action === 'instructions') {
      const edited = await ui.editor('Speaking style instructions', draft.voiceInstructions);

      if (edited !== undefined) draft.voiceInstructions = edited.trim();
      continue;
    }

    if (action === 'prompt') {
      const edited = await ui.editor('Live-model prompt', effectiveLiveInstructions(draft.liveInstructions));

      if (edited !== undefined) draft.liveInstructions = storedLiveInstructions(edited);
      continue;
    }

    if (action === 'threshold') {
      const next = await pickNumber(ui, 'Voice › Speech threshold', '0 to 1. Higher values require louder speech.', draft.vadThreshold, THRESHOLDS, VadThreshold, value => value.toFixed(2));

      if (next !== undefined) draft.vadThreshold = next;
      continue;
    }

    if (action === 'silence') {
      const next = await pickNumber(ui, 'Voice › Pause before replying', '1 to 2000 ms of silence before the turn ends.', draft.vadSilenceDurationMs, PAUSES, VadSilence, value => `${value} ms`);

      if (next !== undefined) draft.vadSilenceDurationMs = next;
      continue;
    }

    if (action === 'padding') {
      const next = await pickNumber(ui, 'Voice › Playback padding', '0 to 2000 ms of silence around replies.', draft.playbackPaddingMs, PADDINGS, PlaybackPadding, value => `${value} ms`);

      if (next !== undefined) draft.playbackPaddingMs = next;
      continue;
    }

    const restart = sessionLive && sessionFieldsChanged(draft, original);

    if (restart && !await confirmRestart(ui)) continue;

    try {
      await Effect.runPromise(saveVoicePreferences(draft, path));
      ui.notify(savedNotice(sessionLive, restart), 'info');

      return { saved: true, restart };
    } catch {
      ui.notify('Voice preferences were not saved. Check the settings file for invalid JSON, credentials, or permission problems.', 'error');

      return { saved: false, restart: false };
    }
  }
}
