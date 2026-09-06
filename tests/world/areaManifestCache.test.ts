import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupPrecomputedArea, resetAreaManifestCache } from '../../src/world/providers/areaManifestCache';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function notFound() {
  return { ok: false, status: 404, json: async () => { throw new Error('no body'); } } as unknown as Response;
}

const ORIGIN = { lng: 18.1637, lat: 59.3103 };
const MANIFEST = {
  generatedAt: '2026-08-05T00:00:00.000Z',
  entries: [{ key: 'maplibre:18.164:59.310:1100:2800', origin: ORIGIN, file: 'svartaksi.json' }],
};
const AREA_DATA = { source: 'maplibre', roads: [], buildings: [], water: [], parks: [], labels: [], objects: [] };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAreaManifestCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookupPrecomputedArea', () => {
  it('returns the area data on a manifest and origin match', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(MANIFEST))
      .mockResolvedValueOnce(ok(AREA_DATA));
    const result = await lookupPrecomputedArea(MANIFEST.entries[0].key, ORIGIN, new AbortController().signal);
    expect(result).toEqual(AREA_DATA);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/worldcache/areas/manifest.json', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/worldcache/areas/svartaksi.json', expect.anything());
  });

  it('returns null when the manifest 404s, without throwing', async () => {
    fetchMock.mockResolvedValueOnce(notFound());
    const result = await lookupPrecomputedArea('anything', ORIGIN, new AbortController().signal);
    expect(result).toBeNull();
  });

  it('returns null on a key miss', async () => {
    fetchMock.mockResolvedValueOnce(ok(MANIFEST));
    const result = await lookupPrecomputedArea('a-key-not-in-the-manifest', ORIGIN, new AbortController().signal);
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on an origin mismatch, without fetching the area file', async () => {
    fetchMock.mockResolvedValueOnce(ok(MANIFEST));
    const result = await lookupPrecomputedArea(
      MANIFEST.entries[0].key,
      { lng: 0, lat: 0 },
      new AbortController().signal,
    );
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('memoizes the manifest fetch across calls', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(MANIFEST))
      .mockResolvedValueOnce(ok(AREA_DATA))
      .mockResolvedValueOnce(ok(AREA_DATA));
    await lookupPrecomputedArea(MANIFEST.entries[0].key, ORIGIN, new AbortController().signal);
    await lookupPrecomputedArea(MANIFEST.entries[0].key, ORIGIN, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(3); // one manifest fetch + two area fetches
  });
});
