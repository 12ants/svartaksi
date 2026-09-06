/**
 * A procedurally generated (no image asset) tangent-space normal map standing in for
 * fine grass-blade-scale bumps on lawn/grass-like landuse — without it, those surfaces
 * are a flat, uniformly-lit color that reads as plastic/painted rather than a textured
 * lawn. Built once from a small deterministic value-noise height field and shared by
 * every grass-like landuse material (see threeWorld.ts).
 */
import * as THREE from 'three';

const TEXTURE_SIZE = 128;
/**
 * Repeats per world unit. Landuse polygons are built by ExtrudeGeometry from a Shape in
 * *meters*, and Three's default UV generator emits those shape coordinates verbatim —
 * so this multiplies meters, not a normalized 0..1 span. The old value (24) therefore
 * meant 24 tiles per meter: far below a pixel at any driving distance, which turned
 * every lawn into a shimmering wisp pattern rather than texture. One tile per 6m is
 * roughly the scale the bump detail was drawn for.
 */
const TILE_REPEAT = 1 / 6;
/** Exaggerates the height field's slope before it's turned into a normal — higher reads
 * as bumpier/rougher blades, lower as a smoother, more mown lawn. */
const BUMP_STRENGTH = 1.6;

/** Tiny deterministic LCG — no external RNG dependency, and stays identical across
 * reloads (matches this codebase's general "regenerate the same city every time"
 * determinism, e.g. buildingFacade.ts's noise texture). */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** A size×size grid of random values, wrapping (so it tiles seamlessly). */
function randomGrid(size: number, seed: number): Float32Array {
  const rand = createRng(seed);
  const grid = new Float32Array(size * size);
  for (let index = 0; index < grid.length; index += 1) grid[index] = rand();
  return grid;
}

/** Bilinear sample of a wrapping grid at fractional coordinates (u, v), each in [0, size). */
function sampleGrid(grid: Float32Array, size: number, u: number, v: number): number {
  const x0 = Math.floor(u) % size;
  const y0 = Math.floor(v) % size;
  const x1 = (x0 + 1) % size;
  const y1 = (y0 + 1) % size;
  const fx = u - Math.floor(u);
  const fy = v - Math.floor(v);
  const top = grid[y0 * size + x0] + (grid[y0 * size + x1] - grid[y0 * size + x0]) * fx;
  const bottom = grid[y1 * size + x0] + (grid[y1 * size + x1] - grid[y1 * size + x0]) * fx;
  return top + (bottom - top) * fy;
}

/** Two-octave fractal value noise (a coarse rolling layer plus a finer detail layer)
 * sampled across the full output resolution — plain single-frequency value noise looks
 * too regular/blobby for grass; this reads as more organic without real Perlin/simplex. */
function heightField(size: number): Float32Array {
  const coarse = randomGrid(8, 0x9e3779b9);
  const fine = randomGrid(32, 0x85ebca6b);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coarseValue = sampleGrid(coarse, 8, (x / size) * 8, (y / size) * 8);
      const fineValue = sampleGrid(fine, 32, (x / size) * 32, (y / size) * 32);
      height[y * size + x] = coarseValue * 0.6 + fineValue * 0.4;
    }
  }
  return height;
}

let sharedGrassNormalMap: THREE.DataTexture | null = null;

/** Converts the height field to a tangent-space normal map (standard OpenGL convention:
 * +X right, +Y up the texture, +Z out of the surface) via a central-difference slope
 * estimate, then packs each component into a byte as (component * 0.5 + 0.5) * 255. */
export function getGrassNormalMap(): THREE.DataTexture {
  if (sharedGrassNormalMap) return sharedGrassNormalMap;

  const size = TEXTURE_SIZE;
  const height = heightField(size);
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * BUMP_STRENGTH;
      const dy = (at(x, y + 1) - at(x, y - 1)) * BUMP_STRENGTH;
      const normal = new THREE.Vector3(-dx, -dy, 1).normalize();
      const index = (y * size + x) * 4;
      data[index] = Math.round((normal.x * 0.5 + 0.5) * 255);
      data[index + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
      data[index + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
      data[index + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(TILE_REPEAT, TILE_REPEAT);
  // DataTexture defaults to no mipmaps and LinearFilter, which leaves a tiling detail
  // map with nothing to fall back on as it recedes — see setWorldTextureAnisotropy.
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  sharedGrassNormalMap = texture;
  return texture;
}
