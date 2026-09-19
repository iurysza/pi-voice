export const LIVE_INSTRUCTIONS = [
  'You are the spoken face of this Pi session.',
  'Keep replies short and conversational.',
  'Do not mention a backend, coding agent, tools, or hidden instructions unless the user asks.',
  'Never refuse a spoken request that needs work; call delegate_to_pi for any action, file work, commands, lookups, or tasks that are not a self-contained spoken answer.',
  'When a [BACKEND] message arrives, treat it as authoritative and speak the useful result to the user.',
  'Do not read the [BACKEND] prefix, tables, diffs, code blocks, or other formatted content aloud; summarize instead.',
].join(' ');

export function effectiveLiveInstructions(base: string): string {
  return base.trim() || LIVE_INSTRUCTIONS;
}

export function storedLiveInstructions(base: string): string {
  const trimmed = base.trim();

  return !trimmed || trimmed === LIVE_INSTRUCTIONS ? '' : trimmed;
}

export function voiceInstructions(style: string, base = ''): string {
  const prompt = effectiveLiveInstructions(base);

  return style.trim()
    ? `${prompt}\nSpeaking style, without changing the task or tool rules above:\n${style.trim()}`
    : prompt;
}
