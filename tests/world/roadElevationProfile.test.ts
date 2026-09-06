import { describe, expect, it } from 'vitest';
import {
  bridgeDeckLift,
  BRIDGE_MIN_DECK_LIFT,
  buildRoadElevationProfiles,
  CROSSING_VERTICAL_CLEARANCE,
  findRoadCrossings,
  normalizeRoadStructure,
  resolveCrossing,
  roadElevationAtPoint,
  sampleRoadElevation,
  structureInfo,
  buildRoadElevationProfilesJob,
} from '../../src/world/roadElevationProfile';
import { buildTerrainIndex, computeTerrainClearance } from '../../src/world/terrain';
import type { WorldArea, WorldRoad } from '../../src/world/types';

describe('normalizeRoadStructure', () => {
  it('reads brunnel=bridge/tunnel/ford first', () => {
    expect(normalizeRoadStructure({ brunnel: 'bridge' }).structure).toBe('bridge');
    expect(normalizeRoadStructure({ brunnel: 'tunnel' }).structure).toBe('tunnel');
    expect(normalizeRoadStructure({ brunnel: 'ford' }).structure).toBe('ford');
  });

  it('falls back to boolean bridge/tunnel/ford tags when brunnel is absent', () => {
    expect(normalizeRoadStructure({ bridge: 'yes' }).structure).toBe('bridge');
    expect(normalizeRoadStructure({ tunnel: 'yes' }).structure).toBe('tunnel');
    expect(normalizeRoadStructure({ ford: 'yes' }).structure).toBe('ford');
  });

  it('defaults to ground/layer 0 for missing or unrecognized tags', () => {
    expect(normalizeRoadStructure(undefined)).toEqual({ structure: 'ground', layer: 0 });
    expect(normalizeRoadStructure({})).toEqual({ structure: 'ground', layer: 0 });
    expect(normalizeRoadStructure({ brunnel: 'nonsense' }).structure).toBe('ground');
  });

  it('parses a finite layer and ignores a non-numeric one', () => {
    expect(normalizeRoadStructure({ layer: '2' }).layer).toBe(2);
    expect(normalizeRoadStructure({ layer: 'not-a-number' }).layer).toBe(0);
  });

  it('bridge takes precedence over a conflicting boolean tunnel tag when brunnel says bridge', () => {
    expect(normalizeRoadStructure({ brunnel: 'bridge', tunnel: 'yes' }).structure).toBe('bridge');
  });
});

describe('structureInfo', () => {
  it('reads a road\'s own normalized fields, defaulting missing ones', () => {
    expect(structureInfo({ structure: 'bridge', layer: 1 })).toEqual({ structure: 'bridge', layer: 1 });
    expect(structureInfo({})).toEqual({ structure: 'ground', layer: 0 });
  });
});

describe('resolveCrossing', () => {
  it('ranks bridge above ground/ford above tunnel regardless of layer', () => {
    expect(resolveCrossing({ structure: 'bridge', layer: 0 }, { structure: 'ground', layer: 5 })).toBe('road');
    expect(resolveCrossing({ structure: 'ground', layer: 0 }, { structure: 'tunnel', layer: 5 })).toBe('road');
    expect(resolveCrossing({ structure: 'tunnel', layer: 5 }, { structure: 'bridge', layer: 0 })).toBe('other');
  });

  it('breaks a same-structure tie by layer', () => {
    expect(resolveCrossing({ structure: 'ground', layer: 1 }, { structure: 'ground', layer: 0 })).toBe('road');
    expect(resolveCrossing({ structure: 'bridge', layer: 2 }, { structure: 'bridge', layer: 3 })).toBe('other');
  });

  it('is unresolved when structure and layer both tie', () => {
    expect(resolveCrossing({ structure: 'ground', layer: 0 }, { structure: 'ground', layer: 0 })).toBe('unresolved');
  });
});

function crossRoads(): { bridge: WorldRoad; ground: WorldRoad } {
  return {
    bridge: {
      id: 'bridge-road', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: -50, z: 0 }, { x: 50, z: 0 }],
    },
    ground: {
      id: 'ground-road', kind: 'residential', width: 8, structure: 'ground', layer: 0,
      points: [{ x: 0, z: -50 }, { x: 0, z: 50 }],
    },
  };
}

