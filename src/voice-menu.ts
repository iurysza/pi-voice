import { ActionMenu } from './action-menu.ts';
import { OVERLAY_FOOTER, presentOverlay, type OverlayUi } from './overlay.ts';

export type VoiceCommand = 'start' | 'stop' | 'mute' | 'settings';

export type VoiceMenuState = {
  readonly active: boolean;
  readonly muted: boolean;
  readonly status?: string;
};

export async function showVoiceMenu(ui: OverlayUi, state: VoiceMenuState): Promise<VoiceCommand | undefined> {
  const items = state.active
    ? [
        { key: 'x', label: 'Stop', description: state.status ?? 'listening', value: 'stop' as const },
        { key: 'm', label: state.muted ? 'Unmute' : 'Mute', description: state.muted ? 'microphone off' : 'microphone on', value: 'mute' as const },
        { key: 't', label: 'Settings', description: 'voice, style, and audio', value: 'settings' as const },
      ]
    : [
        { key: 's', label: 'Start', description: 'listen and speak', value: 'start' as const },
        { key: 't', label: 'Settings', description: 'voice, style, and audio', value: 'settings' as const },
      ];
  return presentOverlay(ui, (theme, done) => new ActionMenu('Voice', items, theme, done, {
    subtitle: state.status ?? 'Inactive',
    footer: OVERLAY_FOOTER,
  }));
}
