import type { ChunkKey } from '../types';
import type { VectorTileDecodeRequest, VectorTileDecodeResponse } from './vectorTileDecodeProtocol';
import { decodeVectorTile, type MapLibreFeature } from './vectorTileDecoder';

export interface DecodeWorkerLike {
  onmessage: ((event: MessageEvent<VectorTileDecodeResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: VectorTileDecodeRequest, transfer: Transferable[]): void;
  terminate(): void;
}

interface DecodeClientOptions {
  workerFactory?: () => DecodeWorkerLike;
  fallback?: typeof decodeVectorTile;
}

export interface DecodeResult {
  features: MapLibreFeature[];
  mode: 'worker' | 'fallback';
}

interface PendingDecode {
  resolve: (result: DecodeResult) => void;
  reject: (error: Error) => void;
}

export interface VectorTileDecodeClient {
  decode(key: ChunkKey, bytes: ArrayBuffer): Promise<DecodeResult>;
  reset(): void;
}

const defaultWorkerFactory = (): DecodeWorkerLike => {
  if (typeof Worker === 'undefined') throw new Error('Web Workers are unavailable');
  return new Worker(new URL('./vectorTileDecode.worker.ts', import.meta.url), { type: 'module' });
};

export function createVectorTileDecodeClient(
  options: DecodeClientOptions = {},
): VectorTileDecodeClient {
  const workerFactory = options.workerFactory ?? defaultWorkerFactory;
  const fallback = options.fallback ?? decodeVectorTile;
  const pending = new Map<number, PendingDecode>();
  let worker: DecodeWorkerLike | null | undefined;
  let nextId = 1;

  const disableWorker = (error: Error) => {
    worker?.terminate();
    worker = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  const ensureWorker = (): DecodeWorkerLike | null => {
    if (worker !== undefined) return worker;
    try {
      worker = workerFactory();
      worker.onmessage = ({ data }) => {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.ok) request.resolve({ features: data.features, mode: 'worker' });
        else request.reject(new Error(`Vector tile decode failed: ${data.error}`));
      };
      worker.onerror = (event) => {
        disableWorker(new Error(`Vector tile decode worker failed: ${event.message}`));
      };
    } catch {
      worker = null;
    }
    return worker;
  };

  return {
    decode(key, bytes) {
      const activeWorker = ensureWorker();
      if (!activeWorker) {
        return Promise.resolve({ features: fallback(key, bytes), mode: 'fallback' });
      }
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          activeWorker.postMessage({ id, key, bytes }, [bytes]);
        } catch (error) {
          pending.delete(id);
          disableWorker(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        }
      });
    },
    reset() {
      if (worker) worker.terminate();
      worker = undefined;
      for (const request of pending.values()) {
        request.reject(new Error('Vector tile decode client reset'));
      }
      pending.clear();
      nextId = 1;
    },
  };
}

export const vectorTileDecodeClient = createVectorTileDecodeClient();
