import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createTrafficLights,
  findRouteSignalStops,
  findTrafficSignals,
  nextBlockingSignalStop,
  resolveSignalAspect,
  SIGNAL_AMBER_SECONDS,
  SIGNAL_CYCLE_SECONDS,
  SIGNAL_GREEN_SECONDS,
  type TrafficSignal,
} from '../../src/svartaksi/trafficLights';
import type { LocalPoint, WorldRoad } from '../../src/world/types';

const signal = (overrides: Partial<TrafficSignal> = {}): TrafficSignal => ({
  x: 0, z: 0, yaw: 0, group: 0, offsetSeconds: 0, ...overrides,
});

/** A crossroads: one primary running east-west, one residential running north-south. */
function crossroads(atX = 0, atZ = 0, suffix = ''): WorldRoad[] {
  return [
    {
      id: `main${suffix}`, kind: 'primary', width: 14,
      points: [{ x: atX - 60, z: atZ }, { x: atX, z: atZ }, { x: atX + 60, z: atZ }],
    },
    {
      id: `side${suffix}`, kind: 'residential', width: 9,
      points: [{ x: atX, z: atZ - 60 }, { x: atX, z: atZ }, { x: atX, z: atZ + 60 }],
    },
  ];
}

describe('resolveSignalAspect', () => {
  it('runs green, then amber, then red within one cycle', () => {
    const head = signal();
    expect(resolveSignalAspect(head, 0)).toBe('green');
    expect(resolveSignalAspect(head, SIGNAL_GREEN_SECONDS - 0.1)).toBe('green');
    expect(resolveSignalAspect(head, SIGNAL_GREEN_SECONDS + 0.1)).toBe('amber');
    expect(resolveSignalAspect(head, SIGNAL_GREEN_SECONDS + SIGNAL_AMBER_SECONDS + 0.1)).toBe('red');
  });

  it('never shows green to both groups at once', () => {
    const a = signal({ group: 0 });
    const b = signal({ group: 1 });
    for (let t = 0; t < SIGNAL_CYCLE_SECONDS; t += 0.25) {
      const both = resolveSignalAspect(a, t) !== 'red' && resolveSignalAspect(b, t) !== 'red';
      expect([t, both]).toEqual([t, false]);
    }
  });

  it('repeats exactly once per cycle, and handles a clock behind its own offset', () => {
    const head = signal({ offsetSeconds: 7.5 });
    expect(resolveSignalAspect(head, 3)).toBe(resolveSignalAspect(head, 3 + SIGNAL_CYCLE_SECONDS));
    // A negative phase must wrap forward, not fall off the end of the cycle.
    expect(['red', 'amber', 'green']).toContain(resolveSignalAspect(head, -100));
  });
});

describe('findTrafficSignals', () => {
  it('signals a big crossing, one head per approach', () => {
    const signals = findTrafficSignals(crossroads(), 64);

    expect(signals).toHaveLength(4);
    expect(signals.filter((head) => head.group === 0)).toHaveLength(2);
    expect(signals.filter((head) => head.group === 1)).toHaveLength(2);
    // Every head shares the junction's cycle offset — they are one junction, not four.
    expect(new Set(signals.map((head) => head.offsetSeconds)).size).toBe(1);
    // ...and each stands back from the junction rather than in the middle of it.
    for (const head of signals) {
      expect(Math.hypot(head.x, head.z)).toBeGreaterThan(5);
      expect(Math.hypot(head.x, head.z)).toBeLessThan(20);
    }
  });

  it('ignores a junction with no major road, and a road crossing nothing', () => {
    const minorOnly = crossroads().map((road) => ({ ...road, kind: 'residential' }));
    expect(findTrafficSignals(minorOnly, 64)).toHaveLength(0);

    expect(findTrafficSignals([crossroads()[0]], 64)).toHaveLength(0);
  });

  it('leaves a main road crossed by a back lane unsignalled', () => {
    // A driveway or service road off a main road is not a signalised junction, however
    // major the road it joins — signalling those put four heads on every car park exit.
    const lane = crossroads();
    lane[1] = { ...lane[1], kind: 'service', width: 4.5 };
    expect(findTrafficSignals(lane, 64)).toHaveLength(0);

    // A proper two-lane side street crossing the same road still counts.
    expect(findTrafficSignals(crossroads(), 64)).toHaveLength(4);
  });

  it('ignores two roads that merely run alongside each other', () => {
    // Parallel carriageways sharing a cell are a dual carriageway, not a crossing.
    const parallel: WorldRoad[] = [
      { id: 'a', kind: 'primary', width: 14, points: [{ x: -50, z: 0 }, { x: 50, z: 0 }] },
      { id: 'b', kind: 'primary', width: 14, points: [{ x: -50, z: 4 }, { x: 50, z: 4 }] },
    ];
    expect(findTrafficSignals(parallel, 64)).toHaveLength(0);
  });

  it('treats one junction as one junction however many vertices describe it', () => {
    const dense: WorldRoad[] = [
      {
        id: 'main', kind: 'primary', width: 14,
        points: [{ x: -30, z: 0 }, { x: -2, z: 0 }, { x: 0, z: 0 }, { x: 2, z: 0 }, { x: 30, z: 0 }],
      },
      {
        id: 'side', kind: 'secondary', width: 12,
        points: [{ x: 0, z: -30 }, { x: 0, z: -2 }, { x: 0, z: 0 }, { x: 0, z: 2 }, { x: 0, z: 30 }],
      },
    ];
    expect(findTrafficSignals(dense, 64)).toHaveLength(4);
  });

  it('staggers neighbouring junctions rather than switching the whole city together', () => {
    const signals = findTrafficSignals([...crossroads(0, 0, '-a'), ...crossroads(400, 0, '-b')], 64);
    const offsets = new Set(signals.map((head) => head.offsetSeconds));
    expect(signals).toHaveLength(8);
    expect(offsets.size).toBe(2);
  });

  it('honours the limit without emitting a part-signalled junction', () => {
    expect(findTrafficSignals(crossroads(), 3)).toHaveLength(0);
    expect(findTrafficSignals([...crossroads(0, 0, '-a'), ...crossroads(400, 0, '-b')], 4)).toHaveLength(4);
    expect(findTrafficSignals(crossroads(), 0)).toHaveLength(0);
  });
});

