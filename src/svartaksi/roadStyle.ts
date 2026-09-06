/**
 * Road "family" resolution: classify an OSM `highway` tag into a small visual
 * vocabulary (path / minor / major) and resolve the shared ShaderMaterial that
 * paints it — pale and edge-faded for paths, plain asphalt for minor streets,
 * a dashed center line for major roads. One material per family, cached
 * by caller, so a whole city of roads costs three shader programs, not one per road.
 */
import * as THREE from 'three';

import { DEPTH_BIAS, withLogDepthBias } from '../world/depthBias';

import { createSceneLightingUniforms, SCENE_LIGHTING_PARS_GLSL } from '../world/shaderLighting';

export type RoadFamily = 'path' | 'minor' | 'major';

const PATH_KINDS = new Set([
  'path', 'footway', 'pedestrian', 'cycleway', 'track', 'steps', 'bridleway', 'corridor',
]);
const MAJOR_KINDS = new Set(['motorway', 'trunk', 'primary', 'secondary']);

/**
 * Motorways and trunk roads paint as their own style tier — see RoadStyleKey — but stay
 * in the 'major' RoadFamily everywhere else in the codebase: trafficLights.ts counts
 * `family === 'major'` junction complexity by it, and busStops.ts's own comment on why
 * its shelter-eligible set deliberately excludes motorway/trunk depends on 'major' still
 * meaning what it always has. Splitting the *paint*, not the *family*, gets highways a
 * distinct look without moving either of those.
 */
const HIGHWAY_KINDS = new Set(['motorway', 'trunk']);

/**
 * OpenMapTiles' `transportation` layer (and, less often, raw `highway` tags) carries
 * "ways" that aren't a physical paved/walked surface at all — a ferry route, a rail
 * line, a cable car. Rendering these as a road ribbon draws a dark strip of "pavement"
 * straight across open water or parkland, which reads as broken terrain rather than
 * a route. These are filtered out where WorldData is built, before any road ever
 * reaches geometry — not just re-skinned to a different family.
 */
const NON_PHYSICAL_KINDS = new Set(['ferry', 'rail', 'transit', 'aerialway', 'light_rail', 'subway']);

export function isPhysicalRoadKind(kind: string): boolean {
  return !NON_PHYSICAL_KINDS.has(kind);
}

/**
 * Bus-only carriageways. Painted as ordinary asphalt they put a road where general
 * traffic cannot go, and OSM often maps one alongside the street it runs beside, which
 * renders as a second ribbon overlapping the first.
 */
const UNDRAWN_KINDS = new Set(['bus', 'bus_guideway']);

/**
 * Service roads worth drawing and the ones that are only clutter.
 *
 * `service` is one class covering two very different things. Driveways, parking aisles
 * and alley stubs are short spurs that add a spray of tarmac fragments across every yard
 * and car park without leading anywhere — those go. Plain service roads are the park
 * drives and back streets that make up most of the drivable network in a place like
 * Djurgården: dropping the class wholesale left the spawn point with no road under it at
 * all, since the two ways within 120m of it are both `service`.
 */
const SERVICE_CLUTTER = new Set(['driveway', 'parking_aisle', 'alley', 'yard', 'drive-through']);

function isServiceClutter(properties: Record<string, unknown>): boolean {
  const subclass = String(properties.service ?? properties.subclass ?? '').toLowerCase();
  return SERVICE_CLUTTER.has(subclass);
}

/** Ways carried by the source data that this world does not draw at all. Service clutter
 * is excluded separately, by tag rather than by kind — see isRenderedWay. */
export function isRenderedRoadKind(kind: string): boolean {
  return isPhysicalRoadKind(kind) && !UNDRAWN_KINDS.has(kind);
}

/**
 * Whether a source way belongs in the world at all, given its kind and its own tags.
 *
 * This used to also drop tunnels and negative-layer ways, on the reasoning that this
 * renderer draws the ground as a solid surface and a tunnel painted on top of it reads as
 * a road crossing over whatever it actually passes beneath. That conflated two different
 * questions: whether a way is real road the world (and routing) should know about, and
 * whether its surface should be *drawn*. A bus or a route search still needs a tunnel
 * edge to exist even when nothing paints it — see backlog item 9. Surface drawing is now
 * decided separately, per road, by `surfaceVisibility` (`../world/surfaceVisibility.ts`),
 * off the normalized `structure`/`layer` fields the provider boundary attaches to each
 * `WorldRoad`. This function only ever answers "does this way exist in `WorldData`."
 */
