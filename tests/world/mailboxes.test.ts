import { describe, expect, it } from 'vitest';
import { MAILBOX_SPACING, generateMailboxes, mappedMailboxes } from '../../src/world/mailboxes';
import type { WorldBuilding, WorldRoad } from '../../src/world/types';

const straight = (kind: string, length = 3000, width = 8, id = `road:${kind}`): WorldRoad => ({
  id, kind, width,
  points: [{ x: 0, z: 0 }, { x: length, z: 0 }],
});

describe('generateMailboxes', () => {
  it('places boxes at a fixed spacing, offset a third of a spacing from the road start', () => {
    const boxes = generateMailboxes([straight('residential')]);
    expect(boxes.length).toBeGreaterThan(1);
    for (const [index, box] of boxes.entries()) {
      expect(box.x).toBeCloseTo(MAILBOX_SPACING / 3 + index * MAILBOX_SPACING);
    }
  });

  it('keeps every box on one kerb of a given road, clear of the paved width', () => {
    const boxes = generateMailboxes([straight('residential')]);
    const side = Math.sign(boxes[0].z);
    for (const box of boxes) {
      expect(Math.sign(box.z)).toBe(side);
      expect(Math.abs(box.z)).toBeGreaterThan(4);
    }
  });

  it('turns the slot away from the carriageway', () => {
    const boxes = generateMailboxes([straight('residential')]);
    for (const box of boxes) {
      // Local +Z rotated by yaw is where the slot looks: away from the centerline.
      expect(Math.sign(Math.cos(box.yaw))).toBe(Math.sign(box.z));
      // And square to the kerb rather than along it.
      expect(Math.sin(box.yaw)).toBeCloseTo(0);
    }
  });

  it('picks a kerb from the road id, so a rebuild never moves a box across the street', () => {
    const first = generateMailboxes([straight('residential', 3000, 8, 'alpha')]);
    expect(generateMailboxes([straight('residential', 3000, 8, 'alpha')])).toEqual(first);
    const sides = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      Math.sign(generateMailboxes([straight('residential', 3000, 8, id)])[0].z));
    expect(new Set(sides).size).toBe(2);
  });

  it('skips road kinds nobody walks a postal round along', () => {
    for (const kind of ['footway', 'cycleway', 'motorway', 'trunk', 'primary', 'secondary']) {
      expect(generateMailboxes([straight(kind)])).toHaveLength(0);
    }
  });

  it('skips roads too short to be part of a round', () => {
    expect(generateMailboxes([straight('residential', 120)])).toHaveLength(0);
  });

  it('rejects a placement that lands on another road', () => {
    const street = straight('residential');
    const first = generateMailboxes([street])[0];
    const crossing: WorldRoad = {
      id: 'crossing', kind: 'tertiary', width: 30,
      points: [{ x: first.x, z: -60 }, { x: first.x, z: 60 }],
    };
    const boxes = generateMailboxes([street, crossing]);
    expect(boxes.some((box) => box.x === first.x && box.z === first.z)).toBe(false);
  });

  it('rejects a placement whose spot reaches into a building footprint', () => {
    const street = straight('residential');
    const first = generateMailboxes([street])[0];
    const reaching: WorldBuilding = {
      id: 'blocker', height: 6, properties: {},
      rings: [[
        { x: first.x - 3, z: first.z - 3 }, { x: first.x + 3, z: first.z - 3 },
        { x: first.x + 3, z: first.z + 3 }, { x: first.x - 3, z: first.z + 3 },
      ]],
    };
    const boxes = generateMailboxes([street], [], [reaching]);
    expect(boxes.some((box) => box.x === first.x && box.z === first.z)).toBe(false);
    expect(generateMailboxes([street]).some((box) => box.x === first.x && box.z === first.z)).toBe(true);
  });

  it('carries spacing across a multi-segment road', () => {
    const road: WorldRoad = {
      id: 'bend', kind: 'unclassified', width: 8,
      points: [{ x: 0, z: 0 }, { x: 800, z: 0 }, { x: 800, z: 800 }],
    };
    const boxes = generateMailboxes([road]);
    expect(boxes).toHaveLength(Math.floor((1600 - MAILBOX_SPACING / 3) / MAILBOX_SPACING) + 1);
  });

  it('keeps boxes apart from each other and from furniture it is told to avoid', () => {
    const street = straight('residential');
    const plain = generateMailboxes([street]);
    const avoided = generateMailboxes([street], [{ x: plain[0].x, z: plain[0].z }]);
    expect(avoided.some((box) => box.x === plain[0].x)).toBe(false);
    expect(avoided.length).toBe(plain.length - 1);

    // Two roads crossing at a shallow angle would otherwise each drop a box at the
    // junction, a couple of meters apart.
    const parallel: WorldRoad = {
      id: 'parallel', kind: 'residential', width: 8,
      points: [{ x: 0, z: 12 }, { x: 3000, z: 12 }],
    };
    const crowded = generateMailboxes([street, parallel]);
    expect(crowded.length).toBeGreaterThan(1);
    for (let i = 0; i < crowded.length; i += 1) {
      for (let j = i + 1; j < crowded.length; j += 1) {
        expect(Math.hypot(crowded[i].x - crowded[j].x, crowded[i].z - crowded[j].z)).toBeGreaterThan(30);
      }
    }
  });

  it('ignores degenerate roads', () => {
    expect(generateMailboxes([{ id: 'a', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }] }])).toHaveLength(0);
    expect(generateMailboxes([{ id: 'b', kind: 'residential', width: 8, points: [] }])).toHaveLength(0);
  });
});

