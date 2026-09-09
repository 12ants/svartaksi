import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTileFeatures,
  getTileSourceDiagnostics,
  resetTileSource,
} from '../../src/world/providers/vectorTileSource';
import { createPerformanceCapture, type PerformanceCaptureContext } from '../../src/performance/performanceCapture';
import type { PerformanceEnvironment } from '../../src/performance/performanceMetrics';
import { DEFAULT_RENDER_OPTIONS } from '../../src/world/renderOptions';

const INDEX_URL = 'https://tiles.openfreemap.org/planet';
const TEMPLATE = 'https://tiles.example/{z}/{x}/{y}.pbf';

/** An empty but structurally valid tile body — decodes to a tile with no layers, which
 * is all these tests need; what a tile contains is normalizeMapLibreFeatures' business. */
const emptyTile = () => new ArrayBuffer(0);

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => emptyTile(),
  } as unknown as Response;
}

function keys(count: number) {
  return Array.from({ length: count }, (_, index) => ({ z: 14, x: 9000 + index, y: 4818 }));
}

let fetchMock: ReturnType<typeof vi.fn>;

const captureContext: PerformanceCaptureContext = {
  environment: {
    scenarioId: 'unit-test', qualityTier: 'balanced', viewport: { width: 1440, height: 900 },
    devicePixelRatio: 1, userAgent: 'vitest', renderer: null, vendor: null, webglVersion: null,
    rendererKind: 'unknown', warmupDurationMs: 0, sampleDurationMs: 30_000, buildRevision: 'test',
  } satisfies PerformanceEnvironment,
  renderOptions: { ...DEFAULT_RENDER_OPTIONS, terrain: { ...DEFAULT_RENDER_OPTIONS.terrain } },
};

