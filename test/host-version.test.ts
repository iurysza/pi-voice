import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRunningPiVersion } from '../src/host-version.ts';

test('running Pi version does not come from this package nested copy', () => {
  assert.throws(
    () => resolveRunningPiVersion(fileURLToPath(import.meta.url)),
    /nested Pi copy|Could not resolve/,
  );
  assert.throws(
    () => resolveRunningPiVersion(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/host-version.ts')),
    /nested Pi copy|Could not resolve/,
  );
});

function installPiCliLayout(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-voice-host-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'bin', 'pi');
  const manifest = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '');
  fs.writeFileSync(manifest, JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.85.1' }));

  return binary;
}

test('running Pi version resolves from the CLI package layout', t => {
  assert.equal(resolveRunningPiVersion(installPiCliLayout(t)), '0.85.1');
});
