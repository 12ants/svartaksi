import * as THREE from 'three';

import { DEPTH_BIAS, withLogDepthBias } from './depthBias';
import { getGrassNormalMap } from '../svartaksi/grassTexture';

const GRASS_LIKE_KINDS = new Set([
  'park', 'garden', 'grass', 'grassland', 'meadow', 'recreation_ground', 'allotments',
  'pitch', 'village_green', 'dog_park', 'playground', 'golf_course', 'cemetery',
  'grave_yard', 'heath',
]);

let waterNormalMap: THREE.DataTexture | null = null;

function getWaterNormalMap(): THREE.DataTexture {
  if (waterNormalMap) return waterNormalMap;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (z * size + x) * 4;
      const wave = Math.sin(x * 0.45 + z * 0.17) * 18 + Math.sin(z * 0.6 - x * 0.12) * 10;
      data[index] = 128 + wave;
      data[index + 1] = 128 - wave * 0.65;
      data[index + 2] = 255;
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Repeats per world unit, not per polygon: water surfaces come from a ShapeGeometry
  // whose UVs are the shape's own coordinates in meters. See grassTexture's TILE_REPEAT
  // for the same trap — 18 meant 18 wave tiles per meter, which is noise, not water.
  texture.repeat.set(WATER_TILE_REPEAT, WATER_TILE_REPEAT);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = worldTextureAnisotropy;
  texture.needsUpdate = true;
  waterNormalMap = texture;
  return texture;
}

/** One wave tile per 12m of open water. */
const WATER_TILE_REPEAT = 1 / 12;

/**
 * Ground and water detail maps are viewed almost entirely at grazing angles here — a
 * lawn or a lake stretching to the horizon is the normal case, not the exception —
 * where mipmaps alone over-blur and anisotropic filtering is what keeps them readable.
 * The supported maximum is a renderer capability and these modules never see the
 * renderer, so the runtime pushes it in once at startup.
 */
let worldTextureAnisotropy = 1;

export function setWorldTextureAnisotropy(anisotropy: number): void {
  worldTextureAnisotropy = Math.max(1, Math.floor(anisotropy));
  for (const texture of [waterNormalMap, getGrassNormalMap()]) {
    if (!texture) continue;
    texture.anisotropy = worldTextureAnisotropy;
    texture.needsUpdate = true;
  }
}

/**
 * The clock every water and foam material animates from, hung on the material's own
 * `userData` so one write reaches the shader without the caller having to know what kind
 * of material it got. Nothing here accumulates: `seconds` is the same monotonic world
 * clock `ThreeWorld.setAnimationTime` hands the traffic signals, so a dropped frame, a
 * pause or a rebuild changes nothing about what the water shows.
 */
const WATER_TIME_KEY = 'waterTime';

function withWaterClock<T extends THREE.Material>(material: T): T {
  material.userData[WATER_TIME_KEY] = { value: 0 };
  return material;
}

/** Advances a material made here, and ignores anything else — so a caller can hand it
 * every material in a group without first sorting out which ones animate. */
export function setWaterAnimationTime(material: THREE.Material, seconds: number): void {
  const clock = material.userData[WATER_TIME_KEY] as { value: number } | undefined;
  if (clock) clock.value = seconds;
}

/**
 * Two normal-map samples scrolling in different directions at different scales, summed.
 *
 * One scrolling layer reads as a *sheet sliding sideways*, which is worse than a still
 * one — the eye locks onto the single direction immediately. Two layers moving against
 * each other never repeat within the time anyone looks at them, which is the whole of why
 * this is the standard cheap-water trick. Both are the same texture and the same fetch
 * count as a bump map, so the cost is one extra tap per water fragment.
 *
 * Replaces the whole `normal_fragment_maps` include rather than editing inside it: at
 * `onBeforeCompile` the includes are still unresolved, so the include directive is the
 * only thing there is to hook. With no normal map (the non-cinematic tier) the define is
 * absent and this compiles away to nothing, exactly as the stock include would.
 */
const WATER_NORMAL_CHUNK = `
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec2 waterDriftA = vec2( uWaterTime * 0.013, uWaterTime * 0.008 );
  vec2 waterDriftB = vec2( uWaterTime * -0.009, uWaterTime * 0.016 );
  vec3 waterN = texture2D( normalMap, vNormalMapUv + waterDriftA ).xyz * 2.0 - 1.0;
  waterN += texture2D( normalMap, vNormalMapUv * 1.7 + waterDriftB ).xyz * 2.0 - 1.0;
  vec3 mapN = normalize( waterN );
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );
#endif
`;

/**
 * How much of the surface's own colour is replaced by sky tint at a grazing view.
 *
 * Real water is nearly transparent looking straight down and nearly a mirror looking
 * along it; without that split a lake is one flat blue slab whichever way you face, which
 * is what it looked like before. This is the cheap half of it — the tint and the opacity,
 * not a reflection — and it is what makes a bay read as receding towards the horizon.
 *
 * Computed per vertex from the geometric normal and the eye, which is only defensible
 * because water here is always a horizontal sheet (see the flat-world note in
 * README/AGENTS): over a flat polygon the quantity varies smoothly with position and
 * interpolates exactly.
 */
