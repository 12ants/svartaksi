/**
 * The network half of the MapLibre provider: turning a list of `z/x/y` keys into decoded
 * vector-tile features, as cheaply and as robustly as possible.
 *
 * Split out of maplibreProvider so that file is only about *interpreting* tiles (what
 * counts as a road, how buildings are de-duplicated across seams) while everything about
 * *getting* them lives here. Three things this layer is responsible for, each of which
 * used to cost a visible chunk of loading time:
 *
 * 1. The TileJSON index is fetched once per session, not once per load. Every world
 *    stream, every route corridor and every speculative preload previously opened with a
 *    full round trip to the same document before a single tile could be requested.
 * 2. Decoded tiles are cached. Consecutive stream updates are ~520m apart while a z14
 *    tile is over a kilometre across, so the large majority of tiles in any update were
 *    just decoded for the previous one.
 * 3. One failing tile no longer fails the whole world. A single 503 out of thirty-two
 *    used to reject the entire load and drop the player onto the retry screen; now the
 *    load proceeds with the tiles that did arrive, and only a total wipeout is an error.
 */
import type { ChunkKey } from '../types';
import { vectorTileDecodeClient } from './vectorTileDecodeClient';
import type { MapLibreFeature } from './vectorTileDecoder';

export type { Geometry, MapLibreFeature } from './vectorTileDecoder';

const TILE_INDEX_URL = 'https://tiles.openfreemap.org/planet';

/**
 * Resolved TileJSON template, shared by every provider instance for the session.
 *
 * Deliberately fetched *without* the caller's AbortSignal: this promise is handed to
 * every subsequent caller, so letting the first one's cancellation reject it would
 * poison the index for loads that are still very much alive. The document is a few
 * hundred bytes, so an orphaned request costs nothing worth defending against. A
 * rejection clears the memo so the next load retries rather than replaying the failure.
 */
let templatePromise: Promise<string> | null = null;

export function resolveTileTemplate(): Promise<string> {
  if (templatePromise) return templatePromise;
  templatePromise = (async () => {
    const response = await fetch(TILE_INDEX_URL);
    if (!response.ok) throw new Error(`MapLibre tile index failed (${response.status})`);
    const tileJson = await response.json() as { tiles?: string[] };
    const template = tileJson.tiles?.[0];
    if (!template) throw new Error('MapLibre tile index returned no tile URL');
    return template;
  })();
  templatePromise = templatePromise.catch((error: unknown) => {
    templatePromise = null;
    throw error;
  });
  return templatePromise;
}

/**
 * Decoded-tile cache, bounded by total feature count rather than tile count: an empty
 * water tile and a downtown tile differ by three orders of magnitude in what they hold,
 * so a flat "keep 32 tiles" limit either wastes memory or evicts far too eagerly
 * depending on where the player happens to be. Insertion order is the eviction order
 * (Map preserves it), and a hit re-inserts, which makes this a plain LRU.
 *
 * The budget is roughly a dense inner-city neighbourhood's worth of tiles — comfortably
 * more than one stream update needs, so consecutive updates overlap in cache rather than
 * evicting each other.
 */
const FEATURE_BUDGET = 240_000;
const cache = new Map<string, MapLibreFeature[]>();
let cachedFeatures = 0;

export interface TileSourceDiagnostics {
  cacheHits: number;
  networkFetches: number;
  workerDecodes: number;
  fallbackDecodes: number;
  decodeFailures: number;
}

const diagnostics: TileSourceDiagnostics = {
  cacheHits: 0,
  networkFetches: 0,
  workerDecodes: 0,
  fallbackDecodes: 0,
  decodeFailures: 0,
};

export function getTileSourceDiagnostics(): Readonly<TileSourceDiagnostics> {
  return { ...diagnostics };
}

/**
 * Drops every piece of session state this module holds: the decoded-tile cache, the
 * memoized tile index, and the request queue. A test/teardown hook only — during play
 * the feature budget above bounds the cache, the index is meant to survive for the whole
 * session, and the queue drains on its own.
 */
export function resetTileSource(): void {
  cache.clear();
  cachedFeatures = 0;
  templatePromise = null;
  activeFetches = 0;
  waiting.length = 0;
  vectorTileDecodeClient.reset();
  for (const key of Object.keys(diagnostics) as Array<keyof TileSourceDiagnostics>) {
    diagnostics[key] = 0;
  }
}

function remember(key: string, features: MapLibreFeature[]): void {
  cache.set(key, features);
  cachedFeatures += features.length;
  for (const [oldest, evicted] of cache) {
    if (cachedFeatures <= FEATURE_BUDGET) break;
    if (oldest === key) break;
    cache.delete(oldest);
    cachedFeatures -= evicted.length;
  }
}

/**
 * Simultaneous tile requests across the whole app, not per call.
 *
 * Browsers cap connections per host anyway, but owning the limit here buys two things a
 * browser queue cannot: aborting a superseded load does not have to unwind thirty
 * in-flight fetches, and only a bounded number of fetched buffers can queue for the
 * decode worker rather than all arriving at once.
 */