export function isRenderedWay(kind: string, properties: Record<string, unknown>): boolean {
  if (!isRenderedRoadKind(kind)) return false;
  if (kind === 'service' && isServiceClutter(properties)) return false;
  return true;
}

/**
 * Roads the bus is willing to route over: paved carriageways only.
 *
 * The bus used to plan across the whole road graph, which includes footways, cycle paths
 * and park tracks — so a route could send an 11-metre vehicle down a gravel walking path
 * between two lawns. Paths are excluded by family. Service is *not* excluded here,
 * because the driveways and parking aisles were already dropped from the world by
 * isRenderedWay — what reaches the graph under that class is real road.
 */
export function isBusDrivableKind(kind: string): boolean {
  return isPhysicalRoadKind(kind) && getRoadFamily(kind) !== 'path';
}

export function getRoadFamily(kind: string): RoadFamily {
  if (PATH_KINDS.has(kind)) return 'path';
  if (MAJOR_KINDS.has(kind)) return 'major';
  return 'minor';
}

/** Paint tier — like RoadFamily, but splits motorway/trunk out of 'major' into their own
 * 'highway' look. See HIGHWAY_KINDS for why the RoadFamily itself stays merged. */
export type RoadStyleKey = RoadFamily | 'highway';

export function getRoadStyleKey(kind: string): RoadStyleKey {
  if (HIGHWAY_KINDS.has(kind)) return 'highway';
  return getRoadFamily(kind);
}

export interface RoadStyle {
  color: string;
  /** Fade alpha to 0 toward the road edges (paths reading as informal, not a hard slab). */
  edgeFade: boolean;
  /** Painted (optionally dashed) line down the middle. */
  centerLine: boolean;
  lineColor: string;
  /** Dash length in meters; 0 draws a solid line. */
  dashLength: number;
  dashGap: number;
  /** Line half-width as a fraction of the road's own half-width (0-1). */
  lineWidth: number;
  /** Overall alpha multiplier (0-1) applied on top of edge fade — lets a family (paths)
   * read as almost invisible, a faint suggestion of a trail, rather than a solid ribbon. */
  opacity: number;
  /**
   * 0-1 weight on everything that makes a surface read as *paved*: aggregate grain,
   * polished wheel tracks, grime toward the kerb, and the wet-looking grazing sheen
   * asphalt picks up from the sky. Paths sit at 0 — they're already a faint,
   * edge-faded suggestion of a trail, and graining them just made them noisy.
   */
  wear: number;
}

const ROAD_STYLES: Record<RoadStyleKey, RoadStyle> = {
  path: {
    // Muted toward a neutral ground tone (was a much warmer, more contrasty tan) and
    // rendered at very low overall opacity — pedestrian/cycle paths should read as
    // barely-there, not a paved ribbon competing visually with real roads.
    color: '#9a9c8c', edgeFade: true, centerLine: false,
    lineColor: '#ffffff', dashLength: 0, dashGap: 0, lineWidth: 0, opacity: 0.22, wear: 0,
  },
  minor: {
    color: '#3a3d3f', edgeFade: false, centerLine: false,
    lineColor: '#ffffff', dashLength: 0, dashGap: 0, lineWidth: 0, opacity: 1, wear: 1,
  },
  major: {
    color: '#2c2f32', edgeFade: false, centerLine: true,
    lineColor: '#e9e4d4', dashLength: 3.2, dashGap: 2.4, lineWidth: 0.045, opacity: 1, wear: 1,
  },
  // A shade lighter and cooler than 'major' — newer, more heavily maintained asphalt —
  // with a solid rather than dashed centre line (a motorway/trunk carriageway is divided,
  // not an overtaking lane) painted wider and closer to white, the way a motorway's own
  // more heavily retroreflective marking reads at night against ordinary road paint.
  highway: {
    color: '#34373b', edgeFade: false, centerLine: true,
    lineColor: '#f4f1e4', dashLength: 0, dashGap: 0, lineWidth: 0.06, opacity: 1, wear: 1,
  },
};

