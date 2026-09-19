import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Effect } from 'effect';
import { commandSampleRate, defaultCaptureCommand, defaultPlaybackCommand, createFakeMedia, acquireSoxMedia, type SoxProcess, type Media, SAMPLE_RATE, resolveCommandBinary } from '../src/media.ts';

test('sox defaults stay locked to 24 kHz pcm16 framing', () => {
  assert.equal(SAMPLE_RATE, 24000);
  assert.deepEqual(defaultCaptureCommand(), ['rec', '-q', '-t', 'raw', '-r', '24000', '-e', 'signed', '-b', '16', '-c', '1', '-']);
  assert.deepEqual(defaultPlaybackCommand(48000), ['play', '-q', '--buffer', '2048', '-t', 'raw', '-r', '48000', '-e', 'signed', '-b', '16', '-c', '1', '-']);
  assert.equal(resolveCommandBinary('definitely-not-a-sox-binary'), undefined);
  assert.equal(commandSampleRate(defaultCaptureCommand()), '24000');
  assert.equal(commandSampleRate(['rec', '--rate', '48000', '-']), '48000');
  assert.equal(commandSampleRate(null), undefined);
});

test('fake media can mute capture and drop queued playback', () => {
  const media = createFakeMedia();
  const frames: Uint8Array[] = [];
  media.onCapture(frame => frames.push(frame));
  media.writePlayback(Buffer.from('one'));
  media.emitCapture(Buffer.from('heard'));
  assert.equal(frames.length, 1);
  media.setCaptureEnabled(false);
  media.emitCapture(Buffer.from('ignored'));
  assert.equal(frames.length, 1);
  media.clearPlayback();
  assert.equal(media.playback.length, 0);
});

class TestProcess implements SoxProcess {
  writes: Buffer[] = [];
  kills = 0;
  readonly stdout = new EventEmitter();
  private readonly exits = new EventEmitter();
  readonly stdin = {
    writable: true,
    write: (buffer: Uint8Array) => { this.writes.push(Buffer.from(buffer));

 return true; },
    end: () => { this.stdin.writable = false; },
  };
  kill(_signal: NodeJS.Signals) { this.kills += 1; this.exits.emit('exit');

 return true; }
  onExit(listener: () => void) { this.exits.once('exit', listener); }
}

async function withMedia(spawn: (command: readonly string[]) => Promise<SoxProcess>, padding: number, check: (media: Media) => Promise<void>) {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const media = yield* acquireSoxMedia({ playbackPaddingMs: padding }, spawn);
    yield* Effect.tryPromise({ try: () => check(media), catch: error => error });
  })));
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('SoX retains every chunk during a delayed player restart and pads only reply boundaries', async () => {
  const capture = new TestProcess();
  const first = new TestProcess();
  const replacement = new TestProcess();
  let release: ((child: SoxProcess) => void) | undefined;
  let calls = 0;
  await withMedia(async () => {
    calls += 1;

    if (calls === 1) return capture;

    if (calls === 2) return first;

    return new Promise(resolve => { release = resolve; });
  }, 150, async media => {
    media.clearPlayback();
    media.writePlayback(Buffer.from([1, 2]));
    media.writePlayback(Buffer.from([3, 4]));
    media.finishPlayback();
    media.finishPlayback(); // Duplicate done events must not add silence twice.
    assert.equal(replacement.writes.length, 0);
    assert.ok(release);
    release(replacement);
    await nextTurn();
    assert.deepEqual(replacement.writes, [Buffer.alloc(7200), Buffer.from([1, 2]), Buffer.from([3, 4]), Buffer.alloc(7200)]);
    assert.equal(replacement.kills, 0); // Completion must not kill queued speech.
  });
  assert.equal(replacement.kills, 1);
  assert.equal(capture.kills, 1);
});

test('repeated interruption discards old queued speech and obsolete players only', async () => {
  const children = [new TestProcess(), new TestProcess(), new TestProcess(), new TestProcess()];
  const [capture, initial, stale, current] = children;
  assert.ok(capture && initial && stale && current);
  const releases: Array<(child: SoxProcess) => void> = [];
  let calls = 0;
  await withMedia(async () => {
    calls += 1;

    if (calls === 1) return capture;

    if (calls === 2) return initial;

    return new Promise(resolve => { releases.push(resolve); });
  }, 0, async media => {
    media.clearPlayback();
    media.writePlayback(Buffer.from('discard me'));
    media.clearPlayback();
    media.writePlayback(Buffer.from('keep me'));
    assert.equal(releases.length, 2);
    releases[0]?.(stale);
    releases[1]?.(current);
    await nextTurn();
    assert.equal(stale.kills, 1);
    assert.equal(stale.writes.length, 0);
    assert.equal(Buffer.concat(current.writes).toString(), 'keep me');
    await media.close();
    media.writePlayback(Buffer.from('after close'));
    media.finishPlayback();
    assert.equal(Buffer.concat(current.writes).toString(), 'keep me');
  });
});

test('restart failures are reported instead of silently dropping audio', async () => {
  let calls = 0;
  await withMedia(async () => {
    if (++calls <= 2) return new TestProcess();
    throw new Error('device unavailable');
  }, 0, async media => {
    const errors: string[] = [];
    media.onError(message => errors.push(message));
    media.clearPlayback();
    await nextTurn();
    assert.deepEqual(errors, ['Voice playback could not restart.']);
  });
});

test('a player that finishes spawning after close is stopped without playback', async () => {
  let calls = 0;
  let release: ((child: SoxProcess) => void) | undefined;
  const late = new TestProcess();
  await withMedia(async () => {
    if (++calls <= 2) return new TestProcess();

    return new Promise(resolve => { release = resolve; });
  }, 0, async media => {
    media.clearPlayback();
    media.writePlayback(Buffer.from('queued'));
    await media.close();
    assert.ok(release);
    release(late);
    await nextTurn();
    assert.equal(late.kills, 1);
    assert.equal(late.writes.length, 0);
  });
});
