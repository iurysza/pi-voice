import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Effect, Layer } from 'effect';
import { VoiceError } from '../src/domain.ts';
import { NativeRuntime } from '../src/native-runtime.ts';

class Probe extends Context.Service<Probe, { readonly id: string }>()('pi-voice/test/Probe') {}

test('native runtime cancels in-flight work and rejects later runs', async () => {
  const runtime = new NativeRuntime(Layer.succeed(Probe, Probe.of({ id: 'voice' })));
  const pending = runtime.run(Effect.never);
  await runtime.close();
  await assert.rejects(() => pending);
  await assert.rejects(() => runtime.run(Probe.use(Effect.succeed)), /Voice session lifetime has closed/);
  await runtime.close();
});

test('boundary errors stay typed', () => {
  const error = new VoiceError({ code: 'missing-key', message: 'Voice requires OPENAI_API_KEY in the environment.' });
  assert.equal(error._tag, 'VoiceError');
  assert.equal(error.code, 'missing-key');
});