export function getRoadStyle(kind: string): RoadStyle {
  return ROAD_STYLES[getRoadStyleKey(kind)];
}

/**
 * How far the surface normal is tilted toward the centreline at the kerb, as a fraction
 * of the up vector — roughly a 3% cross-fall, which is what a real carriageway is built
 * with so water runs off it.
 *
 * The geometry stays flat: a ribbon two vertices wide has no room for a crown, and
 * building one would triple the vertex count of every road in the world. Tilting the
 * *shading* normal instead gets what the crown is actually for visually — the two halves
 * of the carriageway catch the sky and the sun at slightly different angles, so a wide
 * road reads as a surface with a shape rather than as a flat grey cutout, and the
 * grazing sheen forms a bright band along the crown exactly as it does on a wet street.
 */
const ROAD_CAMBER = 0.06;

export const ROAD_VERTEX_SHADER = `
  attribute vec3 aRoadUV;
  attribute vec3 aRoadSide;
  varying vec3 vRoadUV;
  varying vec3 vRoadSide;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec3 vViewPosition;
  varying float vFogDepth;

  #include <common>
  #include <logdepthbuf_pars_vertex>
  #include <shadowmap_pars_vertex>

  void main() {
    vRoadUV = aRoadUV;
    vRoadSide = (modelMatrix * vec4(aRoadSide, 0.0)).xyz;
    // Computed explicitly rather than reusing the worldPosition that
    // <worldpos_vertex> only declares under a specific set of feature defines.
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;

    #include <beginnormal_vertex>
    #include <defaultnormal_vertex>
    vWorldNormal = transformNormalByInverseViewMatrix(transformedNormal, viewMatrix);

    vec3 transformed = vec3(position);
    #include <project_vertex>
    // Camera-space position — the space Three uploads dynamic light positions in, see
    // dynamicLightsContribution in shaderLighting.ts.
    vViewPosition = mvPosition.xyz;
    vFogDepth = -mvPosition.z;
    #include <worldpos_vertex>
    #include <shadowmap_vertex>
    #include <logdepthbuf_vertex>
  }
`;

export const ROAD_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform vec3 uLineColor;
  uniform float uEdgeFade;
  uniform float uCenterLine;
  uniform float uLineWidth;
  uniform float uDashLength;
  uniform float uDashGap;
  uniform float uOpacity;
  uniform float uWear;
  uniform float uCamber;
  uniform float uAlphaClip;
  // Declared directly (not via the <fog_pars_fragment> chunk) — the chunk's
  // conditionally-declared uniforms were being dropped from this program's
  // active-uniform list, which crashes WebGLRenderer's per-frame fog refresh.
  uniform vec3 fogColor;
  uniform float fogDensity;

  varying vec3 vRoadUV;
  varying vec3 vRoadSide;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec3 vViewPosition;
  varying float vFogDepth;

  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>
  #include <logdepthbuf_pars_fragment>
