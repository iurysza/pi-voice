import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';
import { PI_VERSION } from '../src/domain.ts';

const Versions = Schema.Record(Schema.String, Schema.String);

const Manifest = Schema.Struct({ peerDependencies: Versions, devDependencies: Versions });

const LockEntry = Schema.Struct({ version: Schema.optional(Schema.String), dependencies: Schema.optional(Versions) });

const Lock = Schema.Struct({ packages: Schema.Record(Schema.String, LockEntry) });

const InstalledPackage = Schema.Struct({ version: Schema.String });

const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(fs.readFileSync('package.json', 'utf8')));

const lock = Schema.decodeUnknownSync(Lock)(JSON.parse(fs.readFileSync('package-lock.json', 'utf8')));

function installedVersion(packagePath: string): string {
  const metadata = JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'));

  return Schema.decodeUnknownSync(InstalledPackage)(metadata).version;
}

test('Pi runtime guard, peer pins, development pins, and installed lock entries agree on 1.5.0', () => {
  assert.equal(PI_VERSION, '1.5.0');

  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
    assert.equal(manifest.peerDependencies[name], '1.5.0', `${name} peer pin`);
    assert.equal(manifest.devDependencies[name], '1.5.0', `${name} development pin`);
    const entries = Object.entries(lock.packages).filter(([location]) => location.endsWith(`node_modules/${name}`));

    assert.deepEqual(entries.map(([location, entry]) => [location, entry.version]), [[`node_modules/${name}`, '1.5.0']]);
    assert.equal(installedVersion(`node_modules/${name}`), '1.5.0', `${name} installed version`);
  }
});

test('Pi resolves only Undici 8.12.3, above the alert fixed version 8.12.2', () => {
  assert.equal(lock.packages['node_modules/@earendil-works/pi-coding-agent']?.dependencies?.undici, '8.12.3');
  const entries = Object.entries(lock.packages).filter(([location]) => location.endsWith('node_modules/undici'));

  // An exact independent baseline rejects vulnerable copies, including nested ones.
  assert.deepEqual(entries.map(([location, entry]) => [location, entry.version]), [['node_modules/undici', '8.12.3']]);
  assert.equal(installedVersion('node_modules/undici'), '8.12.3');
});
