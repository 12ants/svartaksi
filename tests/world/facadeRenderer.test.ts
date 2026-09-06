import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { buildFacadeRecord } from '../../src/world/facadeRecords';
import {
  createFacadeRenderer,
  WALL_BASE_SINK,
  WALL_CORNER_OVERLAP,
  WALL_OUTWARD_STANDOFF,
  WALL_TOP_OVERLAP,
} from '../../src/world/facadeRenderer';
import type { WorldBuilding } from '../../src/world/types';

/** The drawn quad grows past the wall's true bounds (see the overlap constants), and it
 * grows further downward than upward, so its center sits below the wall's own center. */
const WALL_CENTER_Y_SHIFT = (WALL_TOP_OVERLAP - WALL_BASE_SINK) / 2;

function facadeBuilding(id: string, offsetX: number) {
  const source: WorldBuilding = {
    id,
    height: 16,
    properties: { type: 'apartments' },
    rings: [[
      { x: offsetX, z: 0 },
      { x: offsetX + 12, z: 0 },
      { x: offsetX + 12, z: 8 },
      { x: offsetX, z: 8 },
      { x: offsetX, z: 0 },
    ]],
  };
  const record = buildFacadeRecord(source);
  if (!record) throw new Error(`Expected facade record for ${id}`);
  return record;
}

