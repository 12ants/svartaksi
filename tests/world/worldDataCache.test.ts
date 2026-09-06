import { describe, expect, it, vi } from 'vitest';

import { createWorldDataCache } from '../../src/world/worldDataCache';
import type { WorldData } from '../../src/world/types';

function data(id: string): WorldData {
  return {
    source: 'maplibre',
    roads: [{ id, kind: 'road', width: 4, points: [] }],
    buildings: [],
    water: [],
    parks: [],
    labels: [],
    objects: [],
  };
}

describe('createWorldDataCache', () => {
  it('evicts the least-recently-used resolved entry at the configured bound', async () => {
    const cache = createWorldDataCache(2);
    const signal = new AbortController().signal;
    await cache.load('a', async () => data('a'), signal);
    await cache.load('b', async () => data('b'), signal);
    await cache.load('a', async () => data('unused'), signal);
    await cache.load('c', async () => data('c'), signal);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('deduplicates pending requests and stores only successful loads', async () => {
    const cache = createWorldDataCache();
    const signal = new AbortController().signal;
    let resolve!: (value: WorldData) => void;
    const loader = vi.fn(() => new Promise<WorldData>(done => { resolve = done; }));
    const first = cache.load('same', loader, signal);
    const second = cache.load('same', loader, signal);
    resolve(data('same'));

    await expect(first).resolves.toEqual(data('same'));
    await expect(second).resolves.toEqual(data('same'));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.has('same')).toBe(true);

    await expect(cache.load('failed', async () => {
      throw new Error('offline');
    }, signal)).rejects.toThrow('offline');
    expect(cache.has('failed')).toBe(false);
  });

  it('aborts one caller without cancelling a shared request needed by another', async () => {
    const cache = createWorldDataCache();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let resolve!: (value: WorldData) => void;
    const loader = vi.fn(() => new Promise<WorldData>(done => { resolve = done; }));
    const first = cache.load('shared', loader, firstController.signal);
    const second = cache.load('shared', loader, secondController.signal);

    firstController.abort();
    resolve(data('shared'));

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toEqual(data('shared'));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.has('shared')).toBe(true);
  });

  it('aborts pending loaders and removes all entries on clear', async () => {
    const cache = createWorldDataCache();
    const signal = new AbortController().signal;
    await cache.load('resolved', async () => data('resolved'), signal);
    const pending = cache.load('pending', loaderSignal => new Promise<WorldData>((_resolve, reject) => {
      loaderSignal.addEventListener('abort', () => reject(loaderSignal.reason), { once: true });
    }), signal);

    cache.clear();

    await expect(pending).rejects.toBeDefined();
    expect(cache.has('resolved')).toBe(false);
  });
});
