import type { WorldData } from './types';

export interface WorldDataCache {
  load(
    key: string,
    loader: (signal: AbortSignal) => Promise<WorldData>,
    callerSignal: AbortSignal,
  ): Promise<WorldData>;
  has(key: string): boolean;
  clear(): void;
}

interface PendingLoad {
  controller: AbortController;
  promise: Promise<WorldData>;
}

export function createWorldDataCache(maxEntries = 12): WorldDataCache {
  const limit = Math.max(1, Math.floor(maxEntries));
  const resolved = new Map<string, WorldData>();
  const pending = new Map<string, PendingLoad>();

  return {
    load(key, loader, callerSignal) {
      const cached = resolved.get(key);
      if (cached) {
        resolved.delete(key);
        resolved.set(key, cached);
        return forCaller(Promise.resolve(cached), callerSignal);
      }

      let shared = pending.get(key);
      if (!shared) {
        const controller = new AbortController();
        const promise = loader(controller.signal)
          .then((value) => {
            if (!controller.signal.aborted) {
              resolved.set(key, value);
              evictOldest(resolved, limit);
            }
            return value;
          })
          .finally(() => {
            pending.delete(key);
          });
        shared = { controller, promise };
        pending.set(key, shared);
      }
      return forCaller(shared.promise, callerSignal);
    },
    has(key) {
      return resolved.has(key);
    },
    clear() {
      resolved.clear();
      const reason = abortError();
      for (const load of pending.values()) load.controller.abort(reason);
      pending.clear();
    },
  };
}

function evictOldest(entries: Map<string, WorldData>, limit: number): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

function forCaller(promise: Promise<WorldData>, signal: AbortSignal): Promise<WorldData> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException('World load aborted', 'AbortError');
}
