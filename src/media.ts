import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Effect } from 'effect';
import { VoiceError, atomic, requireValue } from './domain.ts';

export const SAMPLE_RATE = 24000;

export const FRAME_BYTES = 4800 * 2;

export interface Media {
  readonly kind: 'fake' | 'sox';
  readonly onCapture: (listener: (frame: Uint8Array) => void) => () => void;
  readonly onError: (listener: (message: string) => void) => () => void;
  readonly writePlayback: (buffer: Uint8Array) => void;
  readonly setCaptureEnabled: (enabled: boolean) => void;
  readonly finishPlayback: () => void;
  readonly clearPlayback: () => void;
  readonly close: () => Promise<void>;
}

export interface FakeMedia extends Media {
  readonly kind: 'fake';
  readonly playback: Buffer[];
  readonly captureEnabled: boolean;
  readonly emitCapture: (buffer: Uint8Array) => void;
}

export function defaultCaptureCommand(sampleRate = SAMPLE_RATE): readonly string[] {
  return ['rec', '-q', '-t', 'raw', '-r', String(sampleRate), '-e', 'signed', '-b', '16', '-c', '1', '-'];
}

export function defaultPlaybackCommand(sampleRate = SAMPLE_RATE): readonly string[] {
  // SoX defaults to 8192 bytes, larger than the 150 ms tail at 24 kHz.
  return ['play', '-q', '--buffer', '2048', '-t', 'raw', '-r', String(sampleRate), '-e', 'signed', '-b', '16', '-c', '1', '-'];
}

export function resolveCommandBinary(binary: string): string | undefined {
  if (!binary) return undefined;

  if (binary.includes('/') || binary.includes('\\')) return existsSync(binary) ? binary : undefined;

  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, binary);

    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

export function commandSampleRate(command: readonly string[] | null): string | undefined {
  if (!command) return undefined;
  const index = command.findIndex(part => part === '-r' || part === '--rate');

  return index >= 0 ? command[index + 1] : undefined;
}

export function createFakeMedia(): FakeMedia {
  const events = new EventEmitter();
  const playback: Buffer[] = [];
  let closed = false;
  let captureEnabled = true;

  const media: FakeMedia = {
    kind: 'fake',
    playback,
    get captureEnabled() { return captureEnabled; },
    onCapture(listener) { events.on('capture', listener);

 return () => { events.off('capture', listener); }; },
    onError(listener) { events.on('fail', listener);

 return () => { events.off('fail', listener); }; },
    emitCapture(buffer) { if (!closed && captureEnabled) events.emit('capture', buffer); },
    writePlayback(buffer) { if (!closed) playback.push(Buffer.from(buffer)); },
    setCaptureEnabled(enabled) { captureEnabled = enabled; },
    finishPlayback() { /* Fake media has no device buffer to flush. */ },
    clearPlayback() { playback.length = 0; },
    async close() { closed = true; captureEnabled = false; events.removeAllListeners(); },
  };

  return media;
}

export type SoxProcess = {
  readonly stdin: { writable: boolean; write(buffer: Uint8Array): boolean; end(): void };
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown; off?(event: 'data', listener: (chunk: Buffer) => void): unknown };
  kill(signal: NodeJS.Signals): boolean;
  onExit(listener: () => void): void;
};

function mediaMissing(binary: string): VoiceError {
  return new VoiceError({ code: 'media-missing', message: `Voice needs \`${binary}\` from sox on PATH.` });
}

function spawnLive(command: readonly string[]): Promise<SoxProcess> {
  return new Promise((resolve, reject) => {
    const [binary, ...args] = command;

    if (!binary) {
      reject(new VoiceError({ code: 'media-missing', message: 'Voice capture and playback commands are required.' }));

      return;
    }

    if (!resolveCommandBinary(binary)) {
      reject(mediaMissing(binary));

      return;
    }

    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'] });

    const fail = (error: Error) => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }

      const missing = error.message.includes('ENOENT') || ('code' in error && error.code === 'ENOENT');
      reject(missing ? mediaMissing(binary) : new VoiceError({ code: 'media-missing', message: error.message }));
    };

    child.once('error', fail);
    child.once('spawn', () => {
      child.off('error', fail);
      const stdin = child.stdin;
      const stdout = child.stdout;

      if (!stdin || !stdout) {
        fail(new VoiceError({ code: 'media-missing', message: 'Voice capture and playback commands are required.' }));

        return;
      }

      stdin.on('error', () => undefined);
      stdout.on('error', () => undefined);
      resolve({
        stdin,
        stdout,
        kill: signal => child.kill(signal),
        onExit: listener => { child.once('exit', listener); },
      });
    });
  });
}

function stopProcess(child: SoxProcess | undefined): void {
  if (!child) return;

  try { child.stdin.end(); } catch { /* already closed */ }

  child.kill('SIGTERM');
}

export const acquireFakeMedia = Effect.fnUntraced(function*() {
  const media = createFakeMedia();
  yield* Effect.acquireRelease(Effect.succeed(media), resource => Effect.promise(() => resource.close()));

  return media;
});