describe('mappedMailboxes', () => {
  it('keeps the surveyed position and turns the slot away from the nearest road', () => {
    const road = straight('residential', 1000);
    const [north, south] = mappedMailboxes([{ x: 200, z: 9 }, { x: 400, z: -9 }], [road]);
    expect(north).toMatchObject({ x: 200, z: 9 });
    expect(Math.cos(north.yaw)).toBeGreaterThan(0.99);
    expect(Math.cos(south.yaw)).toBeLessThan(-0.99);
  });

  it('takes its facing from the closest road, not the first one', () => {
    const far = straight('residential', 1000, 8, 'far');
    const near: WorldRoad = {
      id: 'near', kind: 'residential', width: 8,
      points: [{ x: 0, z: 200 }, { x: 1000, z: 200 }],
    };
    const [box] = mappedMailboxes([{ x: 500, z: 190 }], [far, near]);
    // Nearer to `near` (10m) than to `far` (190m), so the slot looks toward -Z.
    expect(Math.cos(box.yaw)).toBeLessThan(-0.99);
  });

  it('falls back to yaw 0 rather than dropping a box with no road near it', () => {
    expect(mappedMailboxes([{ x: 5, z: 5 }], [])).toEqual([{ x: 5, z: 5, yaw: 0 }]);
    const onCenterline = mappedMailboxes([{ x: 100, z: 0 }], [straight('residential', 1000)]);
    expect(onCenterline[0].yaw).toBe(0);
  });

  it('ignores degenerate roads when choosing a facing', () => {
    const boxes = mappedMailboxes([{ x: 5, z: 5 }], [
      { id: 'a', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }] },
      { id: 'b', kind: 'residential', width: 8, points: [{ x: 1, z: 1 }, { x: 1, z: 1 }] },
    ]);
    expect(boxes).toEqual([{ x: 5, z: 5, yaw: 0 }]);
  });
});


/**
 * The same frozen-fixture idea as the shelters': coordinates recorded from the eager
 * implementation before it was cut into slices, on a network built to make the walk's
 * order matter — spurs meeting a long residential road (so the separation check has
 * neighbours to reject against), a road too short to serve, a zero-length segment, a
 * footway that is skipped, and one shelter in `avoid` standing exactly where a box
 * would otherwise go.
 */
