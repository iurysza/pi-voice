import { Context, Effect, Layer, Option, Redacted } from 'effect';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { FOOTER_STATUS_KEY, PI_VERSION, atomic, errorMessage, initialState, isError, requireValue, statusLine, statusPresentation, type StatusPresentation, type VoiceState } from '../src/domain.ts';
import { parseDelegation, DELEGATION_CUSTOM_TYPE, isVoiceDelegationMessage, isVoiceDelegationTurn } from '../src/delegation.ts';
import { createFooterSlotRegistration } from '../src/footer-slot.ts';
import { voiceInstructions } from '../src/prompt.ts';
import { showVoiceMenu } from '../src/voice-menu.ts';
import { showVoiceSettings } from '../src/voice-settings-panel.ts';
import { loadSettings, type VoiceSettings } from '../src/settings.ts';
import { acquireFakeMedia, acquireSoxMedia, type Media } from '../src/media.ts';
import { acquireFakeTransport, acquireWebsocketTransport, type CreateSocket, type Transport } from '../src/transport.ts';
import { NativeRuntime } from '../src/native-runtime.ts';
import { VoiceLoop, type Host } from '../src/session.ts';
import { extractSpeakableAssistant } from '../src/text.ts';
import { resolveRunningPiVersion } from '../src/host-version.ts';
import { BACKEND_ENTRY_TYPE, renderBackend, renderDelegation } from '../src/delegation-renderer.ts';

export interface VoiceDependencies {
  readonly media?: Media;
  readonly transport?: Transport;
  readonly createSocket?: CreateSocket;
  readonly apiKey?: Redacted.Redacted<string>;
  readonly settings?: VoiceSettings;
  readonly settingsPath?: string;
  readonly fake?: boolean;
  readonly piVersion?: string;
}

class VoiceResources extends Context.Service<VoiceResources, { media: Media; transport: Transport; loop: VoiceLoop }>()('pi-voice/VoiceResources') {}

function envKey(): Redacted.Redacted<string> | undefined {
  const value = process.env.OPENAI_API_KEY;
  return value && value.trim() ? Redacted.make(value) : undefined;
}

function statusWidget(presentation: StatusPresentation) {
  return (_tui: { requestRender(): void }, theme: Theme) => ({
    render: (_width: number) => [theme.fg(presentation.role, `${presentation.glyph}  ${presentation.label}`)],
    invalidate() {},
  });
}

function publishStatus(ctx: ExtensionContext, state: VoiceState | undefined, showStatusLine: boolean): void {
  const presentation = state ? statusPresentation(state) : undefined;
  ctx.ui.setWidget(FOOTER_STATUS_KEY, presentation && showStatusLine ? statusWidget(presentation) : undefined);
  ctx.ui.setStatus(FOOTER_STATUS_KEY, presentation ? ctx.ui.theme.fg(presentation.role, presentation.glyph) : undefined);
}

function hostFor(ctx: ExtensionContext, pi: ExtensionAPI, showStatusLine: () => boolean): Host {
  return {
    sendDelegation(text) {
      try {
        const parsed = parseDelegation(text);
        if (Option.isNone(parsed)) {
          ctx.ui.notify('Voice handoff was not wrapped as a realtime delegation', 'warning');
          return;
        }
        const busy = ctx.hasPendingMessages() || !ctx.isIdle();
        const options = busy ? { triggerTurn: true as const, deliverAs: 'followUp' as const } : { triggerTurn: true as const };
        pi.sendMessage({
          customType: DELEGATION_CUSTOM_TYPE,
          content: text,
          display: true,
          details: { input: parsed.value.input, source: parsed.value.source },
        }, options);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : 'Voice handoff failed', 'error');
      }
    },
    setStatus(state) { publishStatus(ctx, state, showStatusLine()); },
    notify(message, level) { ctx.ui.notify(message, level); },
    endSession() { /* bound after startVoice */ },
    retryOnce() { /* bound after startVoice */ },
  };
}

