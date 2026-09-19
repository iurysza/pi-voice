import { Effect, Layer, ManagedRuntime } from 'effect';
import { VoiceError } from './domain.ts';

export class NativeRuntime<R> {
  private readonly runtime: ManagedRuntime.ManagedRuntime<R, VoiceError>;
  private readonly cancellation = new AbortController();
  private readonly running = new Set<Promise<unknown>>();
  private disposal: Promise<void> | undefined;
  constructor(layer: Layer.Layer<R, VoiceError>) { this.runtime = ManagedRuntime.make(layer); }
  get closed() { return this.cancellation.signal.aborted; }
  run<A>(effect: Effect.Effect<A, VoiceError, R>, signal?: AbortSignal): Promise<A> {
    if (this.closed) return Promise.reject(new VoiceError({ code: 'stale-binding', message: 'Voice session lifetime has closed' }));
    const combined = signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal;
    const task = this.runtime.runPromise(effect, { signal: combined });
    this.running.add(task);
    void task.then(() => this.running.delete(task), () => this.running.delete(task));

    return task;
  }
  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.cancellation.abort();
    this.disposal = Promise.allSettled(this.running).then(() => this.runtime.dispose());

    return this.disposal;
  }
}