const FROZEN_BOXES: [number, number, number][] = [
  [156.666667, -5.9, 3.141593],
  [626.666667, -5.9, 3.141593],
  [1096.666667, -5.9, 3.141593],
  [2036.666667, -5.9, 3.141593],
  [2506.666667, -5.9, 3.141593],
  [2976.666667, -5.9, 3.141593],
  [3446.666667, -5.9, 3.141593],
  [3916.666667, -5.9, 3.141593],
  [4.4, 156.666667, 1.570796],
  [495.6, 156.666667, -1.570796],
  [1004.4, 156.666667, 1.570796],
  [1495.6, 156.666667, -1.570796],
  [2004.4, 156.666667, 1.570796],
  [2495.6, 156.666667, -1.570796],
  [3004.4, 156.666667, 1.570796],
  [3495.6, 156.666667, -1.570796],
  [156.666667, 1204.9, 0],
  [626.666667, 1204.9, 0],
  [1096.666667, 1204.9, 0],
];

/** Two surveyed nodes at the same spot (both kept — a duplicate node is the surveyor's
 * business, not the generator's), one beside the main road, one nowhere near anything. */
const FROZEN_MAPPED: [number, number, number][] = [
  [100, 12, 0],
  [100, 12, 0],
  [2500, -20, 3.141593],
  [9000, 9000, 0.694738],
];

describe('mailbox placement on a spur network', () => {
  const network: WorldRoad[] = [
    { id: 'main', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 4000, z: 0 }] },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `spur-${index}`,
      kind: 'service',
      width: 5,
      points: [{ x: index * 500, z: 0 }, { x: index * 500, z: 400 }],
    })),
    { id: 'stub', kind: 'residential', width: 6, points: [{ x: 0, z: 900 }, { x: 100, z: 900 }] },
    { id: 'degenerate', kind: 'unclassified', width: 6, points: [{ x: 0, z: 1200 }, { x: 0, z: 1200 }, { x: 1500, z: 1200 }] },
    { id: 'skipped', kind: 'footway', width: 3, points: [{ x: 0, z: 1800 }, { x: 3000, z: 1800 }] },
  ];
  const blocks: WorldBuilding[] = [{
    id: 'block',
    height: 12,
    properties: {},
    rings: [[{ x: 1100, z: 4 }, { x: 1300, z: 4 }, { x: 1300, z: 40 }, { x: 1100, z: 40 }, { x: 1100, z: 4 }]],
  }];
  /** A shelter standing on the box the walk would otherwise place at x=1566.67. */
  const shelter = [{ x: 1566.667, z: -5.9 }];

  it('reproduces the recorded generated placements exactly', () => {
    const boxes = generateMailboxes(network, shelter, blocks);

    expect(boxes.map((box) => [
      Number(box.x.toFixed(6)), Number(box.z.toFixed(6)), Number(box.yaw.toFixed(6)),
    ])).toEqual(FROZEN_BOXES);
  });

  it('gives way to a shelter already standing there rather than shifting the round', () => {
    const suppressed = FROZEN_BOXES[0][0] + MAILBOX_SPACING * 3;
    const near = (xs: number[]) => xs.some((x) => Math.abs(x - suppressed) < 1e-3);

    expect(near(generateMailboxes(network, [], blocks).map((box) => box.x))).toBe(true);
    expect(near(FROZEN_BOXES.map(([x]) => x))).toBe(false);
  });

  it('reproduces the recorded surveyed placements exactly', () => {
    const mapped = mappedMailboxes(
      [{ x: 100, z: 12 }, { x: 100, z: 12 }, { x: 2500, z: -20 }, { x: 9000, z: 9000 }],
      network,
    );

    expect(mapped.map((box) => [
      Number(box.x.toFixed(6)), Number(box.z.toFixed(6)), Number(box.yaw.toFixed(6)),
    ])).toEqual(FROZEN_MAPPED);
  });
});
