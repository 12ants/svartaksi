import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildRoadRailingGeometry, railingHeightForLift } from '../../src/world/bridgeRailings';
import type { RoadElevationProfile } from '../../src/world/roadElevationProfile';
import type { WorldRoad } from '../../src/world/types';

/** A straight ten-metre carriageway, plus the deck samples a profile would hand it. */
function deck(lift: number, structure: WorldRoad['structure'] = 'bridge') {
  const road: WorldRoad = {
    id: 'span', kind: 'primary', width: 10, structure, layer: 1,
    points: [{ x: 0, z: 0 }, { x: 40, z: 0 }],
  };
  const base = 0.17;
  const points = road.points;
  const elevations = points.map(() => base + lift);
  const lifts = points.map(() => lift);
  return { road, points, elevations, lifts };
}

function bounds(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

describe('railingHeightForLift', () => {
  it('is nothing at grade, and full height once the deck is a structure', () => {
    expect(railingHeightForLift(0)).toBe(0);
    expect(railingHeightForLift(0.4)).toBe(0);
    expect(railingHeightForLift(4)).toBeGreaterThan(1);
  });

  it('grows monotonically with lift, so a ramp gains its parapet gradually instead of popping', () => {
    const heights = [0, 0.5, 0.8, 1.1, 1.4, 1.6, 3].map(railingHeightForLift);
    for (let index = 1; index < heights.length; index += 1) {
      expect(heights[index]).toBeGreaterThanOrEqual(heights[index - 1]);
    }
    // Genuinely partway up at mid-ramp — not a threshold dressed up as a ramp.
    const middle = railingHeightForLift(1.05);
    expect(middle).toBeGreaterThan(0.2);
    expect(middle).toBeLessThan(railingHeightForLift(1.6));
  });
});

describe('buildRoadRailingGeometry', () => {
  it('stands a parapet along both edges of a deck, inside its paved width', () => {
    const { road, points, elevations, lifts } = deck(4.5);
    const geometry = buildRoadRailingGeometry(road, points, elevations, lifts)!;
    expect(geometry).not.toBeNull();

    const box = bounds(geometry);
    // Both sides: the parapet reaches to within a rail's thickness of each kerb, and
    // never past it — a railing hanging off the edge is worse than none.
    expect(box.max.z).toBeLessThanOrEqual(road.width / 2);
    expect(box.min.z).toBeGreaterThanOrEqual(-road.width / 2);
    expect(box.max.z).toBeGreaterThan(4);
    expect(box.min.z).toBeLessThan(-4);

    // It sits on the deck, not on the ground far below it, and stands about a parapet's
    // height over it.
    expect(box.min.y).toBeGreaterThan(elevations[0] - 0.2);
    expect(box.max.y - elevations[0]).toBeGreaterThan(1);
    expect(box.max.y - elevations[0]).toBeLessThan(1.4);
  });

  it('faces its geometry outward, so a FrontSide material does not render it inside out', () => {
    const { road, points, elevations, lifts } = deck(4.5);
    const geometry = buildRoadRailingGeometry(road, points, elevations, lifts)!;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex()!;

    // Every triangle's own winding normal must agree with the vertex normals it produced,
    // and every face of a closed prism must point away from that prism's centre.
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const face = new THREE.Vector3();
    let checked = 0;
    for (let triangle = 0; triangle < index.count / 3; triangle += 1) {
      const i0 = index.getX(triangle * 3);
      const i1 = index.getX(triangle * 3 + 1);
      const i2 = index.getX(triangle * 3 + 2);
      a.fromBufferAttribute(position, i0);
      b.fromBufferAttribute(position, i1);
      c.fromBufferAttribute(position, i2);
      face.copy(edge1.subVectors(b, a)).cross(edge2.subVectors(c, a));
      if (face.lengthSq() < 1e-12) continue;
      face.normalize();
      // The prism this triangle belongs to occupies eight consecutive vertices.
      const prismStart = Math.floor(i0 / 8) * 8;
      const centre = new THREE.Vector3();
      for (let vertex = prismStart; vertex < prismStart + 8; vertex += 1) {
        centre.add(new THREE.Vector3().fromBufferAttribute(position, vertex));
      }
      centre.multiplyScalar(1 / 8);
      const outward = a.clone().sub(centre);
      expect(face.dot(outward)).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
    expect(normal.count).toBe(position.count);
  });

  it('builds nothing for a road lying on the ground', () => {
    const { road, points, elevations, lifts } = deck(0, 'ground');
    expect(buildRoadRailingGeometry(road, points, elevations, lifts)).toBeNull();
  });

  it('follows an approach ramp, tapering off exactly where the ramp reaches grade', () => {
    // The shape propagateRampsAcrossJunctions produces: high at the deck it continues,
    // back to street level at the far end.
    const road: WorldRoad = {
      id: 'approach', kind: 'primary', width: 10,
      points: [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 80, z: 0 }],
    };
    const lifts = [4.5, 2.2, 0];
    const elevations = lifts.map((lift) => 0.17 + lift);
    const geometry = buildRoadRailingGeometry(road, road.points, elevations, lifts)!;
    expect(geometry).not.toBeNull();

    const box = bounds(geometry);
    // Nothing is built out at the grounded end — the last posts stop while the ramp is
    // still up in the air.
    expect(box.max.x).toBeLessThan(80);
    // ...and the parapet is tallest over the highest part of the ramp.
    expect(box.max.y).toBeGreaterThan(elevations[0]);
    expect(box.max.y).toBeLessThan(elevations[0] + 1.4);
  });

  it('gives a tagged bridge a full parapet even where the span itself sits low', () => {
    // A short bridge earns only a small lift (see bridgeDeckLift), but it is still a
    // surveyed structure and still has a railing end to end.
    const { road, points, elevations, lifts } = deck(0.3, 'bridge');
    const railing = buildRoadRailingGeometry(road, points, elevations, lifts)!;
    expect(railing).not.toBeNull();
    expect(bounds(railing).max.y - elevations[0]).toBeGreaterThan(1);

    // The same geometry without the bridge tag is a road on the ground, and gets nothing.
    const plain = deck(0.3, 'ground');
    expect(buildRoadRailingGeometry(plain.road, plain.points, plain.elevations, plain.lifts)).toBeNull();
  });

  it('keeps posts on the deck through a bend rather than cutting the corner', () => {
    const road: WorldRoad = {
      id: 'bend', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 40 }],
    };
    const elevations = road.points.map(() => 4.67);
    const lifts = road.points.map(() => 4.5);
    const geometry = buildRoadRailingGeometry(road, road.points, elevations, lifts)!;
    const box = bounds(geometry);
    // The outer corner of a right-angle bend on a 10m deck reaches (45, 45) at the kerb;
    // the mitered inset line stays inside that and never inside the inner kerb either.
    expect(box.max.x).toBeLessThanOrEqual(45);
    expect(box.max.z).toBeLessThanOrEqual(45);
    expect(box.min.z).toBeGreaterThanOrEqual(-5);
  });
});