describe('findRoadCrossings', () => {
  it('finds a perpendicular crossing between two roads with differing structure', () => {
    const { bridge, ground } = crossRoads();
    const crossings = findRoadCrossings([bridge, ground]);
    // One entry from each road's own perspective.
    expect(crossings).toHaveLength(2);
    const fromBridge = crossings.find((c) => c.roadId === 'bridge-road')!;
    expect(fromBridge.point.x).toBeCloseTo(0);
    expect(fromBridge.point.z).toBeCloseTo(0);
    expect(fromBridge.distanceAlong).toBeCloseTo(50);
    expect(fromBridge.resolution).toBe('road');
    const fromGround = crossings.find((c) => c.roadId === 'ground-road')!;
    expect(fromGround.resolution).toBe('other');
  });

  it('does not flag an ordinary at-grade crossing between two plain roads (no ordering evidence)', () => {
    const roadA: WorldRoad = { id: 'a', kind: 'residential', width: 8, points: [{ x: -50, z: 0 }, { x: 50, z: 0 }] };
    const roadB: WorldRoad = { id: 'b', kind: 'residential', width: 8, points: [{ x: 0, z: -50 }, { x: 0, z: 50 }] };
    expect(findRoadCrossings([roadA, roadB])).toHaveLength(0);
  });

  it('finds nothing for roads that never cross', () => {
    const { bridge } = crossRoads();
    const farAway: WorldRoad = { id: 'far', kind: 'residential', width: 8, structure: 'tunnel', layer: -1, points: [{ x: 500, z: -50 }, { x: 500, z: 50 }] };
    expect(findRoadCrossings([bridge, farAway])).toHaveLength(0);
  });
});

