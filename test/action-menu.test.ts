import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionMenu } from '../src/action-menu.ts';
import { OVERLAY_FOOTER } from '../src/overlay.ts';

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

const CTRL_J = '\n';

const CTRL_K = '\v';

test('action menu letter shortcuts select immediately and Escape closes', () => {
  let selected: string | undefined = 'pending';

  const menu = new ActionMenu('Voice', [
    { key: 's', label: 'Start', value: 'start' },
    { key: 't', label: 'Settings', value: 'settings' },
  ], theme, value => { selected = value; });

  assert.match(menu.render(80).join('\n'), /\[s\].*Start/);
  assert.ok(menu.render(80).join('\n').includes(OVERLAY_FOOTER));
  menu.handleInput('t');
  assert.equal(selected, 'settings');
  selected = 'pending';
  const closed = new ActionMenu('Voice', [{ key: 's', label: 'Start', value: 'start' }], theme, value => { selected = value; });
  closed.handleInput('\x1b');
  assert.equal(selected, undefined);
});

test('Ctrl+J/K and arrows move then Enter selects', () => {
  let selected: string | undefined = 'pending';

  const menu = new ActionMenu('Voice', [
    { key: 's', label: 'Start', value: 'start' },
    { key: 't', label: 'Settings', value: 'settings' },
    { key: 'x', label: 'Stop', value: 'stop' },
  ], theme, value => { selected = value; });

  menu.handleInput(CTRL_J);
  menu.handleInput(CTRL_J);
  menu.handleInput(CTRL_K);
  menu.handleInput('\r');
  assert.equal(selected, 'settings');
  selected = 'pending';

  const arrows = new ActionMenu('Voice', [
    { key: 's', label: 'Start', value: 'start' },
    { key: 't', label: 'Settings', value: 'settings' },
  ], theme, value => { selected = value; });

  arrows.handleInput('\x1b[B');
  arrows.handleInput('\x1b[A');
  arrows.handleInput('\r');
  assert.equal(selected, 'start');
});
