#!/usr/bin/env node
// scripts/prefetch-world.mjs
//
// Fetches and commits the vector tiles the game's shipped areas need, and — separately —
// turns committed tiles into precomputed WorldData JSON for those same areas. See
// docs/superpowers/specs/2026-08-05-world-prefetch-design.md for why this exists and the
// two-manifest layout below.
//
// Usage: node scripts/prefetch-world.mjs -- [options]   (see --help)

import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseOptions, usage } from './lib/prefetchOptions.mjs';
import { roundWorldData, slugify } from './lib/prefetchTransform.mjs';

const TILE_INDEX_URL = 'https://tiles.openfreemap.org/planet';

// Deviation from the brief: the brief's inline sample used
// `createServer({ server: { middlewareMode: true } })`, which never binds a port. The
// production code this script reuses (vectorTileSource.ts's local-tile-first branch)
// calls `fetch('/worldcache/tiles/.../....pbf')` — a path-only URL that a browser
// resolves against the current page's origin, but Node's fetch has no such origin and
// throws synchronously instead of returning a rejected response. That throw skips past
// the network-fallback branch entirely, so every tile "fails" even when both the local
// file and the network are fine. Running a real, listening dev server and rewriting
// path-only fetch calls against its origin lets the unmodified production code work as
// it does in the browser.
async function loadProductionModules(offline) {
  const server = await createServer({ appType: 'custom', server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite dev server did not bind to a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) return originalFetch(`${baseUrl}${input}`, init);
    // A path-only URL above is the local-tile-cache rewrite (or any other local dev-server
    // request) and is always allowed. Anything else reaching here is a real network
    // request — the world-data stage's mapLibreProvider.load falls through to exactly this
    // when a tile isn't in the local cache, same as fetchTileFeatures does in the browser.
    // --offline is supposed to make that impossible; acquireTiles enforces it for the
    // tile-acquisition stage, but the world-data stage never went through acquireTiles at
    // all under --emit world. This is the one chokepoint every fetch in the process passes
    // through, so it is where the constraint actually gets enforced for both stages.
    if (offline) {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      // fetchTileFeatures (vectorTileSource.ts) resolves the tiles.openfreemap.org TileJSON
      // index unconditionally, before it even looks at which tiles are cached locally — so
      // a fully-cached area (every tile a local hit) would still trip the offline guard on
      // this one small, stable document, even though it never ends up building a single
      // real tile URL from it. Answer it locally instead of forwarding it or rejecting it:
      // a run with every tile cached stays genuinely network-free, and a run that does hit
      // an actual missing tile still fails here, at the per-tile fetch this template feeds,
      // exactly as intended.
      if (url === TILE_INDEX_URL) {
        return Promise.resolve(new Response(
          JSON.stringify({ tiles: [`${TILE_INDEX_URL}/{z}/{x}/{y}.pbf`] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ));
      }
      return Promise.reject(new Error(`--offline set and a network fetch was attempted: ${url}`));
    }
    return originalFetch(input, init);
  };
  try {
    const config = await server.ssrLoadModule('/src/svartaksi/config.ts');
    const geo = await server.ssrLoadModule('/src/world/geo.ts');
    const provider = await server.ssrLoadModule('/src/world/providers/maplibreProvider.ts');
    const runtime = await server.ssrLoadModule('/src/svartaksi/svartaksiRuntime.tsx');
    return {
      config, geo, provider, runtime,
      async close() {
        globalThis.fetch = originalFetch;
        await server.close();
      },
    };
  } catch (error) {
    globalThis.fetch = originalFetch;
    await server.close();
    throw error;
  }
}

/** One radial area per TELEPORT_LOCATIONS entry, plus one corridor area for the opening
 * ride — see the design spec's Areas section. This is the full set of regions the game
 * ships tiles for; not all of them get a precomputed WorldData area (see
 * buildPrecomputedAreaSlugs below). */
function buildTileRegionDescriptors({ config }) {
  const radial = config.TELEPORT_LOCATIONS.map((location) => ({
    slug: slugify(location.label),
    center: { lng: location.lng, lat: location.lat },
    corridor: undefined,
  }));
  const corridor = {
    slug: `${slugify(config.OPENING_RIDE.destinationName)}-corridor`,
    center: config.OPENING_RIDE.from,
    corridor: {
      from: config.OPENING_RIDE.from,
      to: config.OPENING_RIDE.to,
      padMeters: config.WORLD_DATA_RADIUS.buildings,
    },
  };
  return [...radial, corridor];
}

/**
 * Slugs of tile regions that are also reachable as a precomputed WorldData area, keyed to
 * match what svartaksiRuntime.tsx's loadWorld actually requests on initial load
 * (worldCacheKey('maplibre', START_LOCATION)).
 *
 * Every TELEPORT_LOCATIONS entry and the opening-ride corridor still get their tiles
 * fetched and committed (see buildTileRegionDescriptors and acquireTiles, keyed by tile
 * coordinate, not by area) because the runtime's local-tile-first hook
 * (vectorTileSource.ts) benefits from any committed tile regardless of area. But
 * svartaksiRuntime.tsx's other loadWorld call sites never request a *precomputed-area* key
 * other than this one: teleporting loads through the same START_LOCATION-anchored path
 * (the origin hazard rule pins every load to START_LOCATION as origin, not as center —
 * this is a separate point), the streaming discs are centered on a camera-ahead predicted
 * point that moves continuously, and the bus corridor legs are centered on a moving
 * lookahead point along the route, never on OPENING_RIDE.from directly. None of those keys
 * are fixed, so no precomputed area for them could ever match via lookupPrecomputedArea —
 * generating them was ~45MB of dead payload per deploy that nothing could ever read back.
 */
function buildPrecomputedAreaSlugs({ config }) {
  return new Set([slugify(config.START_LOCATION_NAME)]);
}

function tileIndexPath(outputDir, key) {
  return resolve(outputDir, 'tiles', String(key.z), String(key.x), `${key.y}.pbf`);
}

async function readLocalTile(outputDir, key) {
  try {
    return await readFile(tileIndexPath(outputDir, key));
  } catch {
    return null;
  }
}

async function resolveTileTemplate() {
  const response = await fetch(TILE_INDEX_URL);
  if (!response.ok) throw new Error(`Tile index fetch failed (${response.status})`);
  const tileJson = await response.json();
  const template = tileJson.tiles?.[0];
  if (!template) throw new Error('Tile index returned no tile URL');
  return template;
}

/** Fetches (or reads locally) every tile `keys` names, writing any newly-fetched tile to
 * disk. Local-first, same precedence as the runtime's own hook — see the design spec. */
async function acquireTiles(keys, options, tileState) {
  const { outputDir, offline, concurrency, dryRun } = options;
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next];
      next += 1;
      const id = `${key.z}/${key.x}/${key.y}`;
      if (tileState.seen.has(id)) continue;
      tileState.seen.add(id);
      const existing = await readLocalTile(outputDir, key);
      if (existing) {
        tileState.acquired.set(id, existing);
        continue;
      }
      if (offline) throw new Error(`--offline set and tile ${id} is not in the local cache`);
      if (dryRun) {
        tileState.wouldFetch.add(id);
        continue;
      }
      const template = tileState.template ?? (tileState.template = await resolveTileTemplate());
      const url = template.replace('{z}', String(key.z)).replace('{x}', String(key.x)).replace('{y}', String(key.y));
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Tile fetch failed for ${id} (${response.status})`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const path = tileIndexPath(outputDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer);
      tileState.acquired.set(id, buffer);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length || 1) }, worker));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const options = parseOptions(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const { config, geo, provider, runtime, close } = await loadProductionModules(options.offline);
  try {
    const origin = options.origin ?? config.START_LOCATION;
    const regions = buildTileRegionDescriptors({ config });
    const precomputedSlugs = buildPrecomputedAreaSlugs({ config });
    const selected = options.areas === 'all' ? regions : regions.filter((region) => options.areas.includes(region.slug));
    if (options.areas !== 'all') {
      const missing = options.areas.filter((slug) => !regions.some((region) => region.slug === slug));
      if (missing.length) throw new Error(`Unknown --areas slug(s): ${missing.join(', ')}`);
    }

    const radius = { buildings: options.radiusBuildings, terrain: options.radiusTerrain };
    const tileState = { seen: new Set(), acquired: new Map(), wouldFetch: new Set(), template: null };
    const tileEntries = [];
    const areaEntries = [];

    for (const area of selected) {
      const keys = area.corridor
        ? geo.getCorridorChunkKeys(area.corridor.from, area.corridor.to, area.corridor.padMeters, options.zoom).slice(0, options.corridorMaxTiles)
        : geo.getChunkKeys(area.center, radius.terrain, options.zoom).slice(0, options.maxTiles);

      if (options.emit !== 'world') {
        await acquireTiles(keys, options, tileState);
        for (const key of keys) tileEntries.push(key);
      }

      if (options.emit !== 'tiles' && !options.dryRun && precomputedSlugs.has(area.slug)) {
        // Reuses the production pipeline end to end: fetchTileFeatures reads whatever
        // acquireTiles just wrote to disk instead of hitting the network again, because the
        // runtime's own local-tile-first hook (vectorTileSource.ts) checks the same
        // vendor/worldcache/tiles path this script writes to.
        const mapLibreProvider = provider.createMapLibreProvider();
        const data = await mapLibreProvider.load(
          area.center, radius, new AbortController().signal, origin, area.corridor, 'foreground',
        );
        const rounded = roundWorldData(data, options.precisionCm);
        const key = runtime.worldCacheKey('maplibre', area.center, area.corridor);
        const file = `${area.slug}.json`;
        await writeJson(resolve(options.outputDir, 'areas', file), rounded);
        areaEntries.push({ key, origin, file });
      } else if (options.emit !== 'tiles' && !options.dryRun && !precomputedSlugs.has(area.slug)) {
        console.log(`Skipping precomputed WorldData for '${area.slug}': not reachable via any runtime loadWorld call, so no area would ever be generated for it.`);
      }
    }

    if (options.dryRun) {
      const precomputedCount = options.emit === 'tiles'
        ? 0
        : selected.filter((region) => precomputedSlugs.has(region.slug)).length;
      console.log(
        `Would fetch ${tileState.wouldFetch.size} tile(s) across ${selected.length} region(s), `
        + `and would generate ${precomputedCount} precomputed area(s).`,
      );
      return;
    }

    if (options.emit !== 'world') {
      await writeJson(resolve(options.outputDir, 'tiles', 'manifest.json'), {
        generatedAt: new Date().toISOString(),
        zoom: options.zoom,
        tiles: [...new Set(tileEntries.map((key) => `${key.z}/${key.x}/${key.y}`))],
      });
    }
    if (options.emit !== 'tiles') {
      await writeJson(resolve(options.outputDir, 'areas', 'manifest.json'), {
        generatedAt: new Date().toISOString(),
        entries: areaEntries,
      });
    }
    console.log(`Wrote ${tileEntries.length} tile reference(s) and ${areaEntries.length} area(s) to ${options.outputDir}`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
