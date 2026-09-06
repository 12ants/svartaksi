/**
 * Groups SvartaksiFacadeWall records by shared material/profile and instances each
 * group as one THREE.InstancedMesh, so a whole city of facades costs only a
 * handful of draw calls instead of one mesh per wall.
 */
import * as THREE from 'three';

import { getOrCreateFacadeMaterial } from '../svartaksi/buildingFacade';
import type { SvartaksiFacadeBuilding, SvartaksiFacadeWall } from './facadeRecords';
import { INSPECTION_USER_DATA_KEY } from './inspection';

export interface SvartaksiFacadeRendererStats {
  buildings: number;
  walls: number;
  batches: number;
  droppedWalls: number;
}

export interface SvartaksiFacadeRenderer {
  replace(buildings: SvartaksiFacadeBuilding[]): void;
  getStats(): SvartaksiFacadeRendererStats;
  getWindowLightWalls(): readonly SvartaksiFacadeWall[];
  dispose(): void;
}

interface FacadeBatch {
  profile: SvartaksiFacadeWall['profile'];
  walls: SvartaksiFacadeWall[];
}

const DEFAULT_MAX_INSTANCES = 10_000;
const MAX_STORE_ACCENTS = 24;

/**
 * A facade wall is a zero-thickness plane sitting exactly on its footprint edge, so
 * anything that meets it edge-on leaves a visible slit. Each wall is therefore *drawn*
 * slightly larger than the geometry it represents, in three directions:
 *
 * - `WALL_TOP_OVERLAP` clears the roof cap, which floats `capLift` (up to 0.047m, see
 *   roofStyle.ts) above `building.height` to avoid z-fighting with the box fallback's
 *   top face. That lift used to be a hairline gap you could see into the building
 *   through, running the full perimeter of every building in the city.
 * - `WALL_CORNER_OVERLAP` makes adjacent walls overlap at each footprint corner instead
 *   of meeting exactly, so no rounding disagreement between two edges can open a seam
 *   at a grazing angle.
 * - `WALL_BASE_SINK` extends the wall below y=0. Landuse polygons extrude into solid
 *   terrain up to 3.6m tall (parkExtrusionHeight), and buildings inside one would
 *   otherwise start at y=0, well below the ground actually visible around them.
 *
 * Only the drawn quad grows. The window grid is solved against the wall's true size
 * (see facadeRecords/solveFacadeLayout) and is re-anchored below so it lands in exactly
 * the same place on the building either way.
 */
export const WALL_TOP_OVERLAP = 0.08;
export const WALL_CORNER_OVERLAP = 0.06;
// If this changes, update the matching `4.0` in FACADE_FRAGMENT_SHADER's ground-contact
// darkening (buildingFacade.ts) — it can't import this constant without a circular
// import between the two files, so the two are kept in step by hand.
export const WALL_BASE_SINK = 4;
/**
 * How far the plane is pushed out along its own outward normal.
 *
 * Terraces and courtyard blocks in OSM share footprint edges, and two buildings sharing
 * an edge produce two facade planes at exactly the same place in the world — the one
 * coplanar case no draw order or depth bias can resolve, because both surfaces are
 * equally correct. Stepping each wall out along *its own* normal separates the pair by
 * twice this, and since the two normals point opposite ways each building keeps the wall
 * on its own side. Small enough to be invisible at a corner, where WALL_CORNER_OVERLAP
 * already covers the extra couple of centimetres.
 */
export const WALL_OUTWARD_STANDOFF = 0.015;
const EMPTY_STATS: SvartaksiFacadeRendererStats = {
  buildings: 0,
  walls: 0,
  batches: 0,
  droppedWalls: 0,
};

