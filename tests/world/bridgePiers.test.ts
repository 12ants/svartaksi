import { describe, expect, it } from 'vitest';
import {
  buildBridgePierGeometry,
  createRoadObstructionTest,
  pierPlacements,
  type PierPlacement,
} from '../../src/world/bridgePiers';
import type { LocalPoint } from '../../src/world/types';

/** A straight deck along +x, `count` points at `step` metres, lifted by `liftAt`. */
const deck = (count: number, step: number, liftAt: (index: number) => number, baseY = 0) => {
  const points: LocalPoint[] = [];
  const elevations: number[] = [];
  const lifts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const lift = liftAt(index);
    points.push({ x: index * step, z: 0 });
    lifts.push(lift);
    elevations.push(baseY + lift);
  }
  return { points, elevations, lifts };
};

const WIDTH = 8;
const flat = (n: number) => Array.from({ length: n }, () => 0.4);

const kinds = (p: PierPlacement[]) => p.map((pier) => pier.kind);
const xs = (p: PierPlacement[]) => p.map((pier) => pier.x);

describe('pierPlacements', () => {
  it('places nothing under a road that never leaves the ground', () => {
    const { points, elevations, lifts } = deck(10, 10, () => 0);
    expect(pierPlacements(points, elevations, lifts, flat(10), WIDTH)).toEqual([]);
  });

  it('places nothing under a deck lifted less than the pier threshold', () => {
    // Below MIN_PIER_LIFT there is no daylight to put a column in — a kerb-height rise
    // is not a structure.
    const { points, elevations, lifts } = deck(10, 10, () => 1.0);
    expect(pierPlacements(points, elevations, lifts, flat(10), WIDTH)).toEqual([]);
  });

  it('gives a short span two abutments and no column', () => {
    // 20m of deck is under one 26m target span, so it reads as a single clear span —
    // which is how a short overbridge is actually built.
    const { points, elevations, lifts } = deck(3, 10, () => 5);
    const piers = pierPlacements(points, elevations, lifts, flat(3), WIDTH);
    expect(kinds(piers)).toEqual(['abutment', 'abutment']);
    expect(xs(piers)).toEqual([0, 20]);
  });

  it('divides a long viaduct into whole, evenly spaced spans', () => {
    // 104m at a 26m target is exactly four spans: abutments at both ends, three columns.
    const { points, elevations, lifts } = deck(14, 8, () => 6);
    const piers = pierPlacements(points, elevations, lifts, flat(14), WIDTH);
    expect(kinds(piers)).toEqual(['abutment', 'column', 'column', 'column', 'abutment']);
    expect(xs(piers)).toEqual([0, 26, 52, 78, 104]);
  });

  it('keeps spans even rather than marching from one end', () => {
    // 100m at a 26m target rounds to four spans of 25m — not three of 26m plus a 22m
    // offcut. The ragged remainder is the tell of a stepping algorithm.
    const { points, elevations, lifts } = deck(11, 10, () => 6);
    const piers = pierPlacements(points, elevations, lifts, flat(11), WIDTH);
    expect(xs(piers)).toEqual([0, 25, 50, 75, 100]);
  });

  it('supports only the stretch actually in the air, not the ramps', () => {
    // A profile that climbs out of the street, holds, and sets back down. Only the held
    // section wants supports, and its abutments sit where the deck crosses the threshold.
    const { points, elevations, lifts } = deck(11, 10, (i) => (i <= 2 ? i * 2 : i >= 8 ? (10 - i) * 2 : 6));
    const piers = pierPlacements(points, elevations, lifts, flat(11), WIDTH);
    expect(piers[0].kind).toBe('abutment');
    expect(piers[piers.length - 1].kind).toBe('abutment');
    // Threshold 1.5 is crossed between x=0 (lift 0) and x=20 (lift 4): at lift 1.5 that
    // is x=7.5. Symmetrically at the far end.
    expect(piers[0].x).toBeCloseTo(7.5, 5);
    expect(piers[piers.length - 1].x).toBeCloseTo(92.5, 5);
    for (const pier of piers) expect(pier.x).toBeGreaterThan(0);
  });

  it('handles two separate elevated runs on one road', () => {
    // Up, down to grade, and up again — two structures, each fully supported, and no
    // support in the dip between them.
    const high = (i: number) => (i >= 4 && i <= 6 ? 0 : 6);
    const { points, elevations, lifts } = deck(11, 10, high);
    const piers = pierPlacements(points, elevations, lifts, flat(11), WIDTH);
    const abutments = piers.filter((pier) => pier.kind === 'abutment');
    expect(abutments).toHaveLength(4);
    // The dip runs from where the deck drops through the threshold (between x=30 at
    // lift 6 and x=40 at lift 0, so x=37.5) to where it climbs back through it (x=62.5).
    // Nothing is supported in between, because nothing there is in the air.
    expect(abutments.map((pier) => pier.x)).toEqual([0, 37.5, 62.5, 100]);
    for (const pier of piers) expect(pier.x <= 37.5 || pier.x >= 62.5).toBe(true);
  });

  it('stops a support at the underside of the slab, not the road surface', () => {
    const { points, elevations, lifts } = deck(3, 10, () => 5);
    const piers = pierPlacements(points, elevations, lifts, flat(3), WIDTH);
    // Deck surface is at 5, the slab is 0.4 thick, so the support tops out at 4.6.
    for (const pier of piers) expect(pier.topY).toBeCloseTo(4.6, 5);
  });

  it('sinks the foot below the road baseline so it is never left hanging', () => {
    const { points, elevations, lifts } = deck(3, 10, () => 5, 12);
    const piers = pierPlacements(points, elevations, lifts, flat(3), WIDTH);
    // Baseline is elevation - lift = 12; the foot is embedded below it.
    for (const pier of piers) expect(pier.baseY).toBeLessThan(12);
  });

  it('skips a support the caller reports as obstructed', () => {
    // The underpass case: the road the viaduct crosses is exactly where a column would
    // otherwise land, and a column in a live carriageway is worse than no column.
    const { points, elevations, lifts } = deck(14, 8, () => 6);
    const all = pierPlacements(points, elevations, lifts, flat(14), WIDTH);
    const blocked = pierPlacements(points, elevations, lifts, flat(14), WIDTH, {
      isObstructed: (x: number) => x > 40 && x < 60,
    });
    expect(blocked.length).toBe(all.length - 1);
    expect(xs(blocked)).not.toContain(52);
  });

  it('squares an abutment to the deck and keeps a column square', () => {
    const { points, elevations, lifts } = deck(14, 8, () => 6);
    const piers = pierPlacements(points, elevations, lifts, flat(14), WIDTH);
    const abutment = piers.find((pier) => pier.kind === 'abutment')!;
    const column = piers.find((pier) => pier.kind === 'column')!;
    // An abutment is a wall: as wide across the road as the deck, short along it.
    expect(abutment.halfWidth).toBeGreaterThan(abutment.halfDepth);
    // A column is a square section.
    expect(column.halfWidth).toBe(column.halfDepth);
    // Both are oriented along the deck, which here runs +x.
    for (const pier of piers) {
      expect(pier.dirX).toBeCloseTo(1, 5);
      expect(pier.dirZ).toBeCloseTo(0, 5);
    }
  });

  it('orients supports along a deck that does not run down an axis', () => {
    const points: LocalPoint[] = [{ x: 0, z: 0 }, { x: 30, z: 30 }, { x: 60, z: 60 }];
    const lifts = [6, 6, 6];
    const piers = pierPlacements(points, [6, 6, 6], lifts, flat(3), WIDTH);
    const invSqrt2 = 1 / Math.SQRT2;
    for (const pier of piers) {
      expect(pier.dirX).toBeCloseTo(invSqrt2, 5);
      expect(pier.dirZ).toBeCloseTo(invSqrt2, 5);
    }
  });

  it('narrows an abutment to the deck it carries, minus the inset', () => {
    const { points, elevations, lifts } = deck(3, 10, () => 5);
    const wide = pierPlacements(points, elevations, lifts, flat(3), 12)[0];
    const narrow = pierPlacements(points, elevations, lifts, flat(3), 6)[0];
    expect(wide.halfWidth).toBeGreaterThan(narrow.halfWidth);
    expect(wide.halfWidth).toBeCloseTo(12 / 2 - 0.35, 5);
  });

  it('refuses degenerate input rather than emitting broken supports', () => {
    expect(pierPlacements([], [], [], null, WIDTH)).toEqual([]);
    expect(pierPlacements([{ x: 0, z: 0 }], [5], [5], null, WIDTH)).toEqual([]);
    // A road narrower than twice the inset would give an abutment negative width.
    const { points, elevations, lifts } = deck(3, 10, () => 5);
    expect(pierPlacements(points, elevations, lifts, flat(3), 0.5)).toEqual([]);
    // A zero-length road has no distance to space piers along.
    const stack = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
    expect(pierPlacements(stack, [5, 5], [5, 5], flat(2), WIDTH)).toEqual([]);
  });

  it('treats a missing slab profile as a deck of no thickness', () => {
    const { points, elevations, lifts } = deck(3, 10, () => 5);
    const piers = pierPlacements(points, elevations, lifts, null, WIDTH);
    expect(piers).toHaveLength(2);
    for (const pier of piers) expect(pier.topY).toBeCloseTo(5, 5);
  });

  it('respects a caller-supplied spacing', () => {
    const { points, elevations, lifts } = deck(11, 10, () => 6);
    const piers = pierPlacements(points, elevations, lifts, flat(11), WIDTH, { spacing: 50 });
    expect(kinds(piers)).toEqual(['abutment', 'column', 'abutment']);
    expect(xs(piers)).toEqual([0, 50, 100]);
  });
});

