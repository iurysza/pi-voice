import {
  beginStart,
  beginStop,
  completeDelegation,
  completeTranscript,
  fail,
  fingerprint,
  markBackendStarted,
  markTransportReady,
  noteTypedInput,
  noteVoiceInput,
  queueSpeech,
  requestRetry,
  reset,
  takeQueuedSpeech,
  toggleMute,
  applyTranscriptDelta,
  type VoiceState,
} from './domain.ts';
import { wrapDelegation, speakableFinalText } from './delegation.ts';
import { SAMPLE_RATE, type Media } from './media.ts';
import type { Inbound } from './protocol.ts';
import type { Transport } from './transport.ts';

export const STARTUP_TIMEOUT_MS = 10_000;

export interface Host {
  sendDelegation(text: string): void;
  setStatus(state: VoiceState): void;
  notify(message: string, level: 'info' | 'warning' | 'error'): void;
  endSession(): void;
  retryOnce(): void;
}

export class VoiceLoop {
  private current: VoiceState;
  private unsubEvent: (() => void) | undefined;
  private unsubCapture: (() => void) | undefined;
  private unsubMediaError: (() => void) | undefined;
  private readonly pendingCallIds: string[] = [];
  private readonly seenHandoffs = new Set<string>();
  private negotiateTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly media: Media,
    private readonly transport: Transport,
    private readonly host: Host,
    initial: VoiceState,
    private readonly interruptResponse = true,
  ) {
    this.current = initial;
  }
  get state(): VoiceState { return this.current; }
  attach(): void {
    this.unsubEvent = this.transport.onEvent(event => this.dispatch(event));
    this.unsubCapture = this.media.onCapture(frame => this.capture(frame));
    this.unsubMediaError = this.media.onError(message => this.dispatch({ type: 'error', message, fatal: true }));
  }
  detach(): void {
    this.clearNegotiateTimer();
    this.unsubEvent?.();
    this.unsubCapture?.();
    this.unsubMediaError?.();
    this.unsubEvent = undefined;
    this.unsubCapture = undefined;
    this.unsubMediaError = undefined;
  }
  begin(input?: { readonly agentTurnRunning?: boolean; readonly startupRetry?: VoiceState['startupRetry'] }): boolean {
    this.replace(beginStart(this.current, input));
    return this.current.phase === 'starting';
  }
  armStartup(timeoutMs = STARTUP_TIMEOUT_MS): void {
    if (this.current.phase === 'starting') this.armNegotiateTimeout(timeoutMs);
  }
  markBackend(): void { this.replace(markBackendStarted(this.current)); }
  requestStop(): void {
    this.flushTail();
    this.replace(beginStop(this.current));
  }
  abandon(): void { this.replace(beginStop(this.current)); }
  finishStop(): void { this.replace(reset(this.current)); }
  mute(): void { this.replace(toggleMute(this.current)); }
  typed(text: string): void { this.replace(noteTypedInput(this.current, text)); }
  settled(text: string): void {
    if (this.current.phase !== 'active' || (!this.current.awaitingDelegation && this.pendingCallIds.length === 0)) return;
    const speakable = speakableFinalText(text);
    if (speakable) {
      this.replace(queueSpeech(this.current, speakable));
      this.flushSpeech();
      return;
    }
    this.finishHandoff(undefined);
  }
  dispatch(event: Inbound): void {
    try { this.dispatchEvent(event); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Voice event handling failed';
      this.host.notify(message, 'error');
    }
  }
  private dispatchEvent(event: Inbound): void {
    switch (event.type) {
      case 'session_ready':
        this.clearNegotiateTimer();
        this.replace(markTransportReady(this.current));
        return;
      case 'speech_started':
        if (this.interruptResponse) this.media.clearPlayback();
        return;
      case 'input_transcript_delta':
        this.replace(applyTranscriptDelta(this.current, 'user', event.delta));
        return;
      case 'input_transcript_done':
        this.replace(completeTranscript(this.current, 'user', event.text));
        return;
      case 'output_transcript_delta':
        this.replace(applyTranscriptDelta(this.current, 'assistant', event.delta));
        return;
      case 'output_transcript_done':
        this.replace(completeTranscript(this.current, 'assistant', event.text));
        return;
      case 'audio_done':
        this.media.finishPlayback();
        return;
      case 'audio_out':
        this.play(event.audio, event.sampleRate);
        return;
      case 'handoff':
        this.handoff(event.callId, event.input);
        return;
      case 'error':
        if (!event.fatal) {
          this.host.notify(event.message, 'warning');
          return;
        }
        this.clearNegotiateTimer();
        this.replace(fail(this.current, event.message));
        this.host.notify(event.message, 'error');
        this.host.endSession();
        return;
      case 'closed':
        this.clearNegotiateTimer();
        if (this.current.phase === 'inactive' || this.current.phase === 'stopping') {
          if (this.current.phase === 'stopping') this.replace(reset(this.current));
          return;
        }
        if (event.reason) this.host.notify(event.reason, 'warning');
        this.replace(reset(this.current));
        this.host.endSession();
        return;
    }
  }
  private capture(frame: Uint8Array): void {
    if (this.current.phase !== 'active' && this.current.phase !== 'starting') return;
    if (this.current.microphoneMuted) return;
    this.transport.appendAudio(frame);
  }
  private play(audio: string, sampleRate: number): void {
    if (this.current.phase !== 'active' || this.current.speakerSuppressed || !this.current.latestInputWasVoice) return;
    if (sampleRate !== SAMPLE_RATE) return;
    this.media.writePlayback(Buffer.from(audio, 'base64'));
  }
  private handoff(callId: string, input: string): void {
    if (callId) {
      if (this.seenHandoffs.has(callId)) return;
      this.seenHandoffs.add(callId);
    }
    const transcriptDelta = this.current.transcriptRole === 'user' && this.current.transcript ? this.current.transcript : undefined;
    const voiced = noteVoiceInput(this.current, input);
    this.replace(voiced.state);
    if (!voiced.maySpeak) {
      if (callId) this.transport.completeHandoff({ callId });
      return;
    }
    this.pendingCallIds.push(callId);
    const wrapped = transcriptDelta === undefined
      ? wrapDelegation({ input })
      : wrapDelegation({ input, transcriptDelta });
    this.host.sendDelegation(wrapped);
  }
  private flushSpeech(): void {
    const taken = takeQueuedSpeech(this.current);
    this.replace(taken.state);
    this.finishHandoff(taken.speech?.text);
  }
  private finishHandoff(output: string | undefined): void {
    const callId = this.pendingCallIds.shift();
    if (this.pendingCallIds.length === 0) this.replace(completeDelegation(this.current));
    if (callId) this.transport.completeHandoff({ callId, ...(output ? { output } : {}) });
    else if (output) this.transport.appendSpeech(output);
  }
  private flushTail(): void {
    if (this.current.phase !== 'active' && this.current.phase !== 'starting') return;
    if (this.current.awaitingDelegation || this.pendingCallIds.length > 0) return;
    const text = this.current.transcriptRole === 'user' ? this.current.transcript.trim() : '';
    if (!text) return;
    if (this.current.latestVoiceFingerprint === fingerprint(text)) return;
    const voiced = noteVoiceInput(this.current, text, 'transcript_tail_flush');
    this.replace(voiced.state);
    this.host.sendDelegation(wrapDelegation({ input: text, source: 'transcript_tail_flush' }));
  }
  private armNegotiateTimeout(timeoutMs: number): void {
    this.clearNegotiateTimer();
    this.negotiateTimer = setTimeout(() => {
      const retry = requestRetry(this.current);
      if (!retry) {
        this.replace(fail(this.current, 'Voice connection timed out.'));
        this.host.notify('Voice connection timed out.', 'error');
        this.host.endSession();
        return;
      }
      this.replace(retry);
      this.host.notify(retry.failure ?? 'Voice connection timed out. Retrying once after cleanup.', 'warning');
      this.host.retryOnce();
    }, timeoutMs);
  }
  private clearNegotiateTimer(): void {
    if (this.negotiateTimer) clearTimeout(this.negotiateTimer);
    this.negotiateTimer = undefined;
  }
  private replace(next: VoiceState): void {
    this.current = next;
    this.host.setStatus(next);
    const live = next.phase === 'active' || next.phase === 'starting';
    this.media.setCaptureEnabled(live && !next.microphoneMuted);
  }
}
