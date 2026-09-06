import { describe, expect, it, vi } from 'vitest';

import {
  createVectorTileDecodeClient,
  type DecodeWorkerLike,
} from '../../src/world/providers/vectorTileDecodeClient';
import type {
  VectorTileDecodeRequest,
  VectorTileDecodeResponse,
} from '../../src/world/providers/vectorTileDecodeProtocol';

class FakeWorker implements DecodeWorkerLike {
  onmessage: ((event: MessageEvent<VectorTileDecodeResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posts: VectorTileDecodeRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  postMessage(message: VectorTileDecodeRequest, transfer: Transferable[]): void {
    this.posts.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: VectorTileDecodeResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<VectorTileDecodeResponse>);
  }

  crash(): void {
    this.onerror?.({ message: 'worker crashed' } as ErrorEvent);
  }
}

const key = (x: number) => ({ z: 14, x, y: 4818 });

describe('vector tile decode client', () => {
  it('transfers buffers and correlates out-of-order responses', async () => {
    const worker = new FakeWorker();
    const client = createVectorTileDecodeClient({ workerFactory: () => worker });
    const firstBuffer = new ArrayBuffer(4);
    const secondBuffer = new ArrayBuffer(8);

    const first = client.decode(key(1), firstBuffer);
    const second = client.decode(key(2), secondBuffer);
    worker.respond({ id: worker.posts[1].id, ok: true, features: [] });
    worker.respond({ id: worker.posts[0].id, ok: true, features: [] });

    await expect(first).resolves.toEqual({ features: [], mode: 'worker' });
    await expect(second).resolves.toEqual({ features: [], mode: 'worker' });
    expect(worker.transfers).toEqual([[firstBuffer], [secondBuffer]]);
  });

  it('rejects an individual malformed tile without disabling the worker', async () => {
    const worker = new FakeWorker();
    const client = createVectorTileDecodeClient({ workerFactory: () => worker });
    const failed = client.decode(key(1), new ArrayBuffer(0));
    worker.respond({ id: worker.posts[0].id, ok: false, error: 'bad tile' });

    await expect(failed).rejects.toThrow('bad tile');
    void client.decode(key(2), new ArrayBuffer(0));
    expect(worker.posts).toHaveLength(2);
  });

  it('falls back once worker construction is unavailable', async () => {
    const fallback = vi.fn(() => []);
    const factory = vi.fn(() => { throw new Error('unsupported'); });
    const client = createVectorTileDecodeClient({ workerFactory: factory, fallback });

    await expect(client.decode(key(1), new ArrayBuffer(0)))
      .resolves.toEqual({ features: [], mode: 'fallback' });
    await client.decode(key(2), new ArrayBuffer(0));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('rejects pending work after a fatal crash and falls back thereafter', async () => {
    const worker = new FakeWorker();
    const fallback = vi.fn(() => []);
    const client = createVectorTileDecodeClient({ workerFactory: () => worker, fallback });
    const pending = client.decode(key(1), new ArrayBuffer(0));

    worker.crash();

    await expect(pending).rejects.toThrow('worker crashed');
    await expect(client.decode(key(2), new ArrayBuffer(0)))
      .resolves.toEqual({ features: [], mode: 'fallback' });
    expect(worker.terminated).toBe(true);
  });

  it('terminates and rejects pending work on reset', async () => {
    const worker = new FakeWorker();
    const client = createVectorTileDecodeClient({ workerFactory: () => worker });
    const pending = client.decode(key(1), new ArrayBuffer(0));

    client.reset();

    await expect(pending).rejects.toThrow(/reset/i);
    expect(worker.terminated).toBe(true);
  });
});
