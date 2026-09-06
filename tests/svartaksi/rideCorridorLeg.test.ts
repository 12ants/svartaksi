import { describe, expect, it } from 'vitest';
import { nextRideCorridorLeg } from '../../src/svartaksi/busCorridor';
import type { LocalPoint } from '../../src/world/types';

const STRAIGHT_PATH: LocalPoint[] = [{ x: 0, z: 0 }, { x: 10_000, z: 0 }];

describe('nextRideCorridorLeg', () => {
  it('returns null before the bus has covered restreamMeters since the last fetch', () => {
    expect(nextRideCorridorLeg(STRAIGHT_PATH, 500, 0, 1200, 2400)).toBeNull();
  });

  it('returns a leg from the current position once restreamMeters has been covered', () => {
    const leg = nextRideCorridorLeg(STRAIGHT_PATH, 1200, 0, 1200, 2400);
    expect(leg).not.toBeNull();
    expect(leg!.from.x).toBeCloseTo(1200, 0);
    expect(leg!.to.x).toBeCloseTo(1200 + 2400, 0);
  });

  it('measures distance since the last fetch, not distance from the route start', () => {
    // Already fetched up to 5000m; only 600m travelled since then — not due yet.
    expect(nextRideCorridorLeg(STRAIGHT_PATH, 5600, 5000, 1200, 2400)).toBeNull();
    // 1200m travelled since the last fetch — due now, and anchored to the current position.
    const leg = nextRideCorridorLeg(STRAIGHT_PATH, 6200, 5000, 1200, 2400);
    expect(leg!.from.x).toBeCloseTo(6200, 0);
  });

  it('clamps the leg to the end of the path rather than running past it', () => {
    const leg = nextRideCorridorLeg(STRAIGHT_PATH, 9000, 0, 1200, 2400);
    expect(leg!.to.x).toBeCloseTo(10_000, 0);
  });

  it('is due immediately on a fresh ride, with no prior fetch', () => {
    const leg = nextRideCorridorLeg(STRAIGHT_PATH, 0, Number.NEGATIVE_INFINITY, 1200, 2400);
    expect(leg).not.toBeNull();
  });
});