describe('buildRoadElevationProfiles', () => {
  it('lifts the bridge to clear the ground road\'s vehicle envelope at the crossing, and leaves the ground road untouched', () => {
    const { bridge, ground } = crossRoads();
    const profiles = buildRoadElevationProfiles([bridge, ground]);
    const bridgeProfile = profiles.get('bridge-road')!;
    const groundProfile = profiles.get('ground-road')!;

    const bridgeHeightAtCrossing = sampleRoadElevation(bridgeProfile, 50);
    const groundHeightAtCrossing = sampleRoadElevation(groundProfile, 50);
    expect(bridgeHeightAtCrossing - groundHeightAtCrossing).toBeGreaterThanOrEqual(CROSSING_VERTICAL_CLEARANCE - 1e-6);

    // The ground road passes underneath unmodified — it never gained a tunnel dig
    // because it wasn't tagged as one.
    expect(groundProfile.samples.every((s) => s.height === groundProfile.samples[0].height)).toBe(true);
  });

  it('digs a tunnel below whatever it resolves under', () => {
    const ground: WorldRoad = {
      id: 'ground-road', kind: 'primary', width: 10,
      points: [{ x: -50, z: 0 }, { x: 50, z: 0 }],
    };
    const tunnel: WorldRoad = {
      id: 'tunnel-road', kind: 'residential', width: 8, structure: 'tunnel', layer: -1,
      points: [{ x: 0, z: -50 }, { x: 0, z: 50 }],
    };
    const profiles = buildRoadElevationProfiles([ground, tunnel]);
    const groundHeight = sampleRoadElevation(profiles.get('ground-road')!, 50);
    const tunnelHeight = sampleRoadElevation(profiles.get('tunnel-road')!, 50);
    expect(groundHeight - tunnelHeight).toBeGreaterThanOrEqual(CROSSING_VERTICAL_CLEARANCE - 1e-6);
  });

  it('keeps approach ramps within the configured max grade', () => {
    const { bridge, ground } = crossRoads();
    const maxGrade = 0.06;
    const profiles = buildRoadElevationProfiles([bridge, ground], [], { maxGrade });
    const samples = profiles.get('bridge-road')!.samples;
    for (let i = 1; i < samples.length; i += 1) {
      const rise = Math.abs(samples[i].height - samples[i - 1].height);
      const run = Math.hypot(samples[i].point.x - samples[i - 1].point.x, samples[i].point.z - samples[i - 1].point.z);
      expect(rise / run).toBeLessThanOrEqual(maxGrade + 1e-9);
    }
  });

  it('extends the ramp beyond the tagged span rather than jumping straight down at the endpoint', () => {
    // A short bridge tag (just the crossing segment) still needs its neighbors, from a
    // longer surrounding way, to ramp down gradually rather than stepping.
    const bridge: WorldRoad = {
      id: 'bridge-road', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: -50, z: 0 }, { x: -5, z: 0 }, { x: 5, z: 0 }, { x: 50, z: 0 }],
    };
    const ground: WorldRoad = {
      id: 'ground-road', kind: 'residential', width: 8,
      points: [{ x: 0, z: -50 }, { x: 0, z: 50 }],
    };
    const profiles = buildRoadElevationProfiles([bridge, ground]);
    const samples = profiles.get('bridge-road')!.samples;
    // First and last point should have settled back toward ground level, not still be
    // at the lifted crossing height.
    expect(samples[0].height).toBeLessThan(samples[1].height);
    expect(samples[samples.length - 1].height).toBeLessThan(samples[samples.length - 2].height);
  });

  it('stands a tagged bridge off the ground even where nothing crosses beneath it', () => {
    // The common case in a city built on water: the bridge spans a channel, so the
    // crossing search finds no road under it at all and used to leave the deck lying flat
    // on the surface it was meant to carry traffic over.
    const bridge: WorldRoad = {
      id: 'over-water', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: 0, z: 0 }, { x: 120, z: 0 }],
    };
    const profile = buildRoadElevationProfiles([bridge])!.get('over-water')!;
    expect(profile).toBeDefined();
    for (const sample of profile.samples) {
      expect(sample.height).toBeGreaterThanOrEqual(BRIDGE_MIN_DECK_LIFT);
    }
  });

  it('scales a short span\'s lift to what its own length can ramp out, rather than to the ceiling', () => {
    // A six-metre footbridge over a ditch carries the same OSM tag as a viaduct. Lifting
    // it the full ceiling would push a 37m earthwork into the paths at both of its ends.
    const short: WorldRoad = {
      id: 'ditch', kind: 'residential', width: 4, structure: 'bridge',
      points: [{ x: 0, z: 0 }, { x: 6, z: 0 }],
    };
    const long: WorldRoad = {
      id: 'viaduct', kind: 'residential', width: 4, structure: 'bridge',
      points: [{ x: 0, z: 500 }, { x: 120, z: 500 }],
    };
    const profiles = buildRoadElevationProfiles([short, long]);
    const peak = (id: string) => Math.max(...profiles.get(id)!.samples.map((sample) => sample.height));
    expect(peak('ditch')).toBeLessThan(1);
    expect(peak('viaduct')).toBeGreaterThanOrEqual(BRIDGE_MIN_DECK_LIFT);
    // What the cap actually means: each approach is no longer than the span it serves.
    expect(bridgeDeckLift(6, 0.06) / 0.06).toBeLessThanOrEqual(6 + 1e-9);
  });

  it('leaves a crossing\'s own clearance in charge where it asks for more than the deck lift', () => {
    const { bridge, ground } = crossRoads();
    const profiles = buildRoadElevationProfiles([bridge, ground]);
    const atCrossing = sampleRoadElevation(profiles.get('bridge-road')!, 50);
    expect(atCrossing - sampleRoadElevation(profiles.get('ground-road')!, 50))
      .toBeGreaterThanOrEqual(CROSSING_VERTICAL_CLEARANCE - 1e-6);
    expect(atCrossing).toBeGreaterThan(BRIDGE_MIN_DECK_LIFT);
  });

  it('does not create a profile for either side of an ordinary at-grade junction (no evidence, nothing to resolve)', () => {
    const roadA: WorldRoad = { id: 'a', kind: 'residential', width: 8, points: [{ x: -50, z: 0 }, { x: 50, z: 0 }] };
    const roadB: WorldRoad = { id: 'b', kind: 'residential', width: 8, points: [{ x: 0, z: -50 }, { x: 0, z: 50 }] };
    const profiles = buildRoadElevationProfiles([roadA, roadB]);
    expect(profiles.size).toBe(0);
  });

  it('surfaces an unresolved crossing rather than guessing a height, when both sides tie on structure and layer', () => {
    // Two bridges on the same layer crossing each other: real separation evidence (both
    // are bridges, not ground), but nothing to decide which one is physically above.
    const bridgeA: WorldRoad = { id: 'bridge-a', kind: 'primary', width: 10, structure: 'bridge', layer: 1, points: [{ x: -50, z: 0 }, { x: 50, z: 0 }] };
    const bridgeB: WorldRoad = { id: 'bridge-b', kind: 'primary', width: 10, structure: 'bridge', layer: 1, points: [{ x: 0, z: -50 }, { x: 0, z: 50 }] };
    const profiles = buildRoadElevationProfiles([bridgeA, bridgeB]);
    expect(profiles.get('bridge-a')!.unresolvedCrossings).toHaveLength(1);
    expect(profiles.get('bridge-b')!.unresolvedCrossings).toHaveLength(1);
    expect(profiles.get('bridge-a')!.unresolvedCrossings[0].resolution).toBe('unresolved');
  });

  it('ramps the road a deck hands over to, so the two meet at the same height instead of at a cliff', () => {
    // The shape OSM actually produces: the bridge way is tagged over the span alone, far
    // shorter than the ~75m a 4.5m lift needs to ramp out at 6%, and ordinary streets
    // continue from each of its ends.
    const bridge: WorldRoad = {
      id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: -15, z: 0 }, { x: 15, z: 0 }],
    };
    const under: WorldRoad = {
      id: 'under', kind: 'residential', width: 8,
      points: [{ x: 0, z: -50 }, { x: 0, z: 50 }],
    };
    const approach: WorldRoad = {
      id: 'approach', kind: 'primary', width: 10,
      points: [{ x: 15, z: 0 }, { x: 200, z: 0 }],
    };
    const profiles = buildRoadElevationProfiles([bridge, under, approach]);

    const deckEnd = sampleRoadElevation(profiles.get('span')!, 30);
    // The approach was a plain, evidence-free road: it only has a profile at all because
    // the deck's lift has to ramp out through it.
    const approachProfile = profiles.get('approach')!;
    expect(approachProfile.samples[0].height).toBeCloseTo(deckEnd, 6);
    // ...and it gets back to street level by its far end rather than staying up.
    expect(approachProfile.samples[approachProfile.samples.length - 1].height).toBeLessThan(0.5);
  });

  it('carries the ramp through a chain of ways, still within the max grade at every step', () => {
    const bridge: WorldRoad = {
      id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: -15, z: 0 }, { x: 15, z: 0 }],
    };
    const under: WorldRoad = { id: 'under', kind: 'residential', width: 8, points: [{ x: 0, z: -50 }, { x: 0, z: 50 }] };
    // Two short ways in sequence off the deck's east end — neither is long enough on its
    // own to absorb the lift, so the second only settles if the first passed it on.
    const first: WorldRoad = { id: 'first', kind: 'primary', width: 10, points: [{ x: 15, z: 0 }, { x: 45, z: 0 }] };
    const second: WorldRoad = { id: 'second', kind: 'primary', width: 10, points: [{ x: 45, z: 0 }, { x: 200, z: 0 }] };
    const maxGrade = 0.06;
    const profiles = buildRoadElevationProfiles([bridge, under, first, second], [], { maxGrade });

    expect(profiles.has('second')).toBe(true);
    const firstProfile = profiles.get('first')!;
    const secondProfile = profiles.get('second')!;
    expect(secondProfile.samples[0].height).toBeCloseTo(firstProfile.samples[firstProfile.samples.length - 1].height, 6);

    for (const profile of profiles.values()) {
      for (let index = 1; index < profile.samples.length; index += 1) {
        const previous = profile.samples[index - 1];
        const current = profile.samples[index];
        const run = current.distanceAlong - previous.distanceAlong;
        expect(Math.abs(current.height - previous.height) / run).toBeLessThanOrEqual(maxGrade + 1e-9);
      }
    }
  });

  it('does not flatten a crossing into a junction: roads that cross without sharing a node stay separated', () => {
    // The two roads cross at (0,0) but neither has a vertex there — which is exactly how
    // OSM records grade separation. The ramp propagation keys off shared vertices, so it
    // must not treat this as a place the two have to agree on a height.
    const { bridge, ground } = crossRoads();
    const profiles = buildRoadElevationProfiles([bridge, ground]);
    const groundProfile = profiles.get('ground-road')!;
    expect(groundProfile.samples.every((sample) => sample.height === groundProfile.samples[0].height)).toBe(true);
    expect(sampleRoadElevation(profiles.get('bridge-road')!, 50) - groundProfile.samples[0].height)
      .toBeGreaterThanOrEqual(CROSSING_VERTICAL_CLEARANCE - 1e-6);
  });

  it('keeps the grade limit rather than the connection when a junction is over-constrained', () => {
    // Real Stockholm data contains junctions where a dig and a lift meet within a few
    // metres of each other - a footpath ducking under one road and climbing onto a bridge
    // deck almost immediately after. No profile can satisfy both at maxGrade: the data is
    // asking for several metres of climb inside a few metres of run. When that happens the
    // upper bound (the clearance something else needs to pass underneath) wins and the
    // connection does not, which is the conservative half to keep - a deck end that does
    // not line up looks wrong, but a dig that quietly fills in puts a road through
    // whatever was passing under it.
    const tunnel: WorldRoad = {
      id: 'tunnel', kind: 'residential', width: 8, structure: 'tunnel', layer: -1,
      points: [{ x: -40, z: 0 }, { x: -4, z: 0 }],
    };
    const over: WorldRoad = { id: 'over', kind: 'primary', width: 10, points: [{ x: -20, z: -40 }, { x: -20, z: 40 }] };
    // Joins the tunnel's own east end, then reaches a bridge deck four metres later.
    const link: WorldRoad = { id: 'link', kind: 'path', width: 3, points: [{ x: -4, z: 0 }, { x: 0, z: 0 }] };
    const deck: WorldRoad = {
      id: 'deck', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: 0, z: 0 }, { x: 60, z: 0 }],
    };
    const under: WorldRoad = { id: 'under', kind: 'residential', width: 8, points: [{ x: 30, z: -40 }, { x: 30, z: 40 }] };

    const maxGrade = 0.06;
    const profiles = buildRoadElevationProfiles([tunnel, over, link, deck, under], [], { maxGrade });

    // The grade limit holds everywhere, which is the guarantee being protected...
    for (const profile of profiles.values()) {
      for (let index = 1; index < profile.samples.length; index += 1) {
        const run = profile.samples[index].distanceAlong - profile.samples[index - 1].distanceAlong;
        if (run < 1e-9) continue;
        const rise = Math.abs(profile.samples[index].height - profile.samples[index - 1].height);
        expect(rise / run).toBeLessThanOrEqual(maxGrade + 1e-9);
      }
    }
    // ...and the tunnel still clears the road passing over it, rather than being filled in
    // by the deck's ramp reaching back through the link.
    const tunnelProfile = profiles.get('tunnel')!;
    expect(Math.min(...tunnelProfile.samples.map((sample) => sample.height))).toBeLessThan(0);
  });

  it('leaves an ordinary junction alone: a road at its own ground level propagates nothing', () => {
    // A bridge somewhere else in the snapshot must not drag every street that happens to
    // share a node with another street into the profile map.
    const bridge: WorldRoad = {
      id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: 900, z: 0 }, { x: 940, z: 0 }],
    };
    const streetA: WorldRoad = { id: 'a', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] };
    const streetB: WorldRoad = { id: 'b', kind: 'residential', width: 8, points: [{ x: 50, z: 0 }, { x: 50, z: 50 }] };
    const profiles = buildRoadElevationProfiles([bridge, streetA, streetB]);
    expect(profiles.has('a')).toBe(false);
    expect(profiles.has('b')).toBe(false);
  });

  it('is deterministic: rebuilding from the same input yields identical profiles regardless of road order', () => {
    const { bridge, ground } = crossRoads();
    const first = buildRoadElevationProfiles([bridge, ground]);
    const second = buildRoadElevationProfiles([ground, bridge]);
    for (const id of ['bridge-road', 'ground-road']) {
      expect(second.get(id)!.samples.map((s) => s.height)).toEqual(first.get(id)!.samples.map((s) => s.height));
    }
  });

  it('relaxes ramps to the same heights whichever road the propagation starts from', () => {
    const span: WorldRoad = {
      id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: -15, z: 0 }, { x: 15, z: 0 }],
    };
    const under: WorldRoad = { id: 'under', kind: 'residential', width: 8, points: [{ x: 0, z: -50 }, { x: 0, z: 50 }] };
    const east: WorldRoad = { id: 'east', kind: 'primary', width: 10, points: [{ x: 15, z: 0 }, { x: 120, z: 0 }] };
    const west: WorldRoad = { id: 'west', kind: 'primary', width: 10, points: [{ x: -120, z: 0 }, { x: -15, z: 0 }] };

    const forward = buildRoadElevationProfiles([span, under, east, west]);
    const reversed = buildRoadElevationProfiles([west, east, under, span]);
    expect([...reversed.keys()].sort()).toEqual([...forward.keys()].sort());
    for (const id of forward.keys()) {
      expect(reversed.get(id)!.samples.map((s) => s.height)).toEqual(forward.get(id)!.samples.map((s) => s.height));
    }
  });
});

