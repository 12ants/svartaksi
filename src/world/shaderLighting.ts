/**
 * The one lighting contract every custom ShaderMaterial in this project shares.
 *
 * Facades (buildingFacade.ts), roads (roadStyle.ts) and the sky dome (sky.ts) render
 * through hand-written shaders, so Three's own light uniforms don't reach them the way
 * they reach a MeshStandardMaterial. Each of those shaders used to carry its own
 * hardcoded light direction, which meant a road and the ground it sits on were lit by
 * two different, permanently disagreeing suns — the city stayed identically lit at noon
 * and at midnight while the sky around it went dark.
 *
 * The uniform *declarations* live in the same GLSL string as the shading function, so a
 * shader that includes SCENE_LIGHTING_PARS_GLSL and a material built from
 * createSceneLightingUniforms() cannot drift apart on names or types.
 */
import * as THREE from 'three';

export interface SceneLighting {
  /** World-space direction from a surface toward the sun (normalized). */
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** Hemisphere ambient looking up. */
  skyColor: THREE.Color;
  /** Hemisphere ambient looking down. */
  groundColor: THREE.Color;
  ambientIntensity: number;
  /** 0 in full daylight .. 1 in full night — drives how many windows read as lit. */
  nightFactor: number;
  /**
   * Stand-in for the street lighting this renderer deliberately does not simulate.
   *
   * The world is full of lamp posts, but their bulbs are emissive-looking
   * MeshBasicMaterial geometry, not real lights — hundreds of point lights would cost
   * every MeshStandardMaterial fragment in the scene under Three's forward lighting
   * model. Without something standing in for them, the physically correct answer for
   * asphalt at midnight is black, which is both true and unplayable in a driving game.
   * (The old shaders hid this behind a hardcoded 0.55 diffuse floor that never varied
   * with time of day at all.) This is a warm, view-independent fill that fades in
   * exactly as the sun sets, so the streets and the buildings lining them stay readable
   * and read as lit by the city rather than by a second sun.
   */
  nightFill: THREE.Color;
}

/**
 * Note on `uSunResponse`: it is the one uniform here a material owns rather than the
 * frame. applySceneLighting deliberately never writes it, so a material can dial how
 * hard the direct sun term hits it and keep that setting across every lighting update.
 * Facades use it to read as strongly side-lit (see FACADE_SUN_RESPONSE); anything that
 * has to match the MeshStandardMaterials around it leaves it at 1.
 */
export function createSceneLightingUniforms(): Record<string, THREE.IUniform> {
  return {
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xfff0cf) },
    uSunIntensity: { value: 1 },
    uSkyColor: { value: new THREE.Color(0xd9f0ff) },
    uGroundColor: { value: new THREE.Color(0x49513e) },
    uAmbientIntensity: { value: 1 },
    uNightFactor: { value: 0 },
    uNightFill: { value: new THREE.Color(0, 0, 0) },
    uSunResponse: { value: 1 },
  };
}

/** Copies a lighting state into any material built from createSceneLightingUniforms().
 * Tolerates materials that predate the contract (missing uniforms are skipped) so a
 * stale material can never throw during a per-frame update. */
export function applySceneLighting(material: THREE.ShaderMaterial, lighting: SceneLighting): void {
  const uniforms = material.uniforms;
  if (!uniforms) return;
  (uniforms.uSunDirection?.value as THREE.Vector3 | undefined)?.copy(lighting.sunDirection);
  (uniforms.uSunColor?.value as THREE.Color | undefined)?.copy(lighting.sunColor);
  (uniforms.uSkyColor?.value as THREE.Color | undefined)?.copy(lighting.skyColor);
  (uniforms.uGroundColor?.value as THREE.Color | undefined)?.copy(lighting.groundColor);
  (uniforms.uNightFill?.value as THREE.Color | undefined)?.copy(lighting.nightFill);
  if (uniforms.uSunIntensity) uniforms.uSunIntensity.value = lighting.sunIntensity;
  if (uniforms.uAmbientIntensity) uniforms.uAmbientIntensity.value = lighting.ambientIntensity;
  if (uniforms.uNightFactor) uniforms.uNightFactor.value = lighting.nightFactor;
}