beforeEach(() => {
  resetTileSource();
  // The default mock simulates no locally-committed tile (a 404 on the worldcache path),
  // which is the realistic case for a dev environment that hasn't run the prefetch
  // script — every existing test in this file was written against pure-network fetches,
  // so it should keep falling through to the network exactly as before. Tests that care
  // about the local-tile-first path stub their own fetch to exercise it explicitly.
  fetchMock = vi.fn(async (input: string) => {
    if (input === INDEX_URL) return ok({ tiles: [TEMPLATE] });
    if (input.startsWith('/worldcache/tiles/')) {
      return { ok: false, status: 404, arrayBuffer: async () => { throw new Error('no body'); } } as unknown as Response;
    }
    return ok(null);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetTileSource();
});

// Excludes the local worldcache attempt: this tracks actual network tile requests, and
// every uncached tile now makes a local-miss call before the network one it always made.
const tileCalls = () => fetchMock.mock.calls.filter(
  ([url]) => url !== INDEX_URL && !(url as string).startsWith('/worldcache/tiles/'),
);
const indexCalls = () => fetchMock.mock.calls.filter(([url]) => url === INDEX_URL);

describe('vector tile source', () => {
  it('fetches the tile index once and reuses it for later loads', async () => {
    const signal = new AbortController().signal;
    await fetchTileFeatures(keys(2), signal);
    await fetchTileFeatures(keys(4), signal);

    // The index is the round trip that used to precede every single world load.
    expect(indexCalls()).toHaveLength(1);
  });

  it('serves a tile it has already decoded without going back to the network', async () => {
    const signal = new AbortController().signal;
    await fetchTileFeatures(keys(3), signal);
    const first = tileCalls().length;
    await fetchTileFeatures(keys(3), signal);

    expect(first).toBe(3);
    expect(tileCalls()).toHaveLength(3);
  });

  it('only fetches the tiles a second, overlapping load has not already seen', async () => {
    const signal = new AbortController().signal;
    await fetchTileFeatures(keys(3), signal);
    await fetchTileFeatures(keys(5), signal);

    expect(tileCalls()).toHaveLength(5);
  });

  it('reports network, fallback decode, and memory-cache paths', async () => {
    const signal = new AbortController().signal;
    await fetchTileFeatures(keys(2), signal);
    await fetchTileFeatures(keys(2), signal);

    expect(getTileSourceDiagnostics()).toEqual({
      cacheHits: 2,
      networkFetches: 2,
      workerDecodes: 0,
      fallbackDecodes: 2,
      decodeFailures: 0,
    });
  });

  it('keeps global cache diagnostics through capture boundaries', async () => {
    const signal = new AbortController().signal;
    await fetchTileFeatures(keys(2), signal);
    await fetchTileFeatures(keys(2), signal);
    const before = getTileSourceDiagnostics();
    const capture = createPerformanceCapture();

    capture.start();
    expect(capture.stop(captureContext).source.tileSource).toEqual(before);
    expect(getTileSourceDiagnostics()).toEqual(before);
  });

  it('completes with the tiles that arrived when some of them fail', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === INDEX_URL) return ok({ tiles: [TEMPLATE] });
      if (input.includes('/9001/')) return { ok: false, status: 503 } as unknown as Response;
      return ok(null);
    });

    await expect(fetchTileFeatures(keys(3), new AbortController().signal)).resolves.toEqual([]);
  });

  it('reports failure only when no tile at all could be fetched', async () => {
    fetchMock.mockImplementation(async (input: string) =>
      (input === INDEX_URL
        ? ok({ tiles: [TEMPLATE] })
        : { ok: false, status: 503 } as unknown as Response));

    await expect(fetchTileFeatures(keys(3), new AbortController().signal)).rejects.toThrow(/vector tile/i);
  });

  it('retries the tile index after a failed lookup instead of caching the failure', async () => {
    // Fails the index by URL rather than by call order: the index is now resolved lazily,
    // on the first tile that actually misses locally, so it is no longer the first fetch
    // the source makes.
    let indexAttempts = 0;
    fetchMock.mockImplementation(async (input: string) => {
      if (input === INDEX_URL) {
        indexAttempts += 1;
        if (indexAttempts === 1) return { ok: false, status: 500 } as unknown as Response;
        return ok({ tiles: [TEMPLATE] });
      }
      if (input.startsWith('/worldcache/tiles/')) {
        return { ok: false, status: 404, arrayBuffer: async () => { throw new Error('no body'); } } as unknown as Response;
      }
      return ok(null);
    });

    // The load still fails, but now as the aggregate tile failure rather than a bare
    // "tile index" error: resolving the index lazily puts it inside the per-tile try, so
    // its failure is reported the same way any other failure to obtain a tile is. The
    // property this test exists for is unchanged — the rejection is not memoized, so the
    // next load asks again rather than replaying it forever.
    await expect(fetchTileFeatures(keys(1), new AbortController().signal)).rejects.toThrow(/vector tile/i);
    await expect(fetchTileFeatures(keys(1), new AbortController().signal)).resolves.toEqual([]);
    expect(indexCalls()).toHaveLength(2);
  });

  it('does nothing at all for an empty key list', async () => {
    await expect(fetchTileFeatures([], new AbortController().signal)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('vector tile fetch priority', () => {
  /** A fetch that hands back a resolver per request, so a test can decide when each tile
   * lands and observe exactly how many are in flight at once. */
  function gatedFetch() {
    const pending: Array<{ url: string; land: () => void }> = [];
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input === INDEX_URL) return Promise.resolve(ok({ tiles: [TEMPLATE] }));
      return new Promise<Response>((resolve) => {
        pending.push({ url: input, land: () => resolve(ok(null)) });
      });
    }));
    return pending;
  }

  /** Lets every queued microtask run, so in-flight counts settle before asserting. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** Drains everything so no load is left hanging when the test ends. Requests released
   * by a landing can queue more, so this loops until the queue is genuinely empty. */
  async function drain(pending: Array<{ url: string; land: () => void }>, loads: Promise<unknown>[]) {
    for (let guard = 0; pending.length && guard < 200; guard += 1) {
      pending.splice(0).forEach((request) => request.land());
      await settle();
    }
    await Promise.all(loads);
  }

  it('holds background work to a small share of the connection budget', async () => {
    const pending = gatedFetch();
    const load = fetchTileFeatures(keys(20), new AbortController().signal, 'background');
    await settle();

    expect(pending).toHaveLength(2);
    await drain(pending, [load]);
  });

  it('lets foreground work use the full budget', async () => {
    const pending = gatedFetch();
    const load = fetchTileFeatures(keys(20), new AbortController().signal, 'foreground');
    await settle();

    expect(pending).toHaveLength(8);
    await drain(pending, [load]);
  });

  it('does not let a background load in flight starve a foreground one', async () => {
    const pending = gatedFetch();
    // Background starts first, exactly as the opening route does at startup.
    const background = fetchTileFeatures(keys(20), new AbortController().signal, 'background');
    await settle();
    expect(pending).toHaveLength(2);

    const foreground = fetchTileFeatures(
      Array.from({ length: 20 }, (_, index) => ({ z: 14, x: 100 + index, y: 4818 })),
      new AbortController().signal,
      'foreground',
    );
    await settle();

    // The two background requests keep the slots they hold; every remaining slot in the
    // budget goes to the world the player is waiting for.
    expect(pending).toHaveLength(8);
    expect(pending.slice(2).every(({ url }) => url.includes('/14/1'))).toBe(true);
    await drain(pending, [background, foreground]);
  });
});