describe('buildBridgePierGeometry', () => {
  it('returns null for a deck with no supports', () => {
    expect(buildBridgePierGeometry([])).toBeNull();
  });

  it('emits one closed box per support', () => {
    const { points, elevations, lifts } = deck(14, 8, () => 6);
    const piers = pierPlacements(points, elevations, lifts, flat(14), WIDTH);
    const geometry = buildBridgePierGeometry(piers)!;
    expect(geometry.getAttribute('position').count).toBe(piers.length * 8);
    // Six faces, two triangles each, three indices per triangle.
    expect(geometry.getIndex()!.count).toBe(piers.length * 36);
    expect(geometry.getAttribute('normal')).toBeTruthy();
  });

  it('spans exactly from foot to underside of the deck', () => {
    const piers = pierPlacements(
      ...(() => { const d = deck(3, 10, () => 5); return [d.points, d.elevations, d.lifts] as const; })(),
      flat(3), WIDTH,
    );
    const geometry = buildBridgePierGeometry(piers)!;
    const position = geometry.getAttribute('position');
    let min = Infinity;
    let max = -Infinity;
    for (let index = 0; index < position.count; index += 1) {
      min = Math.min(min, position.getY(index));
      max = Math.max(max, position.getY(index));
    }
    expect(max).toBeCloseTo(4.6, 5);
    expect(min).toBeCloseTo(-0.6, 5);
  });
});