/**
 * Uniform declarations plus `shadeSurface`, the shared surface-shading function.
 *
 * `shadowMask` is 1 in full light and 0 in full shadow — only the direct sun term is
 * masked, so a shadowed surface falls back to hemisphere ambient rather than to black.
 * Ambient is mixed by world-up so an upward-facing surface picks up sky color and a
 * downward-facing one picks up ground bounce, matching what the scene's real
 * HemisphereLight does for every MeshStandardMaterial in the same frame.
 */
export const SCENE_LIGHTING_PARS_GLSL = `
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform float uAmbientIntensity;
  uniform float uNightFactor;
  uniform vec3 uNightFill;
  uniform float uSunResponse;

  /**
   * Real THREE.SpotLight/PointLight objects in the scene — headlights, today; any other
   * dynamic light later. The lights_pars_begin chunk (which every caller of this chunk
   * already includes, for the sun's shadow map) declares spotLights[]/pointLights[] and
   * the getSpotLightInfo/getPointLightInfo helpers, but nothing was ever reading them:
   * this project's forward lighting is otherwise entirely the hand-rolled sun/ambient
   * terms above. Without this, a car's headlight cone lights every MeshStandardMaterial
   * it touches (its own body, another car) but sweeps invisibly across the road and walls.
   *
   * viewPosition is the fragment's camera-space position — the space Three uploads
   * light positions/directions in — so transformNormalByInverseViewMatrix (also from the
   * common chunk) brings each light's direction back to world space to compare against
   * worldNormal.
   */
  vec3 dynamicLightsContribution(vec3 worldNormal, vec3 viewPosition) {
    vec3 normal = normalize(worldNormal);
    vec3 result = vec3(0.0);
    IncidentLight light;
    #if NUM_POINT_LIGHTS > 0
      #pragma unroll_loop_start
      for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
        getPointLightInfo(pointLights[i], viewPosition, light);
        if (light.visible) {
          vec3 worldLightDir = transformNormalByInverseViewMatrix(light.direction, viewMatrix);
          result += light.color * max(dot(normal, worldLightDir), 0.0);
        }
      }
      #pragma unroll_loop_end
    #endif
    #if NUM_SPOT_LIGHTS > 0
      #pragma unroll_loop_start
      for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
        getSpotLightInfo(spotLights[i], viewPosition, light);
        if (light.visible) {
          vec3 worldLightDir = transformNormalByInverseViewMatrix(light.direction, viewMatrix);
          result += light.color * max(dot(normal, worldLightDir), 0.0);
        }
      }
      #pragma unroll_loop_end
    #endif
    return result;
  }

  vec3 shadeSurface(vec3 albedo, vec3 worldNormal, float shadowMask, vec3 viewPosition) {
    vec3 normal = normalize(worldNormal);
    // uNightFill stands in for street lighting (see SceneLighting.nightFill) and is
    // already zero during the day, so this costs nothing when the sun is up.
    vec3 ambient = mix(uGroundColor, uSkyColor, normal.y * 0.5 + 0.5) * uAmbientIntensity + uNightFill;
    float ndl = max(dot(normal, normalize(uSunDirection)), 0.0);
    // uSunResponse is per material, not per frame — see the note on it in
    // createSceneLightingUniforms. Roads and the ground leave it at 1 so they stay lit
    // exactly like every MeshStandardMaterial beside them. Reused for the dynamic term
    // too: a facade that reads as strongly side-lit by the sun should read the same way
    // when a headlight sweeps across it, not fall back to a flatter response.
    vec3 direct = uSunColor * uSunIntensity * ndl * shadowMask * uSunResponse;
    vec3 dynamic = dynamicLightsContribution(normal, viewPosition) * uSunResponse;
    // RECIPROCAL_PI is BRDF_Lambert's normalization, which every MeshStandardMaterial in
    // the scene applies to both its direct and indirect terms. A road and the ground it
    // sits on are lit by the same two lights at the same intensities, so dropping it
    // here would make the road render roughly pi times brighter than its own verge.
    return albedo * (ambient + direct + dynamic) * RECIPROCAL_PI;
  }
`;