const WATER_SKY_COLOR = new THREE.Color(0x9fc4d8);

export function createWaterMaterial(cinematicMaterials: boolean): THREE.MeshStandardMaterial {
  // The polygonOffset below is inert under this scene's logarithmic depth buffer; the
  // bias applied after construction is what keeps a lake sheet off the ground plane a
  // few centimetres beneath it. See depthBias.ts.
  const material = new THREE.MeshStandardMaterial({
    color: 0x2d7186,
    roughness: 0.18,
    metalness: 0.18,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    normalMap: cinematicMaterials ? getWaterNormalMap() : null,
    ...(cinematicMaterials ? { normalScale: new THREE.Vector2(0.18, 0.18) } : {}),
  });
  withWaterClock(material);
  const clock = material.userData[WATER_TIME_KEY] as { value: number };
  // Not applyLogDepthBias: that helper *assigns* onBeforeCompile, and this material needs
  // the bias and the water shader in the same hook. The bias itself is the same one, from
  // the same place.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = clock;
    shader.uniforms.uWaterSky = { value: WATER_SKY_COLOR };
    shader.vertexShader = withLogDepthBias(shader.vertexShader, DEPTH_BIAS.surface)
      .replace('void main() {', 'varying float vWaterFacing;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec3 waterWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vWaterFacing = abs( normalize( cameraPosition - waterWorld ).y );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform float uWaterTime;\nuniform vec3 uWaterSky;\nvarying float vWaterFacing;\nvoid main() {',
      )
      .replace('#include <normal_fragment_maps>', WATER_NORMAL_CHUNK)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float waterGrazing = 1.0 - clamp( vWaterFacing, 0.0, 1.0 );
        diffuseColor.rgb = mix( diffuseColor.rgb, uWaterSky, pow( waterGrazing, 3.0 ) * 0.75 );
        diffuseColor.a *= mix( 0.86, 1.0, waterGrazing * waterGrazing );`,
      );
  };
  // Two MeshStandardMaterials differing only in what onBeforeCompile did to them share a
  // compiled program otherwise, and whichever compiled first would decide for both — the
  // same trap applyLogDepthBias documents.
  material.customProgramCacheKey = () => `water:${DEPTH_BIAS.surface}`;
  return material;
}

/**
 * The shallows wash: the pale bottom-colour band that runs in from every shore.
 *
 * Deliberately *not* animated, unlike the water and the foam either side of it. It stands
 * in for the lake bed, and a bed does not move — giving it the same wash the foam has
 * would turn a shelving beach into a second ring of surf. It also means one fewer uniform
 * write per frame, and no shader patch at all.
 *
 * Its geometry carries a four-component colour (`buildShallowsGeometry`), which is what
 * lets the band fade to fully transparent at its inner edge instead of to another colour;
 * three.js switches the shader onto its alpha path off the attribute's itemSize.
 */
export function createShallowsMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** How far the foam wash travels along a shoreline per second, and how tightly the bands
 * are spaced along it — slow and long, so it reads as swell arriving rather than as a
 * texture scrolling. */
const FOAM_WASH_SPEED = 0.85;
const FOAM_WASH_WAVELENGTH = 11;

/**
 * The foam band's material: one per build, shared by every shoreline in it.
 *
 * The band's vertex colours already fade foam-white at the true shoreline to the water's
 * own tint at the inner edge (see `buildShorelineGeometry`). What is added here is the
 * only thing that made a still band read as painted-on rather than wet: its opacity
 * travels along the shore, so the foam washes in and out in slow bands instead of ringing
 * every lake with a constant white outline.
 */
export function createShorelineFoamMaterial(): THREE.MeshBasicMaterial {
  const material = withWaterClock(new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  const clock = material.userData[WATER_TIME_KEY] as { value: number };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = clock;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vFoamWorld;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vFoamWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uWaterTime;\nvarying vec3 vFoamWorld;\nvoid main() {')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float foamPhase = ( vFoamWorld.x + vFoamWorld.z ) / ${FOAM_WASH_WAVELENGTH.toFixed(1)} - uWaterTime * ${FOAM_WASH_SPEED.toFixed(2)};
        diffuseColor.a *= mix( 0.35, 1.0, 0.5 + 0.5 * sin( foamPhase ) );`,
      );
  };
  material.customProgramCacheKey = () => 'shorelineFoam';
  return material;
}

export function landuseMaterialOptions(kind: string): THREE.MeshStandardMaterialParameters {
  const grassLike = GRASS_LIKE_KINDS.has(kind);
  return {
    roughness: 1,
    normalMap: grassLike ? getGrassNormalMap() : null,
    ...(grassLike
      ? { normalScale: new THREE.Vector2(kind === 'pitch' ? 0.65 : 1, kind === 'pitch' ? 0.65 : 1) }
      : {}),
  };
}