describe('findRouteSignalStops', () => {
  const eastbound: LocalPoint[] = [{ x: -60, z: 0 }, { x: 0, z: 0 }, { x: 60, z: 0 }];
  const northbound: LocalPoint[] = [{ x: 0, z: -60 }, { x: 0, z: 0 }, { x: 0, z: 60 }];

  it('finds exactly one stop for a route crossing a signalised junction', () => {
    const signals = findTrafficSignals(crossroads(), 64);
    const stops = findRouteSignalStops(eastbound, signals);

    expect(stops).toHaveLength(1);
    expect(stops[0].signal.group).toBe(0);
    expect(stops[0].traveledMeters).toBeGreaterThan(40);
    expect(stops[0].traveledMeters).toBeLessThan(60);
  });

  it('matches the crossing approach group for a route entering from the side street', () => {
    const signals = findTrafficSignals(crossroads(), 64);
    const stops = findRouteSignalStops(northbound, signals);

    expect(stops).toHaveLength(1);
    expect(stops[0].signal.group).toBe(1);
  });

  it('finds nothing for a route nowhere near any signal', () => {
    const signals = findTrafficSignals(crossroads(), 64);
    const farAway: LocalPoint[] = [{ x: 2000, z: 2000 }, { x: 2100, z: 2000 }];
    expect(findRouteSignalStops(farAway, signals)).toHaveLength(0);
  });

  it('orders stops by distance along the route', () => {
    const signals = findTrafficSignals([...crossroads(0, 0, '-a'), ...crossroads(400, 0, '-b')], 64);
    const longRoute: LocalPoint[] = [{ x: -60, z: 0 }, { x: 0, z: 0 }, { x: 400, z: 0 }, { x: 460, z: 0 }];
    const stops = findRouteSignalStops(longRoute, signals);

    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(stops[0].traveledMeters).toBeLessThan(stops[stops.length - 1].traveledMeters);
  });
});

describe('nextBlockingSignalStop', () => {
  const stopAt = (traveledMeters: number, overrides: Partial<TrafficSignal> = {}) => ({
    traveledMeters,
    signal: signal({ offsetSeconds: 0, ...overrides }),
  });

  it('returns null when nothing is ahead', () => {
    expect(nextBlockingSignalStop([], 0, 0)).toBeNull();
  });

  it('ignores a stop already behind the bus', () => {
    const stops = [stopAt(10)];
    expect(nextBlockingSignalStop(stops, 50, 0)).toBeNull();
  });

  it('ignores a stop currently showing green', () => {
    const stops = [stopAt(50)];
    // t=0 is green for group 0 (see resolveSignalAspect tests above).
    expect(nextBlockingSignalStop(stops, 0, 0)).toBeNull();
  });

  it('blocks on a stop currently showing red or amber', () => {
    const stops = [stopAt(50)];
    const redAt = SIGNAL_GREEN_SECONDS + SIGNAL_AMBER_SECONDS + 0.1;
    expect(nextBlockingSignalStop(stops, 0, redAt)?.traveledMeters).toBe(50);
  });

  it('skips a green stop and blocks on the next red one ahead', () => {
    const stops = [stopAt(50, { group: 0 }), stopAt(100, { group: 1 })];
    // At t=0, group 0 is green and group 1 is red (opposed phases).
    expect(nextBlockingSignalStop(stops, 0, 0)?.traveledMeters).toBe(100);
  });
});

describe('createTrafficLights', () => {
  it('builds an empty, harmless batch when there is nothing to signal', () => {
    const batch = createTrafficLights([]);
    expect(batch.group.children).toHaveLength(0);
    expect(() => batch.update(12)).not.toThrow();
  });

  it('lights exactly one lens per head and repaints it when the aspect changes', () => {
    const batch = createTrafficLights(findTrafficSignals(crossroads(), 64));
    const lens = (aspect: string) => batch.group.getObjectByName(`world:traffic-lights:${aspect}`) as THREE.InstancedMesh;
    const brightness = (mesh: THREE.InstancedMesh, index: number) => {
      const color = new THREE.Color();
      mesh.getColorAt(index, color);
      return color.r + color.g + color.b;
    };

    batch.update(0);
    const green = lens('green');
    const red = lens('red');
    expect(brightness(green, 0)).toBeGreaterThan(brightness(red, 0));

    // The crossing approach is stopped at the very same instant. findTrafficSignals
    // emits both heads of group 0 before group 1, so index 2 is the crossing street.
    expect(brightness(red, 2)).toBeGreaterThan(brightness(green, 2));

    // Half a cycle later the two have swapped.
    batch.update(SIGNAL_CYCLE_SECONDS / 2);
    expect(brightness(red, 0)).toBeGreaterThan(brightness(green, 0));
    expect(brightness(green, 2)).toBeGreaterThan(brightness(red, 2));
  });
});
