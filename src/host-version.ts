import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema, Option } from 'effect';
import { VoiceError, requireValue } from './domain.ts';

function packageRoot(start: string): string {
  let current = start;
  while (true) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest)) {
      const name = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }))(JSON.parse(fs.readFileSync(manifest, 'utf8')));
      if (Option.isSome(name) && name.value.name === '@iurysza/pi-voice') return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new VoiceError({ code: 'pi-version', message: 'Could not resolve the Pi Voice package root.' });
    current = parent;
  }
}

function nestedVoiceCopy(pkgPath: string): boolean {
  const root = packageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const nested = path.join(root, 'node_modules') + path.sep;
  return pkgPath.startsWith(nested) || pkgPath.includes(`${path.sep}packages${path.sep}pi-voice${path.sep}node_modules${path.sep}`);
}

function readPiManifest(pkgPath: string): string | undefined {
  const parsed = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.optionalKey(Schema.String), version: Schema.String }))(JSON.parse(fs.readFileSync(pkgPath, 'utf8')));
  if (Option.isNone(parsed) || parsed.value.name !== '@earendil-works/pi-coding-agent') return undefined;
  requireValue(!nestedVoiceCopy(pkgPath), 'Pi Voice resolved its own nested Pi copy instead of the running CLI.', 'pi-version');
  return parsed.value.version;
}

export function resolveRunningPiVersion(from = process.argv[1]): string {
  requireValue(from, 'Could not resolve the running Pi binary.', 'pi-version');
  let current = path.dirname(fs.existsSync(from) ? fs.realpathSync(path.resolve(from)) : path.resolve(from));
  while (true) {
    const self = path.join(current, 'package.json');
    if (fs.existsSync(self)) {
      const version = readPiManifest(self);
      if (version) return version;
    }
    const nested = path.join(current, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
    if (fs.existsSync(nested)) {
      const version = readPiManifest(nested);
      if (version) return version;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new VoiceError({ code: 'pi-version', message: 'Could not resolve the running Pi version from the CLI path.' });
    current = parent;
  }
}
