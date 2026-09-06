/**
 * Neon over the shopfronts: where a sign hangs, and the one instanced draw that lights
 * every one of them.
 *
 * Placement is derived, not authored. Shops arrive as `storefront` point objects (see
 * isStorefrontPoi in maplibreProvider, and objectKind in normalize) — a coordinate and a
 * name, with no idea which wall they belong to. So each one is matched to the nearest
 * building edge and the sign is hung on that wall, facing out. A POI with no building
 * within reach gets no sign at all, which is the right answer: it is a market stall or a
 * mis-placed node, not a frontage.
 *
 * The sign face is drawn by a shader rather than by geometry or a texture: a rounded
 * rectangle of tube with a few bars of "lettering" inside it, seeded per sign so no two
 * are identical, and a flicker on the unlucky quarter of them. At the distance a sign is
 * read from, that is indistinguishable from real signage and costs one draw call for the
 * whole city.
 */
import * as THREE from 'three';

import type { WorldBuilding, WorldObject } from '../world/types';

export interface NeonSignPlacement {
  x: number;
  y: number;
  z: number;
  /** Yaw of the wall's outward normal — the sign faces the street it advertises to. */
  yaw: number;
  width: number;
  height: number;
  color: number;
  /** 0..1, stable per shop: picks the lettering pattern and whether this one flickers. */
  seed: number;
}

/** A storefront further than this from any building edge has no frontage to hang on. */
const MAX_ATTACH_DISTANCE = 28;
/** Cell size for the building lookup grid. Comfortably larger than a typical block-face
 * building, so a storefront's own building is almost always in the 9 cells searched. */
const LOOKUP_CELL = 80;
/** Clear of the wall, so the sign never z-fights the facade it hangs on. */
const WALL_STANDOFF = 0.34;
/** A sign scaled to the whole shopfront reads as a billboard; real shop signage is a
 * strip well short of the frontage it sits over. Capped small and scaled off a modest
 * share of the wall it hangs on, rather than most of it. */
const MIN_SIGN_WIDTH = 1.1;
const MAX_SIGN_WIDTH = 2.6;
/** Fraction of the wall segment's length a sign may span — proportion, not just a cap. */
const WALL_WIDTH_SHARE = 0.32;
/** Slim strip rather than a squat plaque — real tube signage reads as a horizontal
 * band, not a near-square panel. */
const SIGN_ASPECT = 0.22;
/** Ground clearance under a sign, set to clear the storefront's own ground-floor glass
 * (see buildingFacade.ts's `store` profile: firstFloorHeight + windowHeight lands
 * around 5.3m) rather than a fixed guess at door height — a sign here should sit above
 * the window it advertises, not over it. */
const MIN_SIGN_Y = 4.8;
const PREFERRED_SIGN_Y = 5.6;

/**
 * Saturated primaries only. A neon tube is a single gas discharge line, so real signage
 * lands on a handful of intense hues — a pastel palette reads as backlit plastic.
 */
const NEON_COLORS = [
  0xff3d7f, 0x35f0ff, 0xffcf3a, 0x63ff6a, 0xb46bff, 0xff6a2b,
] as const;

function hash01(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

interface WallHit {
  distanceSq: number;
  x: number;
  z: number;
  /** Outward unit normal of the wall segment. */
  nx: number;
  nz: number;
  segmentLength: number;
}

/** Closest point on a building's outer ring to `point`, with the outward normal of the
 * edge it landed on. Returns null for a degenerate footprint. */
function nearestWall(building: WorldBuilding, point: { x: number; z: number }): WallHit | null {
  const ring = building.rings[0];
  if (!ring || ring.length < 3) return null;
  let best: WallHit | null = null;
  // Ring centroid decides which way is "out" — the normal that points away from it.
  let centroidX = 0;
  let centroidZ = 0;
  for (const vertex of ring) { centroidX += vertex.x; centroidZ += vertex.z; }
  centroidX /= ring.length;
  centroidZ /= ring.length;

  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const distanceSq = (point.x - px) ** 2 + (point.z - pz) ** 2;
    if (best && distanceSq >= best.distanceSq) continue;
    const segmentLength = Math.sqrt(lengthSq);
    let nx = -dz / segmentLength;
    let nz = dx / segmentLength;
    if (nx * (px - centroidX) + nz * (pz - centroidZ) < 0) { nx = -nx; nz = -nz; }
    best = { distanceSq, x: px, z: pz, nx, nz, segmentLength };
  }
  return best;
}

