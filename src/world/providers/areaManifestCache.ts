/**
 * Runtime half of the prefetch script's output: resolves a `worldCacheKey` to a
 * precomputed `WorldData`, so a shipped area's first load can skip fetch, decode and
 * normalize entirely. Mirrors resolveTileTemplate's memoize-and-clear-on-failure shape in
 * vectorTileSource.ts, for the same reason: this is asked once per session and must not
 * poison itself for a load that starts after a transient failure.
 *
 * Every path through here that isn't a clean hit returns null rather than throwing: a
 * missing manifest (a dev who never ran the script), a stale one (a key the script no
 * longer emits), or an origin mismatch (see the design spec's "origin hazard") must all
 * degrade to the caller falling back to the live provider, not to a broken load.
 */
import type { LngLat, WorldData } from '../types';

export interface AreaManifestEntry {
  key: string;
  origin: LngLat;
  file: string;
}

export interface AreaManifest {
  generatedAt: string;
  entries: AreaManifestEntry[];
}

const MANIFEST_URL = '/worldcache/areas/manifest.json';

let manifestPromise: Promise<AreaManifest | null> | null = null;

function fetchManifest(): Promise<AreaManifest | null> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      const response = await fetch(MANIFEST_URL, {});
      if (!response.ok) {
        manifestPromise = null;
        return null;
      }
      return await response.json() as AreaManifest;
    } catch {
      manifestPromise = null;
      return null;
    }
  })();
  return manifestPromise;
}

/** Same quantization the manifest was written with — origins are recorded as plain
 * lng/lat, and floating-point round-tripping through JSON can differ in the last bit, so
 * this compares at a resolution far finer than the metre-scale error that would actually
 * matter (see the design spec's origin hazard) rather than requiring bit-exact equality. */
function originsMatch(a: LngLat, b: LngLat): boolean {
  return Math.abs(a.lng - b.lng) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9;
}

export async function lookupPrecomputedArea(
  key: string,
  origin: LngLat,
  signal: AbortSignal,
): Promise<WorldData | null> {
  const manifest = await fetchManifest();
  if (!manifest) return null;
  const entry = manifest.entries.find((candidate) => candidate.key === key);
  if (!entry) return null;
  if (!originsMatch(entry.origin, origin)) return null;
  try {
    const response = await fetch(`/worldcache/areas/${entry.file}`, { signal });
    if (!response.ok) return null;
    return await response.json() as WorldData;
  } catch {
    return null;
  }
}

/** Test/teardown hook only, same contract as resetTileSource. */
export function resetAreaManifestCache(): void {
  manifestPromise = null;
}