const MAX_CONCURRENT_TILE_FETCHES = 8;

/**
 * How many of those slots a background load may hold. Without this the app's two
 * startup loads — the world around the player and the corridor for the opening bus route
 * — each opened eight requests and interleaved one for one, so the world the player is
 * waiting to see took roughly three times as long to arrive. The route can afford to
 * trickle in behind it: it only has to be ready by the time the world is built.
 */
const MAX_CONCURRENT_BACKGROUND_FETCHES = 2;

/**
 * `foreground` is anything the player is waiting on: the world around them. `background`
 * is work that must finish eventually but must not delay that, and it is both capped
 * lower and queued behind foreground work for whatever slots remain.
 */
export type FetchPriority = 'foreground' | 'background';

let activeFetches = 0;
const waiting: Array<{ priority: FetchPriority; start: () => void }> = [];

function acquireSlot(priority: FetchPriority): Promise<void> {
  if (activeFetches < MAX_CONCURRENT_TILE_FETCHES) {
    activeFetches += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const entry = { priority, start: resolve };
    // Foreground jumps the whole background tail, but never another foreground request:
    // within one priority the queue stays first-come, so a load cannot be starved by a
    // later one of equal standing.
    const firstBackground = priority === 'foreground'
      ? waiting.findIndex((queued) => queued.priority === 'background')
      : -1;
    if (firstBackground >= 0) waiting.splice(firstBackground, 0, entry);
    else waiting.push(entry);
  });
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next.start();
  else activeFetches -= 1;
}

/**
 * Decoded features for `keys`, in key order, skipping any tile that failed.
 *
 * Throws only when *nothing* could be fetched — a genuine outage, a bad tile index, or a
 * cancelled load. Anything short of that is a partial world, which is exactly what the
 * renderer is built to handle: it already clips by draw distance and streams the rest in
 * as the camera moves.
 */
export async function fetchTileFeatures(
  keys: ChunkKey[],
  signal: AbortSignal,
  priority: FetchPriority = 'foreground',
): Promise<MapLibreFeature[]> {
  if (!keys.length) return [];
  const template = await resolveTileTemplate();
  const results = new Array<MapLibreFeature[] | null>(keys.length).fill(null);
  let failures = 0;
  let next = 0;

  const worker = async () => {
    while (next < keys.length) {
      const index = next;
      next += 1;
      const key = keys[index];
      const id = `${key.z}/${key.x}/${key.y}`;
      const cached = cache.get(id);
      if (cached) {
        diagnostics.cacheHits += 1;
        cache.delete(id);
        cache.set(id, cached);
        results[index] = cached;
        continue;
      }
      // Only an uncached fetch/decode pipeline holds a slot; a cache hit never queues.
      await acquireSlot(priority);
      try {
        // Committed tiles from scripts/prefetch-world.mjs are served at this path by
        // Vite's publicDir (vendor/). A miss here — a dev who hasn't run the script, or a
        // tile outside every shipped area's radius — falls through to the network exactly
        // as if this branch didn't exist; the local path is never required to succeed.
        const localUrl = `/worldcache/tiles/${key.z}/${key.x}/${key.y}.pbf`;
        let response: Response | undefined;
        try {
          response = await fetch(localUrl, { signal });
        } catch (error) {
          // An abort here is the caller withdrawing the whole request, same as the outer
          // catch below distinguishes it — rethrow so it doesn't get mistaken for a local
          // miss. Anything else (a service worker error, a blocked request, a proxy fault —
          // not just a 404) is exactly as recoverable as a non-OK response, so it falls
          // through to the network the same way.
          if (signal.aborted) throw error;
        }
        if (!response || !response.ok) {
          const url = template
            .replace('{z}', String(key.z))
            .replace('{x}', String(key.x))
            .replace('{y}', String(key.y));
          diagnostics.networkFetches += 1;
          response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`MapLibre vector request failed (${response.status})`);
        }
        let decoded;
        try {
          decoded = await vectorTileDecodeClient.decode(key, await response.arrayBuffer());
        } catch (error) {
          diagnostics.decodeFailures += 1;
          throw error;
        }
        const { features, mode } = decoded;
        diagnostics[mode === 'worker' ? 'workerDecodes' : 'fallbackDecodes'] += 1;
        if (signal.aborted) throw signal.reason;
        remember(id, features);
        results[index] = features;
      } catch (error) {
        // An abort is the caller withdrawing the whole request, not one bad tile —
        // rethrow so the load rejects promptly instead of grinding through the rest.
        if (signal.aborted) throw error;
        failures += 1;
      } finally {
        releaseSlot();
      }
    }
  };

  const lane = priority === 'background'
    ? MAX_CONCURRENT_BACKGROUND_FETCHES
    : MAX_CONCURRENT_TILE_FETCHES;
  await Promise.all(Array.from({ length: Math.min(lane, keys.length) }, worker));

  if (failures === keys.length) throw new Error(`Every vector tile request failed (${failures})`);
  return results.flatMap((features) => features ?? []);
}