${SCENE_LIGHTING_PARS_GLSL}

  float roadHash(vec2 p) {
    vec2 wrapped = fract(p * vec2(127.31, 311.7));
    wrapped += dot(wrapped, wrapped + 41.17);
    return fract(wrapped.x * wrapped.y);
  }

  /** Smooth value noise in world meters — the aggregate/patching grain that keeps a road
   * from reading as one flat swatch of gray. */
  float roadNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 offset = fract(p);
    vec2 blend = offset * offset * (3.0 - 2.0 * offset);
    return mix(
      mix(roadHash(cell), roadHash(cell + vec2(1.0, 0.0)), blend.x),
      mix(roadHash(cell + vec2(0.0, 1.0)), roadHash(cell + vec2(1.0, 1.0)), blend.x),
      blend.y
    );
  }

  void main() {
    // vRoadUV: x = distance along the road (meters, for dash phase), y = -1..1 across
    // width, z = 0 at the extended tip rising to 1 at the road's own mapped end.
    float side = abs(vRoadUV.y);
    vec3 color = uColor;
    // A ribbon that stopped at full opacity ended in a hard rectangular lip standing
    // proud of the surface it met. Fading the tip instead lets the last half-width
    // dissolve: a dead end trails off, and at a junction the crossing road's own body
    // shows through the overlap rather than seaming against it.
    float alpha = smoothstep(0.0, 1.0, clamp(vRoadUV.z, 0.0, 1.0));

    if (uEdgeFade > 0.5) {
      alpha *= 1.0 - smoothstep(0.4, 1.0, side);
    }

    // Surface detail is meter-scale, so it aliases into noise once a fragment covers
    // more than a few centimeters. Fading it out with distance is cheaper and steadier
    // than any amount of filtering, and the far end of a road is fog-bound anyway.
    float detailFade = uWear * (1.0 - smoothstep(40.0, 110.0, vFogDepth));
    if (detailFade > 0.001) {
      // Two octaves: coarse patching/repair variation, plus the chip-seal aggregate.
      float grain = roadNoise(vWorldPosition.xz * 2.7) * 0.65
        + roadNoise(vWorldPosition.xz * 13.0) * 0.35;
      color *= 1.0 + (grain - 0.5) * 0.22 * detailFade;
      // Wheel tracks: two polished bands where traffic actually runs, roughly halfway
      // out to each kerb.
      float track = exp(-pow((side - 0.46) / 0.17, 2.0));
      color *= 1.0 - track * 0.08 * detailFade;
      // Grit and road dirt collect against the kerb, so the outer fifth is dirtier and
      // slightly warmer than the running surface.
      color = mix(color, color * vec3(0.76, 0.75, 0.71), smoothstep(0.74, 1.0, side) * detailFade);
    }

    // Lane markings antialias against their own screen-space footprint: a dash edge or
    // a painted line is a few centimeters wide on a surface that recedes to the
    // horizon, so a fixed-width smoothstep shimmers badly at any real driving distance.
    float sidePixel = fwidth(side);
    if (uCenterLine > 0.5) {
      float dashOn = 1.0;
      if (uDashLength > 0.0) {
        float period = uDashLength + uDashGap;
        float alongPixel = fwidth(vRoadUV.x);
        float phase = mod(vRoadUV.x, period);
        dashOn = smoothstep(-alongPixel, alongPixel, uDashLength - phase);
      }
      float mask = (1.0 - smoothstep(uLineWidth - sidePixel, uLineWidth + sidePixel, side)) * dashOn;
      color = mix(color, uLineColor, mask);
    }

    // Cross-fall: tilt the normal toward the crown, away from whichever kerb this
    // fragment is nearer. See ROAD_CAMBER.
    vec3 cambered = normalize(vWorldNormal - vRoadSide * (vRoadUV.y * uCamber));
    color = shadeSurface(color, cambered, getShadowMask(), vViewPosition);

    // Asphalt is a rough dielectric: nearly matte head-on, but it picks the sky up at a
    // grazing angle, which is why a road ahead of you always looks paler and slightly wet
    // while the same road under your wheels looks black. A Fresnel-weighted sky term is
    // the cheap version of that, and it is the single strongest realism cue on a surface
    // this large and this flat.
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float grazing = pow(1.0 - clamp(dot(viewDirection, cambered), 0.0, 1.0), 5.0);
    color += uSkyColor * uAmbientIntensity * grazing * 0.09 * uWear;

    // A deck writes depth (see getOrCreateRoadMaterial's 'elevated' variant), and a depth
    // write happens whatever the fragment's alpha is — so the see-through fringe the tip
    // fade and the edge fade leave behind was punching a hole through everything drawn
    // after it, most visibly the water and the road under a bridge's own end. Ground
    // roads do not write depth and so keep the soft fade; on a deck the near-invisible
    // fringe is discarded outright instead of written as an invisible occluder.
    if (alpha * uOpacity < uAlphaClip) discard;

    gl_FragColor = vec4(color, alpha * uOpacity);

    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);

    #include <logdepthbuf_fragment>
    #include <tonemapping_fragment>
    // THREE.Color stores values in linear space (ColorManagement); built-in
    // materials convert back to the renderer's sRGB output via this chunk, but
    // a custom ShaderMaterial has to opt in explicitly or everything renders
    // far too dark.
    #include <colorspace_fragment>
  }