export function createFacadeRenderer(
  group: THREE.Group,
  options: {
    maxInstances?: number;
    materials?: Map<string, THREE.ShaderMaterial>;
    secondaryDetails?: boolean;
    detailCastShadow?: boolean;
  } = {},
): SvartaksiFacadeRenderer {
  const maxInstances = Math.max(0, Math.floor(options.maxInstances ?? DEFAULT_MAX_INSTANCES));
  // A materials cache passed in from the caller (threeWorld.ts) is externally owned
  // and long-lived across many renderer instances — never disposed here, only ever by
  // its owner. threeWorld.ts now rebuilds the buildings/facades layer far more often
  // than the old ~1s streaming cadence (every camera-frustum/render-budget check, up
  // to 4x/sec — see updateVisibleBuildings), so recompiling every facade shader
  // program from scratch on every such rebuild (as a fresh per-instance Map would)
  // was a real, serious cost — WebGL shader compilation is slow, especially under
  // software rendering, and was observed to pile up into multi-second stalls while
  // driving continuously. Keying by profile (family+scheme+variant), materials are
  // valid to reuse across any rebuild regardless of which buildings/instances end up
  // using them (see getOrCreateFacadeMaterial). When no external cache is passed
  // (e.g. tests constructing a renderer standalone), this renderer owns one itself,
  // still not disposed until this renderer's own final dispose() — mid-lifecycle
  // replace() calls no longer force recompilation either way.
  const materials = options.materials ?? new Map<string, THREE.ShaderMaterial>();
  const ownsMaterials = options.materials === undefined;
  const meshes: THREE.InstancedMesh[] = [];
  const doorstepMaterials = new Map<string, THREE.MeshStandardMaterial>();
  let storeAccentMaterial: THREE.MeshStandardMaterial | null = null;
  let stats = { ...EMPTY_STATS };
  let disposed = false;
  let lightWalls: SvartaksiFacadeWall[] = [];

  const clear = () => {
    for (const mesh of meshes) {
      group.remove(mesh);
      mesh.dispose();
      mesh.geometry.dispose();
    }
    meshes.length = 0;
    lightWalls = [];
    storeAccentMaterial?.dispose();
    storeAccentMaterial = null;
  };

  /**
   * Store fronts get a canopy/awning above the door — the "distinct facade type" the
   * family exists for. They used to also get a guaranteed real PointLight at the
   * entrance, along with real lights from lit windows and glazed door panes elsewhere
   * in this module — all removed: Three's forward lighting model costs every
   * MeshStandardMaterial fragment in the scene per active light, so no per-building
   * light scales to a whole city regardless of source. Windows, door glass, and store
   * fronts all keep their own emissive glow from the shader instead.
   */
  const addStoreAccents = (buildings: SvartaksiFacadeBuilding[]): void => {
    const storeDoors = buildings
      .flatMap(building => building.walls)
      .filter((wall): wall is SvartaksiFacadeWall & { door: NonNullable<SvartaksiFacadeWall['door']> } =>
        wall.family === 'store' && wall.door !== undefined)
      .sort((a, b) => a.seed - b.seed)
      .slice(0, MAX_STORE_ACCENTS);
    if (storeDoors.length === 0) return;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    storeAccentMaterial = new THREE.MeshStandardMaterial({
      color: storeDoors[0].profile.signColor ?? '#c1442e',
      roughness: 0.6,
    });
    const awnings = new THREE.InstancedMesh(geometry, storeAccentMaterial, storeDoors.length);
    awnings.name = 'svartaksi-facades:store-awnings';
    awnings.castShadow = true;
    awnings.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    storeDoors.forEach((wall, index) => {
      const alongX = Math.cos(wall.yaw);
      const alongZ = Math.sin(wall.yaw);
      const localX = wall.door.centerX - wall.width / 2;
      const doorTopY = wall.door.bottom + wall.door.height;
      const x = wall.centerX + alongX * localX + wall.outwardX * 0.5;
      const z = wall.centerZ + alongZ * localX + wall.outwardZ * 0.5;
      const y = doorTopY + 0.12;
      matrix.makeBasis(
        new THREE.Vector3(alongX, 0, alongZ).multiplyScalar(wall.door.width + 0.7),
        new THREE.Vector3(0, 1, 0).multiplyScalar(0.16),
        new THREE.Vector3(wall.outwardX, 0, wall.outwardZ).multiplyScalar(0.9),
      );
      matrix.setPosition(x, y, z);
      awnings.setMatrixAt(index, matrix);
    });
    awnings.instanceMatrix.needsUpdate = true;
    meshes.push(awnings);
    group.add(awnings);
  };

  return {
    replace(buildings) {
      if (disposed) throw new Error('Cannot replace a disposed facade renderer');
      clear();

      const batches = new Map<string, FacadeBatch>();
      let acceptedWalls = 0;
      let droppedWalls = 0;
      for (const building of [...buildings].sort((a, b) => a.id.localeCompare(b.id))) {
        for (const wall of building.walls) {
          if (acceptedWalls >= maxInstances) {
            droppedWalls += 1;
            continue;
          }
          const rendererKey = `${wall.profileKey}:${wall.variant}`;
          const batch = batches.get(rendererKey);
          if (batch) batch.walls.push(wall);
          else batches.set(rendererKey, { profile: wall.profile, walls: [wall] });
          lightWalls.push(wall);
          acceptedWalls += 1;
        }
      }

      for (const [profileKey, batch] of batches) {
        const mesh = createBatchMesh(profileKey, batch, materials);
        meshes.push(mesh);
        group.add(mesh);
      }
      if (options.secondaryDetails !== false) {
        addStoreAccents(buildings);
        addDoorsteps(
          buildings,
          group,
          meshes,
          doorstepMaterials,
          options.detailCastShadow !== false,
        );
      }
      stats = {
        buildings: buildings.length,
        walls: acceptedWalls,
        batches: batches.size,
        droppedWalls,
      };
    },
    getWindowLightWalls: () => lightWalls,
    getStats() {
      return { ...stats };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      if (ownsMaterials) {
        for (const material of materials.values()) material.dispose();
        materials.clear();
      }
      for (const material of doorstepMaterials.values()) material.dispose();
      doorstepMaterials.clear();
      stats = { ...EMPTY_STATS };
    },
  };
}

