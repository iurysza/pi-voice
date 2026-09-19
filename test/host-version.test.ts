import test from 'node:test';
import assert from 'node:assert/strict';
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
