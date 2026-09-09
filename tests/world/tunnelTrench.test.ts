import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTunnelTrenchGeometry, trenchRuns } from '../../src/world/tunnelTrench';
import type { LocalPoint } from '../../src/world/types';

/** A straight road along +x, `count` points at `step` metres, dug by `digAt` (positive =
 * metres below grade). Grade itself stays at 0, so elevation is the negative of the dig. */
const road = (count: number, step: number, digAt: (index: number) => number) => {
  const points: LocalPoint[] = [];
  const elevations: number[] = [];
  const lifts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const dig = digAt(index);
    points.push({ x: index * step, z: 0 });
    elevations.push(-dig);
    lifts.push(-dig);
  }
  return { points, elevations, lifts };
};

const WIDTH = 8;

const boundsY = (geometry: THREE.BufferGeometry) => {
  const position = geometry.getAttribute('position');
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < position.count; index += 1) {
    min = Math.min(min, position.getY(index));
    max = Math.max(max, position.getY(index));
  }
  return { min, max };
};

describe('trenchRuns', () => {
  it('finds nothing along a road at grade', () => {
    const { points, lifts } = road(6, 10, () => 0);
    expect(trenchRuns(points, lifts)).toEqual([]);
  });

  it('ignores a shallow dip that is not a cutting', () => {
    // A road following ground that sags is not dug out of anything; walling every gentle
    // hollow in the city would be worse than the problem.
    const { points, lifts } = road(6, 10, () => 0.2);
    expect(trenchRuns(points, lifts)).toEqual([]);
  });

  it('finds the stretch actually below grade', () => {
    const { points, lifts } = road(8, 10, (i) => (i >= 3 && i <= 5 ? 4 : 0));
    expect(trenchRuns(points, lifts)).toEqual([{ start: 3, end: 5 }]);
  });

  it('finds two separate cuttings on one road', () => {
    const { points, lifts } = road(12, 10, (i) => (i >= 1 && i <= 3) || (i >= 8 && i <= 10) ? 4 : 0);
    expect(trenchRuns(points, lifts)).toEqual([{ start: 1, end: 3 }, { start: 8, end: 10 }]);
  });

  it('runs to the road end when it is still deep there', () => {
    // The mouth: the visible road stops while still in the cut and hands over to a
    // tunnel nothing paints.
    const { points, lifts } = road(6, 10, (i) => i * 1.5);
    expect(trenchRuns(points, lifts)).toEqual([{ start: 1, end: 5 }]);
  });

  it('ignores a single deep sample with no span to wall', () => {
    // One point is a spike in the profile, not a length of cutting.
    const { points, lifts } = road(6, 10, (i) => (i === 3 ? 4 : 0));
    expect(trenchRuns(points, lifts)).toEqual([]);
  });

  it('treats a raised road as no cutting at all', () => {
    // Lifts are positive here — that is the deck side's business, not this module's.
    const { points } = road(6, 10, () => 0);
    expect(trenchRuns(points, [0, 3, 5, 5, 3, 0])).toEqual([]);
  });
});

