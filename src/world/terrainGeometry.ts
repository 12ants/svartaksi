/**
 * The mesh for a landuse mound.
 *
 * This is deliberately a separate module from terrain.ts, and it is deliberately the only
 * place that draws the ground: what is rendered here is *sampled from*
 * `terrainRampProfile`, the same function `terrainHeightAt` solves the physics against.
 * The two agreeing is therefore structural rather than a matter of two files happening to
 * carry the same formula — which they did not, when the bank was one flat quad and the
 * profile was a smoothstep. That disagreement peaked at about a tenth of the mound's
 * height a quarter of the way up the slope: 10cm on a wood, and three quarters of a metre
 * with the height slider at maximum, felt as a wheel hovering or sinking at every landuse
 * boundary in the world.
 */
import * as THREE from 'three';
import {
  areaTerrainHeight,
  DEFAULT_TERRAIN_SETTINGS,
  insetRing,
  ringWinding,
  terrainRampProfile,
  terrainRampWidth,
  type TerrainSettings,
} from './terrain';
import type { LocalPoint, WorldArea } from './types';

/**
 * How many bands the bank is cut into.
 *
 * The profile is a smoothstep, so a single quad per edge is a chord across a curve and
 * misses it by up to 9.4% of the mound's height. Piecewise-linear error falls with the
 * square of the band width, so four bands bring that to about 0.6% — under a centimetre
 * on a wood, and still under 5cm with the height slider at its maximum, which is inside
 * the physics engine's own contact slop. Each band costs two triangles per ring segment
 * on a layer that casts no shadows.
 */
const SKIRT_BANDS = 4;

/**
 * A landuse polygon as a mound: its full mapped height across the middle, sloping down to
 * meet the ground plane exactly on its own outline.
 *
 * It used to be a flat-topped prism with a 5cm chamfer, which is a wall. That was fine
 * while nothing could touch it, but a wall is what a car actually hits at the edge of a
 * wood, and it is the reason the physics ground had a vertical metre-high step running
 * around every forest in the map. Sloping the sides inward costs nothing — the footprint
 * is unchanged, so no polygon grows into its neighbour — and gives every landuse edge a
 * bank a vehicle can drive up. See terrainRampWidth for how far in the slope reaches and
 * why it is capped.
 */
export function buildParkGeometry(
  park: WorldArea,
  settings: TerrainSettings = DEFAULT_TERRAIN_SETTINGS,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const ring = park.rings[0] ?? [];
  if (ring.length < 3) return geometry;
  const height = areaTerrainHeight(park, settings);
  const ramp = terrainRampWidth(ring, height, settings);

  // Contour lines up the bank: the outline itself at ground level, then one ring per band
  // inset by its share of the ramp and lifted to the height the profile gives there. With
  // no ramp there is one step and every ring coincides, which is the old vertical prism.
  const bands = ramp > 0 ? SKIRT_BANDS : 1;
  const contours: Array<{ ring: LocalPoint[]; y: number }> = [];
  for (let band = 0; band <= bands; band += 1) {
    const fraction = band / bands;
    contours.push({
      ring: fraction > 0 && ramp > 0 ? insetRing(ring, ramp * fraction) : ring,
      y: height * terrainRampProfile(fraction),
    });
  }

  // OSM rings arrive wound both ways, and the two halves of the mound need that answer
  // differently. The skirt is built from the ring itself, so its quads have to be ordered
  // by the ring's own winding; the cap is not, because ShapeUtils.triangulateShape
  // normalises the contour it is given and always hands back an upward-facing fan.
  const skirtFacesOut = ringWinding(ring) === -1;
  const positions: number[] = [];
  const uvs: number[] = [];
  // UVs in world metres, matching what ExtrudeGeometry's own generator produced for the
  // top face — the grass normal map is tiled against them.
  const emit = (point: LocalPoint, y: number) => {
    positions.push(point.x, y, point.z);
    uvs.push(point.x, -point.z);
  };

  const top = contours[contours.length - 1];
  const faces = THREE.ShapeUtils.triangulateShape(
    top.ring.map((point) => new THREE.Vector2(point.x, -point.z)),
    [],
  );
  for (const face of faces) {
    for (const index of face) emit(top.ring[index], top.y);
  }

  for (let band = 0; band < bands; band += 1) {
    const lower = contours[band];
    const upper = contours[band + 1];
    for (let index = 0; index < ring.length; index += 1) {
      const next = (index + 1) % ring.length;
      if (skirtFacesOut) {
        emit(lower.ring[index], lower.y);
        emit(lower.ring[next], lower.y);
        emit(upper.ring[next], upper.y);
        emit(lower.ring[index], lower.y);
        emit(upper.ring[next], upper.y);
        emit(upper.ring[index], upper.y);
      } else {
        emit(lower.ring[index], lower.y);
        emit(upper.ring[next], upper.y);
        emit(lower.ring[next], lower.y);
        emit(lower.ring[index], lower.y);
        emit(upper.ring[index], upper.y);
        emit(upper.ring[next], upper.y);
      }
    }
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}
