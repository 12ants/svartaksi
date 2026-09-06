/**
 * A dev-only, in-memory event log: a capped ring buffer plus a console
 * interceptor, both installed only when `?dev=1` is present (see App.tsx's
 * useEffect around devMode). Module-level rather than React state so the
 * console wrapper can push into it without a component in scope.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  timestampMs: number;
  level: LogLevel;
  category: string;
  message: string;
}

const CAPACITY = 500;
let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function pushLog(level: LogLevel, category: string, message: string): void {
  const next = [...entries, { id: nextId, timestampMs: Date.now(), level, category, message }];
  nextId += 1;
  entries = next.length > CAPACITY ? next.slice(next.length - CAPACITY) : next;
  notify();
}

export function getLog(): readonly LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries = [];
  notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let consoleCaptureDispose: (() => void) | null = null;

/** Guarded against double-install: App.tsx's devMode effect can re-run in
 * StrictMode's dev double-invoke, and a second wrap must not wrap the wrapper. */
export function installConsoleCapture(): () => void {
  if (consoleCaptureDispose) return () => {};
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => {
    pushLog('warn', 'console', args.map(String).join(' '));
    originalWarn.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    pushLog('error', 'console', args.map(String).join(' '));
    originalError.apply(console, args);
  };
  consoleCaptureDispose = () => {
    console.warn = originalWarn;
    console.error = originalError;
    consoleCaptureDispose = null;
  };
  return consoleCaptureDispose;
}