describe('sampleRoadElevation', () => {
  it('interpolates linearly between samples and clamps at the ends', () => {
    const profile = {
      roadId: 'r', structure: 'ground' as const, layer: 0, width: 8, unresolvedCrossings: [],
      samples: [
        { distanceAlong: 0, point: { x: 0, z: 0 }, height: 1 },
        { distanceAlong: 10, point: { x: 10, z: 0 }, height: 3 },
      ],
    };
    expect(sampleRoadElevation(profile, 5)).toBeCloseTo(2);
    expect(sampleRoadElevation(profile, -5)).toBe(1);
    expect(sampleRoadElevation(profile, 50)).toBe(3);
  });
});

describe('roadElevationAtPoint', () => {
  it('returns the profiled height for a point on a road\'s paved surface', () => {
    const { bridge, ground } = crossRoads();
    const profiles = buildRoadElevationProfiles([bridge, ground]);
    const height = roadElevationAtPoint(0, 0, profiles);
    expect(height).not.toBeNull();
    // At the crossing, the higher (bridge) surface wins.
    const bridgeHeightAtCrossing = sampleRoadElevation(profiles.get('bridge-road')!, 50);
    expect(height).toBeCloseTo(bridgeHeightAtCrossing, 1);
  });

  it('selects the lower road beneath a bridge and the deck when already on it', () => {
    const { bridge, ground } = crossRoads();
    const profiles = buildRoadElevationProfiles([bridge, ground]);
    expect(roadElevationAtPoint(0, 0, profiles, 0, 0.5)).toBeCloseTo(0.14);
    expect(roadElevationAtPoint(0, 0, profiles, 0, 6)).toBeGreaterThan(4);
  });

  it('supports the rendered endpoint overlap without inventing pavement beyond its cap', () => {
    const { bridge } = crossRoads();
    const profiles = buildRoadElevationProfiles([bridge]);
    expect(roadElevationAtPoint(54, 4, profiles)).toBeGreaterThan(2);
    expect(roadElevationAtPoint(56, 0, profiles)).toBeNull();
  });

  it('returns null far from every road', () => {
    const { bridge, ground } = crossRoads();
    const profiles = buildRoadElevationProfiles([bridge, ground]);
    expect(roadElevationAtPoint(1000, 1000, profiles)).toBeNull();
  });
});