`;

/**
 * `elevated` selects the deck variant of a family's material: same paint, but it writes
 * depth.
 *
 * At ground level roads deliberately do not write depth (see the `depthWrite` note
 * below), because two coplanar ribbons crossing at a junction cannot be separated by a
 * depth test and flicker if you try. A deck several meters up is not coplanar with
 * anything — it is the one road surface with a world underneath it — and not writing
 * depth there means whatever is drawn afterwards paints straight through it: the road the
 * bridge crosses over shows up on top of the bridge, which is the single most obvious way
 * a grade separation reads as broken. Only geometry actually standing off the ground gets
 * this variant, so the junction flicker the ground variant avoids is left exactly as it
 * was.
 */
export function getOrCreateRoadMaterial(
  kind: string,
  materialsMap: Map<string, THREE.ShaderMaterial>,
  elevated = false,
): THREE.ShaderMaterial {
  const styleKey = getRoadStyleKey(kind);
  const cacheKey = elevated ? `${styleKey}:deck` : styleKey;
  const cached = materialsMap.get(cacheKey);
  if (cached) return cached;

  const style = ROAD_STYLES[styleKey];
  const material = new THREE.ShaderMaterial({
    vertexShader: withLogDepthBias(ROAD_VERTEX_SHADER, DEPTH_BIAS.surface),
    fragmentShader: ROAD_FRAGMENT_SHADER,
    // THREE.UniformsLib.fog supplies fogColor/fogDensity — for built-in material
    // types WebGLPrograms auto-merges that in, but for a plain ShaderMaterial the
    // renderer's per-frame uniform cache is just `material.uniforms` verbatim, so
    // without merging it in ourselves `material.fog = true` crashes the renderer
    // the first time it tries to refresh a fog uniform that was never declared here.
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, THREE.UniformsLib.lights, {
      ...createSceneLightingUniforms(),
      uColor: { value: new THREE.Color(style.color) },
      uLineColor: { value: new THREE.Color(style.lineColor) },
      uEdgeFade: { value: style.edgeFade ? 1 : 0 },
      uCenterLine: { value: style.centerLine ? 1 : 0 },
      uLineWidth: { value: style.lineWidth },
      uDashLength: { value: style.dashLength },
      uDashGap: { value: style.dashGap },
      uOpacity: { value: style.opacity },
      uWear: { value: style.wear },
      // Paths are a worn line through grass, not a built carriageway — nothing crowned
      // them, so they stay flat. `wear` already means "is this a paved surface".
      uCamber: { value: ROAD_CAMBER * style.wear },
      // Only the depth-writing deck variant clips; a ground ribbon keeps its full soft
      // fade because nothing it writes can occlude anything. See the fragment shader.
      uAlphaClip: { value: elevated ? 0.35 : 0 },
    }]),
    /**
     * Every family blends now, and none of them writes depth — except the deck variant,
     * which does; see `elevated` above.
     *
     * Two roads of the same class are exactly coplanar where they cross, so the depth
     * test cannot separate them — whichever fragment won that pixel flickered as the
     * camera moved, and no amount of millimetre elevation stepping fixed it because the
     * gaps sit below the depth buffer's resolution at the distances roads are seen from.
     * With depth writes off, roads simply paint over each other in `roadRenderOrder`,
     * which is deterministic per road, so a junction resolves the same way every frame
     * from every angle. Nothing is lost by not writing: roads lie flat on the ground and
     * never occlude anything above them, and they still depth-*test* against terrain and
     * buildings.
     *
     * Blending is also what makes the tip fade in the shader read as a fade rather than
     * as a hard alpha cutoff against the ground.
     */
    transparent: true,
    depthWrite: elevated,
    fog: true,
    lights: true,
    // Dead under the log depth buffer this scene runs with, and kept only so the
    // separation survives if that is ever switched off — the bias above is what actually
    // holds a road off the terrain today. See depthBias.ts.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  materialsMap.set(cacheKey, material);
  return material;
}