describe('createFacadeRenderer', () => {
  it('renders same-profile walls in one batch with every shader attribute', () => {
    const group = new THREE.Group();
    const renderer = createFacadeRenderer(group, { maxInstances: 8 });

    renderer.replace([facadeBuilding('building-a', 0), facadeBuilding('building-f', 20)]);

    expect(renderer.getStats()).toEqual({ buildings: 2, walls: 8, batches: 1, droppedWalls: 0 });
    const facadeMeshes = group.children.filter(child => child instanceof THREE.InstancedMesh);
    expect(facadeMeshes).toHaveLength(1);
    const mesh = facadeMeshes[0] as THREE.InstancedMesh;
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(mesh.count).toBe(8);
    expect(mesh.name).toMatch(/^svartaksi-facades:residential:stockholm-dusk:[012]$/);
    for (const attribute of [
      'aWallSize',
      'aGridOrigin',
      'aGridCount',
      'aWindowMetrics',
      'aFacadeParams',
      'aFacadeColor',
      'aDoorRect',
      'aDoorGlass',
      'aDoorStyle',
    ]) {
      expect(mesh.geometry.getAttribute(attribute), attribute).toBeDefined();
    }
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);

    renderer.dispose();
    renderer.dispose();
    expect(group.children).toHaveLength(0);
    expect(() => renderer.replace([])).toThrow(/disposed/i);
  });

  it('keeps bounded palette variants in materials with their own uniform colors', () => {
    const group = new THREE.Group();
    const renderer = createFacadeRenderer(group);
    const buildings = Array.from({ length: 30 }, (_, index) => facadeBuilding(`variant-${index}`, index * 20));

    renderer.replace(buildings);

    const expected = new Map(buildings.flatMap(building => building.walls).map(wall => [
      `${wall.profileKey}:${wall.variant}`,
      [wall.profile.windowColor, wall.profile.doorColor],
    ]));
    expect(expected.size).toBeGreaterThan(1);
    expect(expected.size).toBeLessThanOrEqual(3);
    const facadeMeshes = group.children.filter(child => child instanceof THREE.InstancedMesh);
    expect(facadeMeshes).toHaveLength(expected.size);
    for (const child of facadeMeshes) {
      const mesh = child as THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
      const colors = expected.get(mesh.name.replace('svartaksi-facades:', ''));
      expect(colors).toBeDefined();
      expect(mesh.material.uniforms.uWindowColor.value.getHexString()).toBe(new THREE.Color(colors![0]).getHexString());
      expect(mesh.material.uniforms.uDoorColor.value.getHexString()).toBe(new THREE.Color(colors![1]).getHexString());
    }
  });

  it('disposes each replaced batch\'s geometry, but keeps materials alive across replace() for reuse', () => {
    // Materials are keyed by profile (family+scheme+variant), not by which specific
    // buildings/instances use them — replacing with new buildings must not force
    // recompiling a shader program that's still valid, only rebuild the (cheap)
    // per-instance geometry/attribute buffers. See createFacadeRenderer's `materials`
    // option doc comment for why this matters (shader compile cost, especially under
    // software rendering, piling up across frequent rebuilds).
    const group = new THREE.Group();
    const renderer = createFacadeRenderer(group);
    renderer.replace([facadeBuilding('first', 0)]);
    const first = group.children[0] as THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const firstGeometryDispose = vi.spyOn(first.geometry, 'dispose');
    const firstMaterialDispose = vi.spyOn(first.material, 'dispose');

    renderer.replace([facadeBuilding('second', 20)]);

    expect(firstGeometryDispose).toHaveBeenCalledTimes(1);
    expect(firstMaterialDispose).not.toHaveBeenCalled();

    renderer.dispose();
    renderer.dispose();

    // Standalone usage (no external materials cache passed in) still owns and
    // disposes whatever ended up cached, exactly once, at final dispose.
    expect(firstMaterialDispose).toHaveBeenCalledTimes(1);
  });

  it('never disposes an externally-owned materials cache, even across many renderer instances', () => {
    // This is the actual shape threeWorld.ts uses: a shared cache outliving any one
    // facadeRenderer instance, reused every time the buildings/facades layer rebuilds
    // (camera-frustum/render-budget checks now do this far more often than the old
    // ~1s streaming cadence) — disposing an individual instance must never touch it.
    const sharedMaterials = new Map<string, THREE.ShaderMaterial>();
    const group = new THREE.Group();

    const rendererA = createFacadeRenderer(group, { materials: sharedMaterials });
    rendererA.replace([facadeBuilding('a', 0)]);
    expect(sharedMaterials.size).toBeGreaterThan(0);
    const material = [...sharedMaterials.values()][0];
    const materialDispose = vi.spyOn(material, 'dispose');

    rendererA.dispose();
    expect(materialDispose).not.toHaveBeenCalled();
    expect(sharedMaterials.size).toBeGreaterThan(0);

    // A brand new renderer instance, sharing the same cache, reuses the compiled
    // material instead of forcing recompilation — same id as before so it resolves
    // to the identical profile/variant (stableFacadeVariant is a hash of identity).
    const rendererB = createFacadeRenderer(group, { materials: sharedMaterials });
    rendererB.replace([facadeBuilding('a', 0)]);
    const meshB = group.children[0] as THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(meshB.material).toBe(material);

    rendererB.dispose();
    expect(materialDispose).not.toHaveBeenCalled();
  });

  it('gives store buildings an awning mesh but no real light, and no lights anywhere else in the scene', () => {
    const group = new THREE.Group();
    const renderer = createFacadeRenderer(group);
    const store: WorldBuilding = {
      id: 'bakery', height: 16, properties: { shop: 'bakery' },
      rings: [[{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 8 }, { x: 0, z: 8 }, { x: 0, z: 0 }]],
    };
    const storeRecord = buildFacadeRecord(store);
    if (!storeRecord) throw new Error('Expected a facade record for the store building');
    expect(storeRecord.walls.some(wall => wall.family === 'store')).toBe(true);

    renderer.replace([storeRecord, facadeBuilding('plain', 30)]);

    const awnings = group.getObjectByName('svartaksi-facades:store-awnings');
    expect(awnings).toBeInstanceOf(THREE.InstancedMesh);
    // Windows, door glass, and store fronts glow via shader emissive only — no real
    // THREE.Light anywhere in the facade renderer's output (perf: every active light
    // costs every MeshStandardMaterial fragment in the scene, so none of these scale
    // to a whole city).
    expect(group.children.some(child => child instanceof THREE.Light)).toBe(false);

    renderer.replace([facadeBuilding('plain-only', 60)]);
    expect(group.getObjectByName('svartaksi-facades:store-awnings')).toBeUndefined();
  });

  it('sorts buildings by id before deterministically applying the wall cap', () => {
    const group = new THREE.Group();
    const renderer = createFacadeRenderer(group, { maxInstances: 5 });
    const buildingA = facadeBuilding('building-a', 0);
    const buildingB = facadeBuilding('building-f', 20);

    renderer.replace([buildingB, buildingA]);

    expect(renderer.getStats()).toEqual({ buildings: 2, walls: 5, batches: 1, droppedWalls: 3 });
    const mesh = group.children[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(5);
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    const firstPosition = new THREE.Vector3().setFromMatrixPosition(matrix);
    // Each wall stands off along its own outward normal, so two buildings sharing a
    // footprint edge do not emit two planes in exactly the same place.
    expect(firstPosition.x)
      .toBeCloseTo(buildingA.walls[0].centerX + buildingA.walls[0].outwardX * WALL_OUTWARD_STANDOFF);
    expect(firstPosition.y).toBeCloseTo(WALL_CENTER_Y_SHIFT + buildingA.walls[0].centerY);
    expect(firstPosition.z)
      .toBeCloseTo(buildingA.walls[0].centerZ + buildingA.walls[0].outwardZ * WALL_OUTWARD_STANDOFF);
    mesh.getMatrixAt(4, matrix);
    const fifthPosition = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(fifthPosition.x)
      .toBeCloseTo(buildingB.walls[0].centerX + buildingB.walls[0].outwardX * WALL_OUTWARD_STANDOFF);
    expect(fifthPosition.y).toBeCloseTo(WALL_CENTER_Y_SHIFT + buildingB.walls[0].centerY);
    expect(fifthPosition.z)
      .toBeCloseTo(buildingB.walls[0].centerZ + buildingB.walls[0].outwardZ * WALL_OUTWARD_STANDOFF);
  });

  it('draws each wall past its own bounds without moving the window grid on the building', () => {
    // A zero-thickness plane sitting exactly on its footprint edge leaves a visible slit
    // wherever something meets it edge-on — under the roof cap, at each corner, and at
    // the base where a building stands on extruded landuse. The quad is drawn larger to
    // close those; the windows must not move as a result.
    const group = new THREE.Group();
    const renderer = createFacadeRenderer(group, { maxInstances: 8 });
    const building = facadeBuilding('overlap-check', 0);
    const wall = building.walls[0];

    renderer.replace([building]);

    const mesh = group.children[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    expect(scale.x).toBeCloseTo(wall.width + WALL_CORNER_OVERLAP);
    expect(scale.y).toBeCloseTo(wall.height + WALL_TOP_OVERLAP + WALL_BASE_SINK);

    const wallSize = mesh.geometry.getAttribute('aWallSize');
    expect(wallSize.getX(0)).toBeCloseTo(wall.width + WALL_CORNER_OVERLAP);
    expect(wallSize.getY(0)).toBeCloseTo(wall.height + WALL_TOP_OVERLAP + WALL_BASE_SINK);

    // The grid origin is expressed in the quad's local space, whose origin moved — so it
    // has to shift by exactly the same amounts to stay put on the actual wall.
    const gridOrigin = mesh.geometry.getAttribute('aGridOrigin');
    expect(gridOrigin.getX(0)).toBeCloseTo(wall.layout.startX + WALL_CORNER_OVERLAP / 2);
    expect(gridOrigin.getY(0)).toBeCloseTo(wall.layout.startY + WALL_BASE_SINK);

    // The solver itself never sees the overlap: the layout is still fitted to the wall's
    // true size, so column/row counts and padding are unchanged.
    expect(wall.layout.startX).toBeLessThan(wall.width);
    expect(wall.layout.endY).toBeLessThanOrEqual(wall.height);
  });

  it('clears the roof cap, which is what the top overlap exists for', () => {
    // Roofs are placed at building.height + capLift (roofStyle.ts), up to 0.047m above
    // the wall top. Anything less than that here reopens the slit under every roof.
    expect(WALL_TOP_OVERLAP).toBeGreaterThan(0.047);
  });
});