describe('the terrain index option', () => {
  // The ground query behind these profiles runs once per point of every road profiled,
  // and a linear scan per query was the dominant cost of the whole step — see
  // docs/performance/2026-09-04-road-elevation-terrain-index.md. The option exists so a
  // caller that already holds an index does not build a second one; what must not change
  // is the answer.
  const parks: WorldArea[] = [];
  for (let index = 0; index < 24; index += 1) {
    const x = -300 + (index % 6) * 120;
    const z = -300 + Math.floor(index / 6) * 120;
    parks.push({
      id: `wood${index}`,
      kind: index % 2 === 0 ? 'forest' : 'park',
      rings: [[{ x, z }, { x: x + 90, z }, { x: x + 90, z: z + 90 }, { x, z: z + 90 }]],
    });
  }
  const terrain = computeTerrainClearance(parks);

  const roads: WorldRoad[] = [
    { id: 'span', kind: 'primary', width: 12, structure: 'bridge', layer: 1,
      points: [{ x: -40, z: 0 }, { x: 0, z: 0 }, { x: 40, z: 0 }] },
    { id: 'under', kind: 'residential', width: 8, points: [{ x: 0, z: -120 }, { x: 0, z: 120 }] },
    { id: 'approach', kind: 'primary', width: 12, points: [{ x: 40, z: 0 }, { x: 260, z: 0 }] },
  ];

  it('gives byte-identical profiles whether the index is supplied or built internally', () => {
    const internal = buildRoadElevationProfiles(roads, terrain);
    const supplied = buildRoadElevationProfiles(roads, terrain, { terrainIndex: buildTerrainIndex(terrain) });
    expect([...supplied.keys()].sort()).toEqual([...internal.keys()].sort());
    for (const [roadId, profile] of internal) {
      expect(supplied.get(roadId)!.samples, roadId).toEqual(profile.samples);
    }
  });

  it('actually reads the terrain — a road over a mound sits above one on flat ground', () => {
    // Guards the plumbing against the failure that would make the test above pass
    // vacuously: an index that answered 0 everywhere.
    const overMound = buildRoadElevationProfiles(roads, terrain, { terrainIndex: buildTerrainIndex(terrain) });
    const onFlat = buildRoadElevationProfiles(roads, []);
    const highest = (profiles: ReturnType<typeof buildRoadElevationProfiles>) =>
      Math.max(...(profiles.get('under')?.samples ?? []).map((sample) => sample.height));
    expect(highest(overMound)).toBeGreaterThan(highest(onFlat));
  });
});