describe('buildTunnelTrenchGeometry', () => {
  it('returns null for a road that is never dug', () => {
    const { points, elevations, lifts } = road(6, 10, () => 0);
    expect(buildTunnelTrenchGeometry(points, elevations, lifts, WIDTH)).toBeNull();
  });

  it('returns null for degenerate input', () => {
    expect(buildTunnelTrenchGeometry([], [], [], WIDTH)).toBeNull();
    expect(buildTunnelTrenchGeometry([{ x: 0, z: 0 }], [-4], [-4], WIDTH)).toBeNull();
    const { points, elevations, lifts } = road(6, 10, () => 4);
    expect(buildTunnelTrenchGeometry(points, elevations, lifts, 0)).toBeNull();
  });

  it('builds walls spanning from the road surface up past grade', () => {
    const { points, elevations, lifts } = road(6, 10, () => 4);
    const geometry = buildTunnelTrenchGeometry(points, elevations, lifts, WIDTH)!;
    const { min, max } = boundsY(geometry);
    // The road sits 4m down; walls reach it and overshoot grade slightly so no hairline
    // of daylight opens between wall and ground plane.
    expect(min).toBeCloseTo(-4, 5);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(0.5);
  });

  it('follows a ramp, so the wall is tall at the mouth and short where it reaches grade', () => {
    // A descending approach: the wall must taper with the road rather than being one
    // constant-height slab, or the cut reads as a step.
    const { points, elevations, lifts } = road(6, 10, (i) => i * 1.5);
    const geometry = buildTunnelTrenchGeometry(points, elevations, lifts, WIDTH)!;
    const { min } = boundsY(geometry);
    expect(min).toBeCloseTo(-7.5, 5);
  });

  it('keeps walls clear of the carriageway it retains', () => {
    // A wall inside the paved edge would eat the lane. Both walls stand at or outside
    // half the road's width.
    const { points, elevations, lifts } = road(6, 10, () => 4);
    const geometry = buildTunnelTrenchGeometry(points, elevations, lifts, WIDTH)!;
    const position = geometry.getAttribute('position');
    for (let index = 0; index < position.count; index += 1) {
      expect(Math.abs(position.getZ(index))).toBeGreaterThanOrEqual(WIDTH / 2 - 1e-6);
    }
  });

  it('caps the mouth where the cutting reaches the road end still deep', () => {
    const withMouth = road(6, 10, (i) => 1.5 * i);
    const capped = buildTunnelTrenchGeometry(withMouth.points, withMouth.elevations, withMouth.lifts, WIDTH)!;
    // A cutting that climbs back to grade before the road ends has no tunnel to hand
    // over to, so it gets no portal — and therefore fewer triangles over a comparable run.
    const closed = road(7, 10, (i) => (i >= 1 && i <= 5 ? 6 : 0));
    const open = buildTunnelTrenchGeometry(closed.points, closed.elevations, closed.lifts, WIDTH)!;
    const quads = (geometry: THREE.BufferGeometry) => geometry.getIndex()!.count / 6;
    // Same number of walled segments (4), so the difference is the portal itself.
    expect(quads(capped)).toBe(quads(open) + 1);
  });

  it('puts a portal across the full width of the road', () => {
    const { points, elevations, lifts } = road(6, 10, (i) => 1.5 * i);
    const geometry = buildTunnelTrenchGeometry(points, elevations, lifts, WIDTH)!;
    const position = geometry.getAttribute('position');
    // The deepest point is the mouth; vertices there must span both edges of the road.
    let spanAtMouth = 0;
    for (let index = 0; index < position.count; index += 1) {
      if (position.getX(index) > 49) spanAtMouth = Math.max(spanAtMouth, Math.abs(position.getZ(index)));
    }
    expect(spanAtMouth).toBeGreaterThanOrEqual(WIDTH / 2);
  });

  it('emits closed geometry with normals', () => {
    const { points, elevations, lifts } = road(6, 10, () => 4);
    const geometry = buildTunnelTrenchGeometry(points, elevations, lifts, WIDTH)!;
    expect(geometry.getIndex()).toBeTruthy();
    expect(geometry.getAttribute('normal')).toBeTruthy();
    expect(geometry.getIndex()!.count % 6).toBe(0);
  });

  it('walls both sides of the cutting', () => {
    const { points, elevations, lifts } = road(6, 10, () => 4);
    const geometry = buildTunnelTrenchGeometry(points, elevations, lifts, WIDTH)!;
    const position = geometry.getAttribute('position');
    let left = false;
    let right = false;
    for (let index = 0; index < position.count; index += 1) {
      if (position.getZ(index) > 0) left = true;
      if (position.getZ(index) < 0) right = true;
    }
    expect(left && right).toBe(true);
  });
});