export const acquireSoxMedia = Effect.fn('acquireSoxMedia')(function*(options: {
  readonly captureCommand?: readonly string[] | null;
  readonly playbackCommand?: readonly string[] | null;
  readonly playbackPaddingMs?: number;
}, spawnProcess: (command: readonly string[]) => Promise<SoxProcess> = spawnLive) {
  const captureCommand = options.captureCommand ?? defaultCaptureCommand(SAMPLE_RATE);
  const playbackCommand = options.playbackCommand ?? defaultPlaybackCommand(SAMPLE_RATE);
  yield* atomic(() => {
    requireValue(captureCommand.length > 0 && playbackCommand.length > 0, 'Voice capture and playback commands are required.', 'media-missing');
  });
  const capture = yield* Effect.tryPromise({ try: () => spawnProcess(captureCommand), catch: error => error instanceof VoiceError ? error : mediaMissing(captureCommand[0] ?? 'rec') });

  const playback = yield* Effect.tryPromise({
    try: () => spawnProcess(playbackCommand),
    catch: error => {
      stopProcess(capture);

      return error instanceof VoiceError ? error : mediaMissing(playbackCommand[0] ?? 'play');
    },
  });

  const media = yield* Effect.acquireRelease(atomic(() => {
    const events = new EventEmitter();
    const children = new Set<SoxProcess>([capture, playback]);
    const stopped = new Set<SoxProcess>();
    let pending = Buffer.alloc(0);
    const padding = Buffer.alloc(Math.round(SAMPLE_RATE * (options.playbackPaddingMs ?? 150) / 1000) * 2);
    let playbackQueue: Uint8Array[] = [];
    let replyHasAudio = false;
    let liveCapture: SoxProcess | undefined = capture;
    let livePlayback: SoxProcess | undefined = playback;
    let captureEnabled = true;
    let closed = false;
    let captureGeneration = 0;
    let playbackGeneration = 0;

    function halt(child: SoxProcess | undefined): void {
      if (!child) return;
      stopped.add(child);
      stopProcess(child);
    }

    function watch(child: SoxProcess, label: string): void {
      child.onExit(() => {
        children.delete(child);

        if (child === liveCapture) liveCapture = undefined;

        if (child === livePlayback) livePlayback = undefined;

        if (closed || stopped.has(child)) return;
        events.emit('fail', `Voice ${label} process exited.`);
      });
    }

    function onChunk(chunk: Buffer) {
      if (closed || !captureEnabled) return;
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= FRAME_BYTES) {
        const frame = pending.subarray(0, FRAME_BYTES);
        pending = pending.subarray(FRAME_BYTES);
        events.emit('capture', frame);
      }
    }

    liveCapture.stdout.on('data', onChunk);
    watch(capture, 'capture');
    watch(playback, 'playback');

    async function spawnTracked(command: readonly string[]): Promise<SoxProcess | undefined> {
      const child = await spawnProcess(command);
      children.add(child);

      if (closed) {
        halt(child);
        children.delete(child);

        return undefined;
      }

      return child;
    }

    async function respawnCapture(): Promise<void> {
      const generation = ++captureGeneration;

      if (closed || liveCapture) return;
      const next = await spawnTracked(captureCommand);

      if (!next || closed || generation !== captureGeneration) {
        if (next) {
          halt(next);
          children.delete(next);
        }

        return;
      }

      liveCapture = next;
      watch(next, 'capture');
      liveCapture.stdout.on('data', onChunk);
    }

    async function respawnPlayback(): Promise<void> {
      const generation = ++playbackGeneration;

      if (closed) return;
      halt(livePlayback);

      if (livePlayback) children.delete(livePlayback);
      livePlayback = undefined;
      const next = await spawnTracked(playbackCommand);

      if (!next || closed || generation !== playbackGeneration) {
        if (next) {
          halt(next);
          children.delete(next);
        }

        return;
      }

      livePlayback = next;
      watch(next, 'playback');
      flushPlayback();
    }

    function flushPlayback(): void {
      if (closed || !livePlayback?.stdin.writable) return;

      // Node's writable stream retains accepted writes while the device drains.
      for (const buffer of playbackQueue) livePlayback.stdin.write(buffer);
      playbackQueue = [];
    }

    return {
      kind: 'sox' as const,
      onCapture(listener: (frame: Uint8Array) => void) { events.on('capture', listener);

 return () => { events.off('capture', listener); }; },
      onError(listener: (message: string) => void) { events.on('fail', listener);

 return () => { events.off('fail', listener); }; },
      writePlayback(buffer: Uint8Array) {
        if (closed || buffer.byteLength === 0) return;

        if (!replyHasAudio && padding.length) playbackQueue.push(padding);
        replyHasAudio = true;
        playbackQueue.push(Buffer.from(buffer));
        flushPlayback();
      },
      finishPlayback() {
        if (closed || !replyHasAudio) return;
        replyHasAudio = false;

        if (padding.length) playbackQueue.push(padding);
        // Audio-done means generation finished, not that the device has drained.
        // Keep the player alive and feed silence after the final speech samples.
        flushPlayback();
      },
      setCaptureEnabled(enabled: boolean) {
        if (closed || enabled === captureEnabled) return;
        captureEnabled = enabled;

        if (!enabled) {
          pending = Buffer.alloc(0);
          captureGeneration += 1;
          halt(liveCapture);

          if (liveCapture) children.delete(liveCapture);
          liveCapture = undefined;

          return;
        }

        void respawnCapture().catch(() => { if (!closed) events.emit('fail', 'Voice capture could not restart.'); });
      },
      clearPlayback() {
        if (closed) return;
        playbackQueue = [];
        replyHasAudio = false;
        void respawnPlayback().catch(() => { if (!closed) events.emit('fail', 'Voice playback could not restart.'); });
      },
      async close() {
        closed = true;
        playbackQueue = [];
        replyHasAudio = false;
        captureEnabled = false;
        captureGeneration += 1;
        playbackGeneration += 1;
        events.removeAllListeners();

        for (const child of children) halt(child);
        children.clear();
        liveCapture = undefined;
        livePlayback = undefined;
      },
    } satisfies Media;
  }), resource => Effect.promise(() => resource.close()));

  return media;
});