/**
 * Hangs a sign on the wall nearest each storefront, at most one per building.
 *
 * Buildings are bucketed by their footprint's bounding box so the search per storefront
 * is over a handful of neighbours rather than the whole city — with a few thousand
 * buildings and a few hundred shops the naive version is the most expensive thing in the
 * build. Storefronts are taken in id order so the same snapshot always produces the same
 * signs, and the `limit` cut is stable rather than dependent on iteration order.
 */
/** Items per yield, matching the other placement walks. */
const NEON_CHUNK = 256;

/**
 * The incremental form, which is the real implementation.
 *
 * The last of the stages that ran whole between two of the world builder's yields. Unlike
 * the lamps and the trees this one *does* carry state across its outer loop — `taken`
 * stops two shops hanging a sign on the same building — so the question was not whether
 * state exists but whether pausing can reorder it. It cannot: the storefronts are sorted
 * by id before the walk begins, so the sequence `taken` is built up in is fixed by that
 * sort and not by where the frame ended.
 */
export function* generateNeonSignsJob(
  objects: WorldObject[],
  buildings: WorldBuilding[],
  limit: number,
): Generator<void, NeonSignPlacement[], void> {
  if (limit <= 0) return [];
  const storefronts = objects
    .filter((object) => object.kind === 'storefront')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!storefronts.length || !buildings.length) return [];

  const grid = new Map<string, WorldBuilding[]>();
  for (let buildingIndex = 0; buildingIndex < buildings.length; buildingIndex += 1) {
    if (buildingIndex > 0 && buildingIndex % NEON_CHUNK === 0) yield;
    const building = buildings[buildingIndex];
    const ring = building.rings[0];
    if (!ring || ring.length < 3) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const vertex of ring) {
      if (vertex.x < minX) minX = vertex.x;
      if (vertex.x > maxX) maxX = vertex.x;
      if (vertex.z < minZ) minZ = vertex.z;
      if (vertex.z > maxZ) maxZ = vertex.z;
    }
    for (let cx = Math.floor(minX / LOOKUP_CELL); cx <= Math.floor(maxX / LOOKUP_CELL); cx += 1) {
      for (let cz = Math.floor(minZ / LOOKUP_CELL); cz <= Math.floor(maxZ / LOOKUP_CELL); cz += 1) {
        const key = `${cx}:${cz}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(building); else grid.set(key, [building]);
      }
    }
  }

  const signs: NeonSignPlacement[] = [];
  const taken = new Set<string>();
  const maxDistanceSq = MAX_ATTACH_DISTANCE * MAX_ATTACH_DISTANCE;

  for (let shopIndex = 0; shopIndex < storefronts.length; shopIndex += 1) {
    if (shopIndex > 0 && shopIndex % NEON_CHUNK === 0) yield;
    const shop = storefronts[shopIndex];
    if (signs.length >= limit) break;
    const cellX = Math.floor(shop.point.x / LOOKUP_CELL);
    const cellZ = Math.floor(shop.point.z / LOOKUP_CELL);
    let bestHit: WallHit | null = null;
    let bestBuilding: WorldBuilding | null = null;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        for (const building of grid.get(`${cellX + dx}:${cellZ + dz}`) ?? []) {
          if (taken.has(building.id)) continue;
          // A sign has to fit between the door and the roof; a bungalow has no room.
          if (building.height < MIN_SIGN_Y + 0.8) continue;
          const hit = nearestWall(building, shop.point);
          if (!hit || hit.distanceSq > maxDistanceSq) continue;
          if (bestHit && hit.distanceSq >= bestHit.distanceSq) continue;
          bestHit = hit;
          bestBuilding = building;
        }
      }
    }
    if (!bestHit || !bestBuilding) continue;
    taken.add(bestBuilding.id);

    const seed = hash01(shop.id);
    const width = Math.min(MAX_SIGN_WIDTH, Math.max(MIN_SIGN_WIDTH, bestHit.segmentLength * WALL_WIDTH_SHARE));
    const height = width * SIGN_ASPECT;
    // Sits at shop-sign height where the building allows it, and tucks down under the
    // eaves on anything shorter rather than poking through the roof.
    const y = Math.min(PREFERRED_SIGN_Y, bestBuilding.height - height / 2 - 0.5);
    if (y < MIN_SIGN_Y) continue;
    signs.push({
      x: bestHit.x + bestHit.nx * WALL_STANDOFF,
      z: bestHit.z + bestHit.nz * WALL_STANDOFF,
      y,
      yaw: Math.atan2(bestHit.nx, bestHit.nz),
      width,
      height,
      color: NEON_COLORS[Math.floor(seed * NEON_COLORS.length) % NEON_COLORS.length],
      seed,
    });
  }
  return signs;
}

/** The all-at-once form, for callers with no frame to protect. Drains the generator, so a
 * sliced build and an eager one cannot hang different signs. */
export function generateNeonSigns(
  objects: WorldObject[],
  buildings: WorldBuilding[],
  limit: number,
): NeonSignPlacement[] {
  const job = generateNeonSignsJob(objects, buildings, limit);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}


/**
 * How far the quad extends past the tube frame, as a multiple of the frame's own half
 * size. This is the backing plate, which used to be a second instanced box behind the
 * face; folding it into the same quad is what takes a sign from two draws and fourteen
 * triangles down to one draw and two.
 */
const PLATE_MARGIN = 1.09;
/** Unlit colour of that plate. */
const PLATE_COLOR = 'vec3(0.078, 0.086, 0.102)';

const SHADER_DEFINES = `
  #define PLATE_MARGIN ${PLATE_MARGIN.toFixed(3)}
  #define PLATE_COLOR ${PLATE_COLOR}
`;

const NEON_VERTEX_SHADER = `
  attribute vec3 aNeonColor;
  attribute float aSeed;
  varying vec2 vNeonUv;
  varying vec3 vNeonColor;
  varying float vSeed;
  varying float vFogDepth;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vNeonUv = uv;
    vNeonColor = aNeonColor;
    vSeed = aSeed;
    #include <begin_vertex>
    #include <project_vertex>
    vFogDepth = -mvPosition.z;
    #include <logdepthbuf_vertex>
  }
`;

const NEON_FRAGMENT_SHADER = `
  uniform float uTime;
  /** 0 by day, 1 at night — signs are on around the clock but only *read* as light
   * after dark, exactly like the real thing. */
  uniform float uNight;
  /** Ambient the backing plate is shaded by: the sky colour times how bright the day is.
   * The plate used to be a lit MeshStandardMaterial on its own instanced box; it is a
   * flat dark panel seen edge-on from a moving vehicle, and one uniform reproduces it
   * closely enough to be worth the draw call and the twelve triangles it saves. */
  uniform vec3 uPlateLight;
  uniform float fogDensity;
  uniform vec3 fogColor;

  varying vec2 vNeonUv;
  varying vec3 vNeonColor;
  varying float vSeed;
  varying float vFogDepth;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  /** Signed distance to a rounded rectangle, negative inside. */
  float roundedBox(vec2 point, vec2 halfSize, float radius) {
    vec2 d = abs(point) - halfSize + radius;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
  }

  void main() {
    // -1..1 across the sign, with x stretched so the tube keeps a constant thickness on
    // a wide sign instead of being squashed by the instance's scale. The quad is scaled
    // out past the tube by PLATE_MARGIN, so the tube's own coordinates are shrunk back
    // by the same factor and the surround is the backing plate.
    vec2 p = (vNeonUv * 2.0 - 1.0) * PLATE_MARGIN;
    float aspect = 3.3;
    vec2 stretched = vec2(p.x * aspect, p.y);

    float border = roundedBox(stretched, vec2(aspect - 0.14, 0.86), 0.5);
    float tube = 1.0 - smoothstep(0.0, 0.1, abs(border));

    // Lettering: a run of vertical strokes at a per-sign pitch, clipped inside the
    // frame. Not readable as words, and not meant to be — it is the rhythm of lit
    // strokes that says "sign" from a moving vehicle.
    float pitch = 5.0 + floor(vSeed * 6.0) * 2.0;
    float strokes = smoothstep(0.45, 0.62, abs(sin(stretched.x * pitch + vSeed * 24.0)));
    float inside = (1.0 - smoothstep(-0.1, 0.06, border)) * step(abs(p.y), 0.46);
    float glyphs = strokes * inside;

    // The halo the tube throws onto its own backing plate.
    float halo = exp(-abs(border) * 2.6) * 0.4;

    // A quarter of the signs have a failing tube. Two beats at once (a fast buzz under a
    // slow sag) so it reads as a fault rather than a sine wave.
    float faulty = step(0.75, fract(vSeed * 7.3));
    float buzz = 0.72 + 0.28 * sin(uTime * (26.0 + vSeed * 30.0));
    float sag = 0.75 + 0.25 * sin(uTime * 2.3 + vSeed * 6.0);
    float flicker = mix(1.0, buzz * sag, faulty);

    float energy = (tube + glyphs * 0.85 + halo) * flicker * mix(0.3, 1.0, uNight);

    // The tube adds light to the plate behind it rather than replacing it, so a sign
    // brightens its own backing instead of punching a hole in it. The core runs past
    // white on purpose — a saturated hue with a blown-out centre is what a discharge tube
    // actually looks like, and tone mapping brings it back into range.
    vec3 emission = vNeonColor * energy + vec3(tube * flicker * 0.35 * uNight);
    // The plate itself: dark, shaded only by the ambient uniform, and lifted a little
    // where the tube is throwing light onto it.
    vec3 plate = PLATE_COLOR * uPlateLight;

    // Fog takes an emissive surface's energy away with distance rather than tinting it;
    // mixing the tube toward the fog colour would make a distant sign glow *brighter*
    // through the haze. The plate is an ordinary surface and fogs the ordinary way.
    float transmit = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    gl_FragColor = vec4(mix(fogColor, plate, transmit) + emission * transmit, 1.0);

    #include <logdepthbuf_fragment>
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** A built batch of signs plus the per-frame drive for their flicker. */
export interface NeonSignBatch {
  group: THREE.Group;
  /** `timeSeconds` runs the flicker; `nightFactor` (0..1) brings the signs up at dusk. */
  update(timeSeconds: number, nightFactor: number): void;
}

/** Ambient the backing plate is shaded by at noon and at midnight. Stands in for the
 * MeshStandardMaterial the plate used to be — see uPlateLight. */
const PLATE_LIGHT_DAY = 1;
const PLATE_LIGHT_NIGHT = 0.28;

export function createNeonSigns(signs: NeonSignPlacement[]): NeonSignBatch {
  const group = new THREE.Group();
  group.name = 'world:neon-signs';
  if (!signs.length) return { group, update: () => {} };

  const faceGeometry = new THREE.PlaneGeometry(1, 1);
  const colors = new Float32Array(signs.length * 3);
  const seeds = new Float32Array(signs.length);
  const color = new THREE.Color();
  signs.forEach((sign, index) => {
    color.setHex(sign.color);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
    seeds[index] = sign.seed;
  });
  faceGeometry.setAttribute('aNeonColor', new THREE.InstancedBufferAttribute(colors, 3));
  faceGeometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: SHADER_DEFINES + NEON_VERTEX_SHADER,
    fragmentShader: SHADER_DEFINES + NEON_FRAGMENT_SHADER,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uNight: { value: 0 },
      uPlateLight: { value: new THREE.Color(PLATE_LIGHT_DAY, PLATE_LIGHT_DAY, PLATE_LIGHT_DAY) },
    }]),
    // Opaque now that the plate is part of the same quad: the sign writes depth like the
    // solid object it is, which is also what stops a sign on a near wall being drawn over
    // by the building behind it.
    transparent: false,
    depthWrite: true,
    // `fog: true` is what makes the renderer keep fogDensity current from the scene each
    // frame; the shader then applies it its own way (additive surfaces have to lose
    // energy with distance, not blend toward the fog colour). UniformsLib.fog is merged
    // in for the same reason the road material does it — a plain ShaderMaterial's
    // uniform set is exactly what it declares, and refreshing a fog uniform that was
    // never declared throws.
    fog: true,
  });

  const faces = new THREE.InstancedMesh(faceGeometry, material, signs.length);
  faces.name = 'world:neon-signs:faces';
  // A sign is a lamp on a wall: it lights the facade rather than shadowing it, and it is
  // shaded entirely by its own shader, so neither shadow flag has anything to do here.
  faces.castShadow = false;
  faces.receiveShadow = false;
  // Every sign in one batch, scattered across the whole snapshot: the batch's own bounds
  // are the world's, so a frustum test on it can only ever say "yes" while costing a
  // bounding-sphere computation over every instance.
  faces.frustumCulled = false;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  signs.forEach((sign, index) => {
    quaternion.setFromAxisAngle(up, sign.yaw);
    position.set(sign.x, sign.y, sign.z);
    // Scaled out to the plate's own size; the shader shrinks the tube back inside it.
    scale.set(sign.width * PLATE_MARGIN, sign.height * PLATE_MARGIN, 1);
    faces.setMatrixAt(index, matrix.compose(position, quaternion, scale));
  });
  faces.instanceMatrix.needsUpdate = true;

  group.add(faces);
  const plateLight = material.uniforms.uPlateLight.value as THREE.Color;
  return {
    group,
    update(timeSeconds: number, nightFactor: number) {
      material.uniforms.uTime.value = timeSeconds;
      material.uniforms.uNight.value = nightFactor;
      const lit = PLATE_LIGHT_DAY + (PLATE_LIGHT_NIGHT - PLATE_LIGHT_DAY) * Math.min(1, Math.max(0, nightFactor));
      plateLight.setRGB(lit, lit, lit);
    },
  };
}