describe('createRoadObstructionTest', () => {
  const road = (id: string, points: LocalPoint[], width = 8) =>
    ({ id, kind: 'minor', width, points }) as never;

  const deckLine: LocalPoint[] = [{ x: 0, z: 0 }, { x: 100, z: 0 }];

  /** The deck underside these tests ask about: a viaduct standing 6m up. */
  const UNDERSIDE = 6;
  /** Every road in the fixture is an ordinary street at grade unless said otherwise. */
  const atGrade = () => 0;
  /** Every road in the fixture is up on the deck alongside the viaduct. Its surface is
   * one deck-thickness above the underside, which is where a continuation way sits. */
  const atDeckLevel = () => UNDERSIDE + 0.45;

  it('reports a point sitting in a road that passes underneath as obstructed', () => {
    // The underpass: a street at grade crossing the deck's line at x=50.
    const crossing = road('under', [{ x: 50, z: -40 }, { x: 50, z: 40 }]);
    const test = createRoadObstructionTest([crossing], 'deck', deckLine, atGrade);
    expect(test(50, 0, UNDERSIDE)).toBe(true);
    // Clear of it by more than half the carriageway plus the column's own clearance.
    expect(test(20, 0, UNDERSIDE)).toBe(false);
  });

  it('keeps a support standing beside a road at the deck\'s own level', () => {
    // The viaduct's own continuation way, or a neighbour up on the same structure. It
    // runs straight along the deck's line, so the horizontal test alone rejects every
    // support on the bridge — which is what left decks standing on nothing.
    const continuation = road('deck-b', [{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    const test = createRoadObstructionTest([continuation], 'deck', deckLine, atDeckLevel);
    expect(test(50, 0, UNDERSIDE)).toBe(false);
  });

  it('keeps an abutment where the deck hands over to its approach ramp', () => {
    // The commonest case of the bug: an abutment stands exactly where the deck meets the
    // ramp that carries it down, and that ramp is at deck level right there.
    const ramp = road('ramp', [{ x: 95, z: 0 }, { x: 160, z: 0 }]);
    const test = createRoadObstructionTest([ramp], 'deck', deckLine, atDeckLevel);
    expect(test(100, 0, UNDERSIDE)).toBe(false);
  });

  it('still rejects a support on a road only just far enough under the deck', () => {
    // A shallow deck: the street beneath clears the underside by less than a metre, and
    // must still count. The margin has to sit below this or low underpasses lose it.
    const under = road('low', [{ x: 50, z: -40 }, { x: 50, z: 40 }]);
    const test = createRoadObstructionTest([under], 'deck', deckLine, () => 0);
    expect(test(50, 0, 1.05)).toBe(true);
  });

  it('never reports the deck road against itself', () => {
    const self = road('deck', deckLine);
    const test = createRoadObstructionTest([self], 'deck', deckLine, atGrade);
    expect(test(50, 0, UNDERSIDE)).toBe(false);
  });

  it('scales the exclusion zone with the obstructing road width', () => {
    const narrow = road('n', [{ x: 50, z: -40 }, { x: 50, z: 40 }], 4);
    const wide = road('w', [{ x: 50, z: -40 }, { x: 50, z: 40 }], 30);
    // 10m from the centreline: outside a 4m road, well inside a 30m one.
    expect(createRoadObstructionTest([narrow], 'deck', deckLine, atGrade)(60, 0, UNDERSIDE)).toBe(false);
    expect(createRoadObstructionTest([wide], 'deck', deckLine, atGrade)(60, 0, UNDERSIDE)).toBe(true);
  });

  it('ignores roads nowhere near the deck', () => {
    const far = road('far', [{ x: 5_000, z: 5_000 }, { x: 5_100, z: 5_000 }]);
    expect(createRoadObstructionTest([far], 'deck', deckLine, atGrade)(50, 0, UNDERSIDE)).toBe(false);
  });

  it('measures to the segment, not just its endpoints', () => {
    // A point beside the middle of a long segment is inside the road; the endpoint-only
    // test this replaces would have called it clear.
    const along = road('along', [{ x: 0, z: 3 }, { x: 100, z: 3 }]);
    const test = createRoadObstructionTest([along], 'deck', deckLine, atGrade);
    expect(test(50, 0, UNDERSIDE)).toBe(true);
  });

  it('handles degenerate input without throwing', () => {
    expect(createRoadObstructionTest([], 'deck', deckLine, atGrade)(0, 0, UNDERSIDE)).toBe(false);
    expect(createRoadObstructionTest([road('r', deckLine)], 'deck', [], atGrade)(0, 0, UNDERSIDE)).toBe(false);
    // A single-point way has no segment to measure against.
    expect(createRoadObstructionTest([road('p', [{ x: 50, z: 0 }])], 'deck', deckLine, atGrade)(50, 0, UNDERSIDE))
      .toBe(false);
  });
});
