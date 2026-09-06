import { describe, expect, it, vi } from 'vitest';
import { resolveBusRoute } from '../../src/svartaksi/busCorridor';
import { START_LOCATION } from '../../src/svartaksi/config';
import { localToLngLat } from '../../src/world/geo';
import type { WorldData, WorldDataProvider } from '../../src/world/types';

function emptyWorld(roads: WorldData['roads']): WorldData {
  return { source: 'maplibre', roads, buildings: [], water: [], parks: [], labels: [], objects: [] };
}

function stubProvider(data: WorldData | Error): WorldDataProvider & { load: ReturnType<typeof vi.fn> } {
  const load = vi.fn(() => (data instanceof Error ? Promise.reject(data) : Promise.resolve(data)));
  return { source: 'maplibre', load } as unknown as WorldDataProvider & { load: ReturnType<typeof vi.fn> };
}

const at = (x: number, z: number) => localToLngLat(START_LOCATION, { x, z });

describe('resolveBusRoute', () => {
  it('routes over the fetched corridor and reports length and ETA', async () => {
    const provider = stubProvider(emptyWorld([
      { id: 'a', kind: 'street', width: 9, points: [{ x: 0, z: 0 }, { x: 300, z: 0 }] },
    ]));

    const result = await resolveBusRoute(at(0, 0), at(300, 0), new AbortController().signal, provider);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lengthMeters).toBeCloseTo(300, 0);
    expect(result.etaSeconds).toBeGreaterThan(0);
    expect(provider.load).toHaveBeenCalledTimes(1);
  });

  it('fetches a corridor that covers both picks with padding', async () => {
    const provider = stubProvider(emptyWorld([
      { id: 'a', kind: 'street', width: 9, points: [{ x: 0, z: 0 }, { x: 1000, z: 0 }] },
    ]));

    await resolveBusRoute(at(0, 0), at(1000, 0), new AbortController().signal, provider);

    const [center, radius, , , corridor] = provider.load.mock.calls[0];
    // Centered between the picks, and reaching past both of them.
    expect(center.lng).toBeGreaterThan(at(0, 0).lng);
    expect(center.lng).toBeLessThan(at(1000, 0).lng);
    expect(radius.terrain).toBeGreaterThan(500);
    // A provider that understands corridors gets the route itself, so it can fetch the
    // ribbon along it rather than the much larger disc the radius describes.
    expect(corridor.from).toEqual(at(0, 0));
    expect(corridor.to).toEqual(at(1000, 0));
    expect(corridor.padMeters).toBeGreaterThan(0);
    // Buildings are irrelevant to routing; asking for them would be pure waste.
    expect(radius.buildings).toBeLessThan(10);
  });

  it('reports signalised stops the route crosses', async () => {
    const provider = stubProvider(emptyWorld([
      { id: 'main', kind: 'primary', width: 14, points: [{ x: -60, z: 0 }, { x: 300, z: 0 }] },
      { id: 'side', kind: 'residential', width: 9, points: [{ x: 0, z: -60 }, { x: 0, z: 60 }] },
    ]));

    const result = await resolveBusRoute(at(-60, 0), at(300, 0), new AbortController().signal, provider);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signalStops).toHaveLength(1);
    expect(result.signalStops[0].traveledMeters).toBeGreaterThan(0);
    expect(result.signalStops[0].traveledMeters).toBeLessThan(result.lengthMeters);
  });

  it('reports no-route when the picks are on disconnected roads', async () => {
    const provider = stubProvider(emptyWorld([
      { id: 'a', kind: 'street', width: 9, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] },
      { id: 'b', kind: 'street', width: 9, points: [{ x: 0, z: 900 }, { x: 100, z: 900 }] },
    ]));

    const result = await resolveBusRoute(at(0, 0), at(100, 900), new AbortController().signal, provider);

    expect(result).toEqual({ ok: false, reason: 'no-route' });
  });

  it('reports no-route when the corridor contains no roads at all', async () => {
    const result = await resolveBusRoute(at(0, 0), at(100, 0), new AbortController().signal, stubProvider(emptyWorld([])));

    expect(result).toEqual({ ok: false, reason: 'no-route' });
  });

  it('reports fetch-failed when the provider rejects', async () => {
    const result = await resolveBusRoute(at(0, 0), at(100, 0), new AbortController().signal, stubProvider(new Error('tile 503')));

    expect(result).toEqual({ ok: false, reason: 'fetch-failed' });
  });
});