function createBatchMesh(
  profileKey: string,
  batch: FacadeBatch,
  materials: Map<string, THREE.ShaderMaterial>,
): THREE.InstancedMesh {
  const count = batch.walls.length;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const wallSizes = addAttribute(geometry, 'aWallSize', count, 2);
  const gridOrigins = addAttribute(geometry, 'aGridOrigin', count, 2);
  const gridCounts = addAttribute(geometry, 'aGridCount', count, 2);
  const windowMetrics = addAttribute(geometry, 'aWindowMetrics', count, 4);
  const facadeParams = addAttribute(geometry, 'aFacadeParams', count, 4);
  const facadeColors = addAttribute(geometry, 'aFacadeColor', count, 3);
  const doorRects = addAttribute(geometry, 'aDoorRect', count, 4);
  const doorGlass = addAttribute(geometry, 'aDoorGlass', count, 3);
  const doorStyles = addAttribute(geometry, 'aDoorStyle', count, 4);
  const material = getOrCreateFacadeMaterial(profileKey, batch.profile, materials);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.userData[INSPECTION_USER_DATA_KEY] = batch.walls.map((wall) => wall.inspection);
  mesh.name = `svartaksi-facades:${profileKey}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const matrix = new THREE.Matrix4();
  const facadeColor = new THREE.Color();
  batch.walls.forEach((wall, index) => {
    // The drawn quad is grown past the wall's true bounds (see the overlap constants)
    // and its origin therefore moves: local x=0 is now WALL_CORNER_OVERLAP/2 left of the
    // real wall start, and local y=0 is WALL_BASE_SINK below the real base. Every
    // local-space value handed to the shader is shifted by the same amounts so windows
    // and doors stay exactly where the solver put them.
    const renderWidth = wall.width + WALL_CORNER_OVERLAP;
    const renderHeight = wall.height + WALL_TOP_OVERLAP + WALL_BASE_SINK;
    const originShiftX = WALL_CORNER_OVERLAP / 2;
    const originShiftY = WALL_BASE_SINK;
    matrix.makeBasis(
      new THREE.Vector3(Math.cos(wall.yaw), 0, Math.sin(wall.yaw)),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(wall.outwardX, 0, wall.outwardZ),
    );
    matrix.setPosition(
      wall.centerX + wall.outwardX * WALL_OUTWARD_STANDOFF,
      wall.centerY + (WALL_TOP_OVERLAP - WALL_BASE_SINK) / 2,
      wall.centerZ + wall.outwardZ * WALL_OUTWARD_STANDOFF,
    );
    matrix.scale(new THREE.Vector3(renderWidth, renderHeight, 1));
    mesh.setMatrixAt(index, matrix);
    wallSizes.setXY(index, renderWidth, renderHeight);
    gridOrigins.setXY(index, wall.layout.startX + originShiftX, wall.layout.startY + originShiftY);
    gridCounts.setXY(index, wall.layout.columns, wall.layout.rows);
    windowMetrics.setXYZW(
      index,
      wall.profile.windowWidth,
      wall.profile.windowHeight,
      wall.profile.windowSpacingX,
      wall.profile.windowSpacingY,
    );
    facadeParams.setXYZW(index, wall.seed, wall.door ? 1 : 0, wall.profile.litRatio, Math.floor(wall.seed * 4));
    facadeColor.set(wall.profile.wallColor);
    facadeColors.setXYZ(index, facadeColor.r, facadeColor.g, facadeColor.b);
    doorRects.setXYZW(
      index,
      (wall.door?.centerX ?? 0) + originShiftX,
      (wall.door?.bottom ?? 0) + originShiftY,
      wall.door?.width ?? 0,
      wall.door?.height ?? 0,
    );
    doorGlass.setXYZ(
      index,
      wall.door?.glass?.width ?? 0,
      (wall.door?.bottom ?? 0) + (wall.door?.glass?.bottom ?? 0) + originShiftY,
      wall.door?.glass?.height ?? 0,
    );
    doorStyles.setXYZW(
      index,
      doorStyleIndex(wall.door?.style.kind),
      wall.door?.style.frameWidth ?? 0,
      wall.door?.style.panelCount ?? 1,
      wall.door?.style.glassRatio ?? 0,
    );
  });
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  for (const attribute of [
    wallSizes,
    gridOrigins,
    gridCounts,
    windowMetrics,
    facadeParams,
    facadeColors,
    doorRects,
    doorGlass,
    doorStyles,
  ]) attribute.needsUpdate = true;
  return mesh;
}

function doorStyleIndex(kind: NonNullable<SvartaksiFacadeWall['door']>['style']['kind'] | undefined): number {
  switch (kind) {
    case 'glazed': return 1;
    case 'double': return 2;
    case 'shopfront': return 3;
    case 'service': return 4;
    default: return 0;
  }
}

function addDoorsteps(
  buildings: SvartaksiFacadeBuilding[],
  group: THREE.Group,
  meshes: THREE.InstancedMesh[],
  materials: Map<string, THREE.MeshStandardMaterial>,
  castShadow: boolean,
): void {
  const byKind = new Map<string, SvartaksiFacadeWall[]>();
  for (const wall of buildings.flatMap(building => building.walls)) {
    if (!wall.doorstep) continue;
    const batch = byKind.get(wall.doorstep.kind);
    if (batch) batch.push(wall);
    else byKind.set(wall.doorstep.kind, [wall]);
  }

  for (const [kind, walls] of byKind) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    let material = materials.get(kind);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: kind === 'hardstanding' ? '#565A5C' : kind === 'landing' ? '#8B8982' : '#77746D',
        roughness: 0.9,
      });
      materials.set(kind, material);
    }
    const mesh = new THREE.InstancedMesh(geometry, material, walls.length);
    mesh.name = `svartaksi-facades:doorsteps:${kind}`;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.userData[INSPECTION_USER_DATA_KEY] = walls.map(wall => wall.inspection);

    const matrix = new THREE.Matrix4();
    walls.forEach((wall, index) => {
      const doorstep = wall.doorstep!;
      matrix.makeBasis(
        new THREE.Vector3(Math.cos(doorstep.yaw), 0, Math.sin(doorstep.yaw)).multiplyScalar(doorstep.width),
        new THREE.Vector3(0, doorstep.height, 0),
        new THREE.Vector3(wall.outwardX, 0, wall.outwardZ).multiplyScalar(doorstep.depth),
      );
      const baseY = wall.centerY - wall.height / 2;
      matrix.setPosition(doorstep.center.x, baseY + doorstep.height / 2 + 0.02, doorstep.center.z);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
    group.add(mesh);
  }
}

function addAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  count: number,
  itemSize: number,
): THREE.InstancedBufferAttribute {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize);
  geometry.setAttribute(name, attribute);
  return attribute;
}