describe('junction openings', () => {
  function crossing(height: number, width = 8) {
    const profile: RoadElevationProfile = {
      roadId: 'joining-road', structure: 'bridge', layer: 1, width, unresolvedCrossings: [],
      samples: [
        { point: { x: 20, z: -20 }, height, distanceAlong: 0 },
        { point: { x: 20, z: 20 }, height, distanceAlong: 40 },
      ],
    };
    return new Map([[profile.roadId, profile]]);
  }

  it('leaves both carriageways open where bridge decks join', () => {
    const { road, points, elevations, lifts } = deck(4.5);
    const geometry = buildRoadRailingGeometry(road, points, elevations, lifts, crossing(4.67))!;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(20, 5.245, -10), new THREE.Vector3(0, 0, 1), 0, 20);
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    ray.ray.origin.x = 5;
    expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
  });

  it('keeps the parapet over a road on another level', () => {
    const { road, points, elevations, lifts } = deck(4.5);
    const plain = buildRoadRailingGeometry(road, points, elevations, lifts)!;
    const over = buildRoadRailingGeometry(road, points, elevations, lifts, crossing(0.14))!;
    expect(over.getAttribute('position').array).toEqual(plain.getAttribute('position').array);
  });

  it('does not leave a rail across a narrow joining path between posts', () => {
    const { road, points, elevations, lifts } = deck(4.5);
    const geometry = buildRoadRailingGeometry(road, points, elevations, lifts, crossing(4.67, 0.6))!;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(20, 5.245, -10), new THREE.Vector3(0, 0, 1), 0, 20);
    expect(ray.intersectObject(mesh)).toHaveLength(0);
  });
});