describe('slicing the build', () => {
  // This is the largest single step in the road phase, and CLAUDE.md's invariant is that
  // build work stays sliced — heavy work between two yields is a dropped frame. See
  // docs/performance/2026-09-04-road-elevation-slicing.md for the measured before/after.
  function corridor(count: number): WorldRoad[] {
    const roads: WorldRoad[] = [];
    for (let index = 0; index < count; index += 1) {
      const z = index * 12;
      roads.push({
        id: `ew${index}`, kind: 'residential', width: 8,
        points: [{ x: -400, z }, { x: 0, z }, { x: 400, z }],
      });
    }
    // Short spans, as OSM actually tags them, each crossing the ways beneath it.
    for (let index = 0; index < Math.max(1, Math.floor(count / 8)); index += 1) {
      const x = -300 + index * 90;
      roads.push({
        id: `br${index}`, kind: 'primary', width: 12, structure: 'bridge', layer: 1,
        points: [{ x, z: -40 }, { x, z: count * 6 }, { x, z: count * 12 + 40 }],
      });
    }
    return roads;
  }

  it('returns exactly what running it whole returns', () => {
    // The eager function drains this same generator, so what is really being checked is
    // that stopping and resuming at a yield cannot leave half-applied state behind.
    const roads = corridor(40);
    const job = buildRoadElevationProfilesJob(roads);
    let step = job.next();
    let yields = 0;
    while (!step.done) {
      yields += 1;
      step = job.next();
    }
    expect(yields).toBeGreaterThan(1);

    const eager = buildRoadElevationProfiles(roads);
    expect([...step.value.keys()].sort()).toEqual([...eager.keys()].sort());
    for (const [roadId, profile] of eager) {
      expect(step.value.get(roadId)!.samples, roadId).toEqual(profile.samples);
    }
  });

  it('yields more often on more roads, so the loops are sliced and not just the phases', () => {
    const countYields = (roads: WorldRoad[]) => {
      const job = buildRoadElevationProfilesJob(roads);
      let yields = 0;
      for (let step = job.next(); !step.done; step = job.next()) yields += 1;
      return yields;
    };
    // A fixed set of phase boundaries would give the same count either way.
    expect(countYields(corridor(700))).toBeGreaterThan(countYields(corridor(40)));
  });
});

describe('stacked bridge clearance', () => {
  it('clears the lower deck rather than its terrain baseline regardless of input order', () => {
    const { bridge, ground } = crossRoads();
    const lower = { ...ground, structure: 'bridge' as const, layer: 1 };
    const upper = { ...bridge, layer: 2 };
    for (const roads of [[lower, upper], [upper, lower]]) {
      const profiles = buildRoadElevationProfiles(roads);
      const low = sampleRoadElevation(profiles.get(lower.id)!, 50);
      const high = sampleRoadElevation(profiles.get(upper.id)!, 50);
      expect(high - low).toBeGreaterThanOrEqual(CROSSING_VERTICAL_CLEARANCE - 0.001);
    }
  });
});

describe('bent bridge footprint', () => {
  it('supports the outer miter and excludes the empty inner corner', () => {
    const road: WorldRoad = { id: 'bend', kind: 'primary', structure: 'bridge', width: 10,
      points: [{ x: -30, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 30 }] };
    const profiles = buildRoadElevationProfiles([road]);
    expect(roadElevationAtPoint(4, -4, profiles)).toBeGreaterThan(2);
    expect(roadElevationAtPoint(-6, 6, profiles)).toBeNull();
  });
});
