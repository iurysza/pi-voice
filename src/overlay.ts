import type { Theme } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { withHerdrNavigationPassthrough } from './herdr-navigation.ts';

/** Copied from themed-agents overlay.ts / iurysza/pi-extensions leader-key shared overlay. */
export type OverlayTheme = Pick<Theme, 'fg' | 'bold'>;

export type OverlayComponent = {
  focused?: boolean;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
};

export type OverlayUi = {
  custom<A>(
    factory: (
      tui: { requestRender(): void },
      theme: Theme,
      keybindings: unknown,
      done: (value: A) => void,
    ) => OverlayComponent | Promise<OverlayComponent>,
    options?: unknown,
  ): Promise<A>;
};

export const VOICE_OVERLAY = { overlay: true, overlayOptions: { anchor: 'center' as const, width: 80, minWidth: 50, maxHeight: '80%' as const } };

export const OVERLAY_FOOTER = 'Press a key · ↑↓ or Ctrl+J/K · Enter select · Esc close';

export function padToWidth(text: string, length: number): string {
  return text + ' '.repeat(Math.max(0, length - visibleWidth(text)));
}

export class OverlayFrame {
  readonly width: number;
  readonly innerWidth: number;
  private readonly hLine: string;
  constructor(terminalWidth: number, private readonly theme: OverlayTheme, maxWidth = 80) {
    this.width = Math.max(8, Math.min(terminalWidth, maxWidth));
    this.innerWidth = Math.max(1, this.width - 4);
    this.hLine = '─'.repeat(this.width - 2);
  }
  top(): string { return this.theme.fg('border', `╭${this.hLine}╮`); }
  separator(): string { return this.theme.fg('border', `├${this.hLine}┤`); }
  bottom(): string { return this.theme.fg('border', `╰${this.hLine}╯`); }
  row(content: string): string { return this.theme.fg('border', '│') + ' ' + padToWidth(content, this.innerWidth) + ' ' + this.theme.fg('border', '│'); }
  rowTruncated(content: string): string { return this.row(truncateToWidth(content, this.innerWidth)); }
}

export function isCancelKey(data: string): boolean {
  return matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'));
}

export function isBackKey(data: string): boolean {
  return isCancelKey(data) || matchesKey(data, Key.ctrl('h'));
}

export function isEnterKey(data: string): boolean {
  return matchesKey(data, Key.enter) || matchesKey(data, Key.return) || matchesKey(data, Key.ctrl('m'));
}

export function letterKey(data: string): string | undefined {
  if (data.length === 1 && data >= 'A' && data <= 'Z') return data.toLowerCase();
  if (data.length === 1 && data >= 'a' && data <= 'z') return data;
  return undefined;
}

export function presentOverlay<A>(ui: OverlayUi, create: (theme: OverlayTheme, done: (value: A | undefined) => void) => OverlayComponent): Promise<A | undefined> {
  return withHerdrNavigationPassthrough(() => ui.custom<A | undefined>((tui, theme, _keys, done) => {
    const overlay = create(theme, done);
    return {
      get focused() { return overlay.focused ?? false; },
      set focused(value: boolean) { overlay.focused = value; },
      render: width => overlay.render(width),
      invalidate: () => overlay.invalidate(),
      handleInput: data => { overlay.handleInput(data); tui.requestRender(); },
    };
  }, VOICE_OVERLAY));
}

export class PromptOverlay implements OverlayComponent {
  private readonly input: Input;
  private _focused = false;
  constructor(
    private readonly title: string,
    initial: string,
    private readonly theme: OverlayTheme,
    private readonly done: (value: string | undefined) => void,
    private readonly subtitle?: string,
  ) {
    this.input = new Input({ prompt: '' });
    this.input.setValue(initial);
    this.input.onSubmit = value => this.done(value);
    this.input.onEscape = () => this.done(undefined);
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }
  handleInput(data: string): void {
    if (isBackKey(data)) return this.done(undefined);
    this.input.handleInput(data);
  }
  render(width: number): string[] {
    const th = this.theme;
    const frame = new OverlayFrame(width, th);
    const lines = [frame.top(), frame.row(th.fg('accent', th.bold(this.title)))];
    if (this.subtitle) lines.push(frame.rowTruncated(th.fg('dim', this.subtitle)));
    lines.push(frame.separator());
    const typed = this.input.render(frame.innerWidth)[0] ?? '';
    lines.push(frame.row(typed));
    lines.push(frame.separator(), frame.row(th.fg('dim', 'Enter confirm · Esc back')), frame.bottom());
    return lines;
  }
  invalidate(): void { this.input.invalidate(); }
}