export default function voiceExtension(pi: ExtensionAPI, dependencies: VoiceDependencies = {}) {
  pi.registerMessageRenderer(DELEGATION_CUSTOM_TYPE, renderDelegation);
  pi.registerEntryRenderer(BACKEND_ENTRY_TYPE, renderBackend);
  const footerSlot = createFooterSlotRegistration(pi.events, FOOTER_STATUS_KEY, 100, 'core');
  let lifetime: NativeRuntime<VoiceResources> | undefined;
  let loop: VoiceLoop | undefined;
  let currentCtx: ExtensionContext | undefined;
  const pendingSettlements: string[] = [];
  let turnIsVoice = false;
  let closing: Promise<void> | undefined;
  let startToken = 0;
  let startupRetryUsed = false;
  let showBackendMessages = false;
  let showStatusLine = true;

  function applyRuntimeSettings(settings: VoiceSettings): void {
    showBackendMessages = settings.showBackendMessages;
    showStatusLine = settings.showStatusLine;
  }

  function closeVoice(intent: 'stop' | 'abandon' = 'abandon'): Promise<void> {
    if (closing) return closing;
    const currentLoop = loop;
    const currentLifetime = lifetime;
    loop = undefined;
    lifetime = undefined;
    pendingSettlements.length = 0;
    turnIsVoice = false;
    closing = (async () => {
      try {
        if (intent === 'stop') currentLoop?.requestStop();
        else currentLoop?.abandon();
        currentLoop?.detach();
        await currentLifetime?.close();
        currentLoop?.finishStop();
        if (currentCtx) publishStatus(currentCtx, undefined, showStatusLine);
      } finally {
        closing = undefined;
      }
    })();
    return closing;
  }

  async function startVoice(ctx: ExtensionContext, mode: 'toggle' | 'replace' = 'toggle') {
    const token = ++startToken;
    if (mode === 'toggle' && loop && (loop.state.phase === 'active' || loop.state.phase === 'starting')) {
      await closeVoice('stop');
      return;
    }
    await closeVoice('abandon');
    if (token !== startToken) return;
    const loaded = dependencies.settings
      ? { path: 'injected', loaded: true, settings: dependencies.settings, diagnostics: [] }
      : await Effect.runPromise(loadSettings(dependencies.settingsPath));
    for (const diagnostic of loaded.diagnostics) ctx.ui.notify(diagnostic, 'warning');
    const settings = loaded.settings;
    applyRuntimeSettings(settings);
    const instructions = voiceInstructions(settings.voiceInstructions, settings.liveInstructions);
    const fake = dependencies.fake === true || process.env.PI_VOICE_TRANSPORT === 'fake' || Boolean(dependencies.media && dependencies.transport);
    const apiKey = dependencies.apiKey ?? envKey();
    const host = hostFor(ctx, pi, () => showStatusLine);
    host.endSession = () => { void closeVoice(); };
    host.retryOnce = () => {
      if (startupRetryUsed) return;
      startupRetryUsed = true;
      void closeVoice().then(() => {
        if (currentCtx) return startVoice(currentCtx);
      });
    };
    const agentTurnRunning = !ctx.isIdle() || ctx.hasPendingMessages();
    const active = new NativeRuntime(Layer.effect(VoiceResources, Effect.gen(function* () {
      if (!fake) {
        yield* atomic(() => {
          const version = dependencies.piVersion ?? resolveRunningPiVersion();
          requireValue(version === PI_VERSION, `Pi Voice requires Pi ${PI_VERSION}; found ${version}`, 'pi-version');
        });
      }
      const media = dependencies.media ?? (fake ? yield* acquireFakeMedia() : yield* acquireSoxMedia({ captureCommand: settings.captureCommand, playbackCommand: settings.playbackCommand, playbackPaddingMs: settings.playbackPaddingMs }));
      const transport = dependencies.transport ?? (fake ? yield* acquireFakeTransport() : yield* acquireWebsocketTransport({
        apiKey: apiKey ?? Redacted.make(''),
        model: settings.model,
        voice: settings.voice,
        instructions,
        wsUrl: settings.wsUrl,
        turnDetection: settings,
        ...(dependencies.createSocket ? { createSocket: dependencies.createSocket } : {}),
      }));
      const next = new VoiceLoop(media, transport, host, initialState(), settings.interruptResponse);
      yield* Effect.acquireRelease(Effect.sync(() => {
        next.attach();
        next.begin({ agentTurnRunning, startupRetry: startupRetryUsed ? 'used' : 'available' });
        next.markBackend();
        return next;
      }), resource => Effect.sync(() => resource.detach()));
      yield* Effect.promise(() => transport.start({ instructions, voice: settings.voice, model: settings.model }));
      return VoiceResources.of({ media, transport, loop: next });
    })));
    lifetime = active;
    try {
      const resources = await active.run(VoiceResources.use(Effect.succeed));
      if (token !== startToken || active.closed) {
        await active.close();
        if (lifetime === active) lifetime = undefined;
        return;
      }
      loop = resources.loop;
      loop.armStartup();
      publishStatus(ctx, loop.state, showStatusLine);
      void active.run(Effect.never).catch(error => {
        if (active.closed || active !== lifetime) return;
        const message = errorMessage(isError(error) ? error : new Error('Voice session failed'));
        ctx.ui.notify(message, 'error');
        void closeVoice();
      });
    } catch (error) {
      await active.close();
      if (lifetime === active) lifetime = undefined;
      ctx.ui.notify(errorMessage(isError(error) ? error : new Error('Voice failed to start')), 'error');
    }
  }

  pi.registerCommand('voice', {
    description: 'Live voice: start, stop, mute, or settings for voice and speaking style',
    getArgumentCompletions: prefix => {
      const items = ['start', 'stop', 'mute', 'settings'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      currentCtx = ctx;
      let sub = args.trim();
      if (ctx.mode !== 'tui') return ctx.ui.notify('Voice requires the native Pi TUI', 'warning');
      if (!sub) {
        const active = Boolean(loop && (loop.state.phase === 'active' || loop.state.phase === 'starting'));
        const status = loop ? statusLine(loop.state) : undefined;
        const action = await showVoiceMenu(ctx.ui, {
          active,
          muted: loop?.state.microphoneMuted === true,
          ...(status ? { status } : {}),
        });
        if (!action) return;
        sub = action;
      }
      if (sub === 'settings') {
        const sessionLive = Boolean(loop && (loop.state.phase === 'active' || loop.state.phase === 'starting'));
        const result = await showVoiceSettings(ctx.ui, dependencies.settingsPath, { sessionLive });
        if (!result.saved) return;
        if (!dependencies.settings) {
          const loaded = await Effect.runPromise(loadSettings(dependencies.settingsPath));
          applyRuntimeSettings(loaded.settings);
        }
        if (currentCtx && loop) publishStatus(currentCtx, loop.state, showStatusLine);
        if (result.restart) {
          startupRetryUsed = false;
          await startVoice(ctx, 'replace');
        }
        return;
      }
      if (sub === 'mute') {
        if (!loop || (loop.state.phase !== 'active' && loop.state.phase !== 'starting')) return ctx.ui.notify('Voice is not active', 'warning');
        loop.mute();
        return;
      }
      if (sub === 'stop') {
        startupRetryUsed = false;
        await closeVoice('stop');
        return;
      }
      startupRetryUsed = false;
      await startVoice(ctx);
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    currentCtx = ctx;
    startupRetryUsed = false;
    footerSlot.register();
    await closeVoice();
  });
  pi.on('input', (event, ctx) => {
    currentCtx = ctx;
    if (event.source !== 'interactive' || !loop || loop.state.phase !== 'active') return;
    loop.typed(event.text);
    return undefined;
  });
  pi.on('message_start', event => {
    if (isVoiceDelegationMessage((event as { message?: unknown }).message)) turnIsVoice = true;
  });
  pi.on('agent_end', event => {
    const marked = turnIsVoice || isVoiceDelegationTurn(event);
    turnIsVoice = false;
    const speakable = extractSpeakableAssistant(event);
    if (marked) {
      pendingSettlements.push(speakable ?? '');
      return;
    }
    if (pendingSettlements.length === 0 || speakable === undefined) return;
    pendingSettlements[pendingSettlements.length - 1] = speakable;
  });
  pi.on('agent_settled', (_event, ctx) => {
    currentCtx = ctx;
    if (!loop) {
      pendingSettlements.length = 0;
      return;
    }
    while (pendingSettlements.length > 0) {
      const speakable = pendingSettlements.shift() ?? '';
      if (showBackendMessages && speakable) pi.appendEntry(BACKEND_ENTRY_TYPE, { text: speakable });
      loop.settled(speakable);
    }
  });
  pi.on('session_shutdown', async () => {
    await closeVoice();
    footerSlot.dispose();
    currentCtx = undefined;
  });
}
