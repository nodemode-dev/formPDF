export interface Step { action: string; args: Record<string, unknown> }

let steps: Step[] | null = null;
const listeners = new Set<() => void>();

function notify(): void { for (const fn of listeners) fn(); }

export function isRecording(): boolean { return steps !== null; }

export function recorded(): readonly Step[] { return steps ?? []; }

export function startRecording(): void { steps = []; notify(); }

export function stopRecording(): Step[] {
  const out = steps ?? [];
  steps = null;
  notify();
  return out;
}

export function record(action: string, args: unknown): void {
  if (!steps) return;
  const clean = JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>;
  for (const k of ['path', 'out', 'doc', 'name']) delete clean[k];
  steps.push({ action, args: clean });
  notify();
}

export function onRecording(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