describe('local-tile-first fetch', () => {
  it('reads a tile from /worldcache/tiles before the network', async () => {
    fetchMock = vi.fn(async (input: string) => {
      if (input === INDEX_URL) return ok({ tiles: [TEMPLATE] });
      if (input === '/worldcache/tiles/14/9000/4818.pbf') return ok(emptyTile());
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchTileFeatures(keys(1), new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledWith('/worldcache/tiles/14/9000/4818.pbf', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('tiles.example'), expect.anything());
  });

  it('loads a fully-local world with no route to the tile host at all', async () => {
    // The offline case the committed snapshot exists for (CLAUDE.md: "so first load
    // works offline"). Every tile is on disk, so nothing may touch the network —
    // including the tile-index lookup, which used to be awaited up front and so made a
    // reachable tile host a precondition of *every* load. With the host unreachable the
    // whole world failed to load even though not one byte of it was needed from there.
    fetchMock = vi.fn(async (input: string) => {
      if (input === INDEX_URL) throw new TypeError('Failed to fetch');
      if (input.startsWith('/worldcache/tiles/')) return ok(emptyTile());
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTileFeatures(keys(3), new AbortController().signal)).resolves.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalledWith(INDEX_URL);
  });

  it('still resolves the tile index when a tile does have to come from the network', async () => {
    // The other half of the contract: laziness must not mean never.
    fetchMock = vi.fn(async (input: string) => {
      if (input === INDEX_URL) return ok({ tiles: [TEMPLATE] });
      if (input.startsWith('/worldcache/tiles/')) return { ok: false, status: 404 } as Response;
      return ok(emptyTile());
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchTileFeatures(keys(1), new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledWith(INDEX_URL);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('tiles.example'), expect.anything());
  });

  it('falls through to the network when the local tile 404s', async () => {
    fetchMock = vi.fn(async (input: string) => {
      if (input === INDEX_URL) return ok({ tiles: [TEMPLATE] });
      if (input === '/worldcache/tiles/14/9000/4818.pbf') {
        return { ok: false, status: 404, arrayBuffer: async () => { throw new Error('no body'); } } as unknown as Response;
      }
      if (input === 'https://tiles.example/14/9000/4818.pbf') return ok(emptyTile());
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const features = await fetchTileFeatures(keys(1), new AbortController().signal);
    expect(features).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('https://tiles.example/14/9000/4818.pbf', expect.anything());
  });

  it('falls through to the network when the local tile fetch throws', async () => {
    fetchMock = vi.fn(async (input: string) => {
      if (input === INDEX_URL) return ok({ tiles: [TEMPLATE] });
      if (input === '/worldcache/tiles/14/9000/4818.pbf') {
        throw new Error('blocked by a service worker');
      }
      if (input === 'https://tiles.example/14/9000/4818.pbf') return ok(emptyTile());
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const features = await fetchTileFeatures(keys(1), new AbortController().signal);
    expect(features).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('https://tiles.example/14/9000/4818.pbf', expect.anything());
  });
});
