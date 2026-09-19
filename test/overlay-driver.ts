import { getKeybindings, ProcessTerminal, TuiMainScreen, type Component, type TUI } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

export type OverlayScriptState = { overlayKeys: string[]; overlayFrames: string[][] };

export type ScriptedFactory<A> = (tui: TUI, theme: Theme, keybindings: never, done: (value: A) => void) => Component | Promise<Component>;

// SAFETY: scripted overlays only read fg, bold, and name from the Pi theme.
export const passthroughTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text, name: 'dark' } as Theme;

export async function runScriptedCustom<A>(
  factory: ScriptedFactory<A>,
  options: { overlay?: boolean } | undefined,
  state: OverlayScriptState,
): Promise<A> {
  let settled = false;
  let result: A | undefined;
  const done = (value: A) => { settled = true; result = value; };

  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};

  // SAFETY: scripted overlays only pass keybindings through to Pi UI components.
  const keybindings = getKeybindings() as never;
  const component = await factory(tui, passthroughTheme, keybindings, done);
  const capture = () => { state.overlayFrames.push(component.render(80)); };

  capture();

  const feed = () => {
    while (!settled && state.overlayKeys.length && component.handleInput) {
      component.handleInput(state.overlayKeys.shift()!);
      capture();
    }
  };

  feed();

  if (!settled && options?.overlay && component.handleInput) {
    component.handleInput('\x1b');
    capture();
  }

  const started = Date.now();

  while (!settled && !options?.overlay && Date.now() - started < 5000) {
    await new Promise<void>(resolve => setImmediate(resolve));
    feed();
  }

  return result as A;
}
