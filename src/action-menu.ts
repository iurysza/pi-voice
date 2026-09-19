import { Key, matchesKey } from '@earendil-works/pi-tui';
import { OVERLAY_FOOTER, OverlayFrame, isBackKey, isEnterKey, letterKey, type OverlayTheme } from './overlay.ts';

/** Adapted from themed-agents ActionMenu / iurysza/pi-extensions leader-key item rendering. */
export type ActionItem<T> = {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly value: T;
};

export type ActionMenuOptions = {
  readonly subtitle?: string;
  readonly status?: string;
  readonly body?: readonly string[];
  readonly footer?: string;
};

export class ActionMenu<T> {
  focused = false;
  private highlighted = 0;
  constructor(
    private readonly title: string,
    private readonly items: readonly ActionItem<T>[],
    private readonly theme: OverlayTheme,
    private readonly done: (value: T | undefined) => void,
    private readonly options: ActionMenuOptions = {},
  ) {}
  private select(index: number): void {
    const item = this.items[index];
    if (item) this.done(item.value);
  }
  handleInput(data: string): void {
    if (isBackKey(data) || matchesKey(data, Key.backspace)) return this.done(undefined);
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl('k'))) {
      this.highlighted = Math.max(0, this.highlighted - 1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl('j'))) {
      this.highlighted = Math.min(Math.max(0, this.items.length - 1), this.highlighted + 1);
      return;
    }
    if (isEnterKey(data)) return this.select(this.highlighted);
    const letter = letterKey(data);
    if (!letter) return;
    const index = this.items.findIndex(item => item.key === letter);
    if (index >= 0) this.select(index);
  }
  render(width: number): string[] {
    const th = this.theme;
    const frame = new OverlayFrame(width, th);
    const lines = [frame.top(), frame.row(th.fg('accent', th.bold(this.title)))];
    if (this.options.subtitle) lines.push(frame.rowTruncated(th.fg('dim', this.options.subtitle)));
    if (this.options.status) lines.push(frame.rowTruncated(th.fg('warning', this.options.status)));
    lines.push(frame.separator());
    for (const line of this.options.body ?? []) lines.push(frame.rowTruncated(line === '' ? ' ' : line));
    if (this.options.body?.length) lines.push(frame.separator());
    if (!this.items.length) lines.push(frame.row(th.fg('muted', '  (no items)')));
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]!;
      const current = index === this.highlighted;
      const badge = th.fg('warning', th.bold(`[${item.key}]`));
      const label = current ? th.fg('accent', th.bold(item.label)) : th.fg('text', item.label);
      const description = item.description ? `  ${th.fg('dim', item.description)}` : '';
      lines.push(frame.rowTruncated(`${current ? '> ' : '  '}${badge} ${label}${description}`));
    }
    lines.push(frame.separator(), frame.row(th.fg('dim', this.options.footer ?? OVERLAY_FOOTER)), frame.bottom());
    return lines;
  }
  invalidate(): void {}
}
