import { describe, expect, it } from 'vitest';
import {
  FACADE_FRAGMENT_SHADER,
  FACADE_SUN_RESPONSE,
  FACADE_VERTEX_SHADER,
  MIN_GROUND_FLOOR_HEIGHT,
  getFacadeFamily,
  getFacadeProfile,
  getOrCreateFacadeMaterial,
  resolveFacadeProfile,
} from '../../src/svartaksi/buildingFacade';
import { createSceneLightingUniforms, SCENE_LIGHTING_PARS_GLSL } from '../../src/world/shaderLighting';
import { getOrCreateRoadMaterial } from '../../src/svartaksi/roadStyle';
import * as THREE from 'three';

describe('getFacadeProfile', () => {
  it('quantizes arbitrary properties into the five stable batch families', () => {
    expect(getFacadeFamily(null)).toBe('residential');
    expect(getFacadeFamily({ type: 'retail' })).toBe('commercial');
    expect(getFacadeFamily({ class: 'warehouse' })).toBe('industrial');
    expect(getFacadeFamily({ type: 'unmapped-use', height: 70 })).toBe('office');
    expect(getFacadeFamily({ type: 'unmapped-use', height: 20 })).toBe('residential');
  });

  it('should return default residential profile for empty properties', () => {
    const profile = getFacadeProfile(null);
    expect(profile.firstFloorHeight).toBe(4.0);
    expect(profile.sidePadding).toBe(1.2);
    expect(profile.wallColor).toBe('#2b2e3a');
    expect(profile.windowColor).toBe('#ffeaad');
  });

  it('should parse building type and return residential profile for unknown types', () => {
    const profile = getFacadeProfile({ type: 'something_else' });
    expect(profile.firstFloorHeight).toBe(4.0);
    expect(profile.wallColor).toBe('#2b2e3a');
  });

  it('should return office profile for office type or tall buildings', () => {
    const officeProfile = getFacadeProfile({ type: 'office' });
    expect(officeProfile.firstFloorHeight).toBe(5.0);
    expect(officeProfile.wallColor).toBe('#1f2530');
    expect(officeProfile.windowColor).toBe('#e0f2fe');

    const tallProfile = getFacadeProfile({ height: 60 });
    expect(tallProfile.firstFloorHeight).toBe(5.0);
    expect(tallProfile.wallColor).toBe('#1f2530');
  });

  it('should return commercial profile for retail/commercial type', () => {
    const commProfile = getFacadeProfile({ type: 'commercial' });
    expect(commProfile.firstFloorHeight).toBe(5.5);
    expect(commProfile.wallColor).toBe('#3f3939');

    const retailProfile = getFacadeProfile({ class: 'retail' });
    expect(retailProfile.firstFloorHeight).toBe(5.5);
  });

  it('should return industrial profile for industrial type', () => {
    const indProfile = getFacadeProfile({ type: 'industrial' });
    expect(indProfile.firstFloorHeight).toBe(6.0);
    expect(indProfile.wallColor).toBe('#4a3f35');
    expect(indProfile.litRatio).toBe(0.2);
  });

  it('classifies shop/store-tagged buildings as the store family ahead of the broader commercial match', () => {
    for (const shop of ['bakery', 'convenience', 'supermarket']) {
      expect(getFacadeFamily({ shop })).toBe('store');
    }
    expect(getFacadeFamily({ type: 'boutique' })).toBe('store');
    // 'retail'/'hotel'/'museum' still resolve to plain commercial, unaffected by store.
    expect(getFacadeFamily({ type: 'retail' })).toBe('commercial');
  });

  it('never spawns a random store without an identity, keeping ad-hoc lookups deterministic', () => {
    expect(getFacadeFamily({ building: 'yes', height: 12 })).toBe('residential');
    expect(getFacadeFamily(null)).toBe('residential');
  });

  it('occasionally spawns stores for generic, untagged, low/mid-rise buildings — never for explicitly tagged or tall ones', () => {
    const families = Array.from({ length: 500 }, (_, index) =>
      getFacadeFamily({ building: 'yes', height: 12 }, `generic-${index}`));
    expect(families).toContain('store');
    expect(families.every(family => family === 'store' || family === 'residential')).toBe(true);

    // Explicitly tagged apartments never roll into a store, regardless of identity.
    const tagged = Array.from({ length: 200 }, (_, index) =>
      getFacadeFamily({ type: 'apartments' }, `apartments-${index}`));
    expect(tagged.every(family => family === 'residential')).toBe(true);

    // Mid-rise buildings above the store spawn cutoff (but below the office height
    // threshold) don't get ground-floor shops either.
    const midRise = Array.from({ length: 200 }, (_, index) =>
      getFacadeFamily({ building: 'yes', height: 35 }, `mid-rise-${index}`));
    expect(midRise.every(family => family === 'residential')).toBe(true);
  });

  it('gives the store family a wide, bright, tall-enough-to-clear-a-door shopfront profile', () => {
    const profile = getFacadeProfile({ shop: 'bakery' });
    expect(profile.firstFloorHeight).toBeGreaterThanOrEqual(MIN_GROUND_FLOOR_HEIGHT);
    expect(profile.litRatio).toBeGreaterThan(0.9);
    expect(profile.windowGlow).toBeGreaterThan(0.8);
    expect(profile.windowWidth).toBeGreaterThan(getFacadeProfile({ type: 'apartments' }).windowWidth);
  });

  it('resolves the exact same family a second time internally, so the profile always matches its own classification', () => {
    // A regression guard: resolveFacadeProfile must not classify a building as one
    // family (e.g. a randomly-rolled store) while building its FacadeProfile fields
    // from a *different* re-derived family (e.g. plain residential defaults).
    for (let index = 0; index < 100; index += 1) {
      const selection = resolveFacadeProfile({ building: 'yes', height: 12 }, {
        identity: `consistency-${index}`, areaId: 'area', areaKind: 'unknown', colorScheme: 'stockholm-dusk',
      });
      if (selection.family === 'store') {
        expect(selection.profile.litRatio).toBeGreaterThan(0.9);
        expect(selection.profile.firstFloorHeight).toBeGreaterThanOrEqual(MIN_GROUND_FLOOR_HEIGHT);
      } else {
        expect(selection.profile.litRatio).toBeLessThan(0.9);
      }
    }
  });

  it('should safely handle malformed height properties', () => {
    const badHeightProfile = getFacadeProfile({ height: 'invalid-number' });
    expect(badHeightProfile.firstFloorHeight).toBe(4.0); // should fallback to residential (default height 12)
  });

  it('should create and cache THREE.ShaderMaterial', () => {
    const profile = getFacadeProfile(null);
    const materialsMap = new Map<string, THREE.ShaderMaterial>();
    const mat1 = getOrCreateFacadeMaterial('default', profile, materialsMap);
    expect(mat1).toBeInstanceOf(THREE.ShaderMaterial);
    expect(materialsMap.get('default')).toBe(mat1);

    const mat2 = getOrCreateFacadeMaterial('default', profile, materialsMap);
    expect(mat2).toBe(mat1); // should return cached instance
  });

  it('draws each wall once, on its outward face only', () => {
    const material = getOrCreateFacadeMaterial('outward', getFacadeProfile(null), new Map());

    // A wall quad's +z is its outward normal, so FrontSide is the windowed face and
    // nothing else. DoubleSide painted the same window grid, doors and lit panes on the
    // inside of every wall too — visible through any building whose far wall was in
    // view, and paid for twice on the scene's most expensive shader.
    expect(material.side).toBe(THREE.FrontSide);
    // Left at the default so Three casts a FrontSide material from its back faces,
    // which for a closed shell of zero-thickness walls starts the shadow at the far
    // wall instead of acneing across the lit one.
    expect(material.shadowSide).toBeNull();
  });

  it('uses ordinary scene depth because the query extrusion does not draw', () => {
    const profile = getFacadeProfile(null);
    const material = getOrCreateFacadeMaterial('unbiased', profile, new Map());

    expect(material.polygonOffset).toBe(false);
    expect(material.uniforms.uDepthNudge).toBeUndefined();
    expect(FACADE_VERTEX_SHADER).not.toContain('uDepthNudge');
  });

  it('applies the InstancedMesh transform to facade positions via the shared project chunk', () => {
    expect(FACADE_VERTEX_SHADER).toContain('#include <project_vertex>');
    expect(FACADE_VERTEX_SHADER).toContain('vec3 transformed = vec3(position)');
  });

  it('takes the wall normal from the instance basis rather than deriving it', () => {
    // One of the two footprint windings produces a mirrored (negative determinant)
    // instance basis, and a derived normal would point into the building for every
    // such wall — reading the basis column keeps outward meaning outward citywide.
    expect(FACADE_VERTEX_SHADER).toContain('normalize(mat3(instanceMatrix)[2])');
    expect(FACADE_VERTEX_SHADER).not.toContain('#include <defaultnormal_vertex>');
  });

  it('lights facades from the shared scene lighting rather than a fixed direction', () => {
    expect(FACADE_FRAGMENT_SHADER).not.toContain('uLightDir');
    expect(FACADE_FRAGMENT_SHADER).toContain('shadeSurface(albedo, vWorldNormal, shadowMask, vViewPosition)');
    expect(FACADE_FRAGMENT_SHADER).toContain('uniform vec3 uSunDirection');
  });

  it('receives the scene shadow instead of rendering permanently unshadowed', () => {
    expect(FACADE_VERTEX_SHADER).toContain('#include <shadowmap_pars_vertex>');
    expect(FACADE_VERTEX_SHADER).toContain('#include <shadowmap_vertex>');
    expect(FACADE_FRAGMENT_SHADER).toContain('#include <shadowmask_pars_fragment>');
    expect(FACADE_FRAGMENT_SHADER).toContain('getShadowMask()');

    const material = getOrCreateFacadeMaterial('shadowed', getFacadeProfile(null), new Map());
    // The shadow chunks read Three's light uniforms; both the flag and the merged
    // uniform block are required or the renderer crashes refreshing them. (The sampler
    // itself, directionalShadowMap, is bound straight onto the program by the renderer
    // and is deliberately absent from UniformsLib.lights.)
    expect(material.lights).toBe(true);
    expect(material.uniforms.directionalLightShadows).toBeDefined();
    expect(material.uniforms.directionalShadowMatrix).toBeDefined();
  });

  it('darkens the real ground line instead of relying on the shadow map alone', () => {
    // The shadow map's own normalBias pushes its sample point away from exactly the
    // corner where a wall meets the ground, which without this read as a bright line at
    // the base of every building — lighter than the wall above it. A fixed darkening at
    // the wall's real ground contact (vLocalPos.y == WALL_BASE_SINK, not the shader's
    // local y=0, which is WALL_BASE_SINK below the visible base) covers it regardless of
    // shadow-map precision.
    expect(FACADE_FRAGMENT_SHADER).toContain('float groundContact = 1.0 - smoothstep(0.0, 0.6, vLocalPos.y - 4.0)');
    expect(FACADE_FRAGMENT_SHADER).toContain('albedo *= 1.0 - groundContact * 0.3');
  });

  it('is tone mapped like every built-in material in the same frame', () => {
    expect(FACADE_FRAGMENT_SHADER).toContain('#include <tonemapping_fragment>');
    expect(FACADE_FRAGMENT_SHADER).toContain('#include <colorspace_fragment>');
  });

  it('scales lit windows and their glow with how dark it is outside', () => {
    // Windows used to be lit at a fixed ratio, so at noon a whole city block rendered
    // as a glowing yellow grid under a daylight sky.
    expect(FACADE_FRAGMENT_SHADER).toContain('uniform float uNightFactor');
    expect(FACADE_FRAGMENT_SHADER).toContain('float litScale = mix(0.06, 1.0, uNightFactor)');
    expect(FACADE_FRAGMENT_SHADER).toContain('float glowScale = mix(0.12, 1.0, uNightFactor)');
  });

  it('antialiases window and frame edges against their own screen footprint', () => {
    // Hard rectangle boundaries repeating at roughly a meter alias into a shimmering
    // mess at any real driving distance without a derivative-width falloff.
    expect(FACADE_FRAGMENT_SHADER).toContain('float bandMask(');
    expect(FACADE_FRAGMENT_SHADER).toContain('float pixelX = fwidth(rx)');
    expect(FACADE_FRAGMENT_SHADER).toContain('float pixelY = fwidth(ry)');
  });

  it('carries variant metrics and color per instance so variants share a family batch', () => {
    expect(FACADE_VERTEX_SHADER).toContain('attribute vec4 aWindowMetrics');
    expect(FACADE_VERTEX_SHADER).toContain('attribute vec4 aFacadeParams');
    expect(FACADE_VERTEX_SHADER).toContain('attribute vec3 aFacadeColor');
    expect(FACADE_FRAGMENT_SHADER).not.toContain('uniform float uWindowWidth');
  });

  it('renders the per-instance door rectangle before evaluating windows', () => {
    expect(FACADE_VERTEX_SHADER).toContain('attribute vec4 aDoorRect');
    expect(FACADE_VERTEX_SHADER).toContain('attribute vec4 aDoorStyle');
    expect(FACADE_VERTEX_SHADER).toContain('attribute vec4 aFacadeParams');
    expect(FACADE_VERTEX_SHADER).toContain('vDoorRect = aDoorRect');
    expect(FACADE_FRAGMENT_SHADER).toContain('vDoorStyle');
  });

  it('blanks a whole window cell when it overlaps the door instead of only masking individual door pixels', () => {
    // A pixel-only mask (checking isDoor per-fragment with no cell-level check) lets
    // a door slice through the middle of a window module, leaving a jagged sliver of
    // frame/glass right at the doorway — this only reads as a clean gap if the whole
    // cell is dropped once any part of it overlaps the door rectangle.
    expect(FACADE_FRAGMENT_SHADER).toContain('cellOverlapsDoor');
    expect(FACADE_FRAGMENT_SHADER).toMatch(/if\s*\(!cellOverlapsDoor\)/);
  });

  it('keeps known building function authoritative under every area context', () => {
    for (const areaKind of ['historic', 'residential', 'commercial', 'industrial', 'mixed', 'unknown'] as const) {
      const selection = resolveFacadeProfile(
        { type: 'office', height: 18 },
        { identity: 'office-a', areaId: 'area-a', areaKind, colorScheme: 'stockholm-dusk' },
      );
      expect(selection.family).toBe('office');
    }
  });

  it('returns one of three stable dimension variants without multiplying material buckets', () => {
    const selections = Array.from({ length: 100 }, (_, index) => resolveFacadeProfile(
      { type: 'apartments' },
      { identity: `building-${index}`, areaId: 'vasastan', areaKind: 'residential', colorScheme: 'nordic-day' },
    ));
    expect(new Set(selections.map(value => value.variant))).toEqual(new Set([0, 1, 2]));
    expect(new Set(selections.map(value => value.profileKey))).toEqual(new Set([
      'residential:nordic-day',
    ]));
    expect(new Set(selections.map(value => value.profile.windowWidth)).size).toBe(3);
  });

  it.each([
    ['residential', { type: 'apartments' }],
    ['commercial', { type: 'retail' }],
    ['office', { type: 'office' }],
    ['industrial', { type: 'industrial' }],
  ] as const)('resolves all three repeatable, bounded %s variants', (family, properties) => {
    const selections = Array.from({ length: 200 }, (_, index) => resolveFacadeProfile(
      properties,
      {
        identity: `${family}-${index}`,
        areaId: 'area-a',
        areaKind: family === 'commercial' ? 'commercial' : 'historic',
        colorScheme: 'nordic-day',
      },
    ));
    const representatives = [0, 1, 2].map(variant => {
      const index = selections.findIndex(selection => selection.variant === variant);
      return { index, selection: selections[index] };
    });

    expect(representatives.map(({ selection }) => selection.variant)).toEqual([0, 1, 2]);
    expect(representatives.every(({ selection }) => selection.family === family)).toBe(true);
    for (const { index, selection } of representatives) {
      const repeated = resolveFacadeProfile(properties, {
        identity: `${family}-${index}`,
        areaId: 'area-a',
        areaKind: family === 'commercial' ? 'commercial' : 'historic',
        colorScheme: 'nordic-day',
      });
      expect(repeated).toEqual(selection);
      expect(selection.profile.wallColor).toMatch(/^#[0-9A-F]{6}$/);
      expect(selection.profile.windowColor).toMatch(/^#[0-9A-F]{6}$/);
      expect(selection.profile.doorColor).toMatch(/^#[0-9A-F]{6}$/);
      expect(selection.profile.windowWidth).toBeGreaterThan(0);
      expect(selection.profile.windowHeight).toBeGreaterThan(0);
      expect(selection.profile.litRatio).toBeGreaterThanOrEqual(0);
      expect(selection.profile.litRatio).toBeLessThanOrEqual(1);
    }
  });
});

describe('facade response to the sun', () => {
  it('drives facades harder with the direct sun than the surfaces around them', () => {
    // A building is the one thing here with large flat sides facing four directions at
    // once, and that is what should say where the sun is. At the shared response of 1 the
    // hemisphere ambient term put all four walls within a few percent of each other and a
    // block read as a flat cut-out at every hour.
    const material = getOrCreateFacadeMaterial('sun', getFacadeProfile(null), new Map());
    expect(material.uniforms.uSunResponse.value).toBe(FACADE_SUN_RESPONSE);
    expect(FACADE_SUN_RESPONSE).toBeGreaterThan(1);
  });

  it('boosts only the direct term, so a shaded wall keeps its ambient', () => {
    // Brighter where the light lands, not darker everywhere else.
    expect(SCENE_LIGHTING_PARS_GLSL).toContain('shadowMask * uSunResponse');
    expect(SCENE_LIGHTING_PARS_GLSL).not.toContain('ambient * uSunResponse');
  });

  it('leaves roads and anything matching the scene lights at the shared default', () => {
    expect(createSceneLightingUniforms().uSunResponse.value).toBe(1);
    const road = getOrCreateRoadMaterial('primary', new Map());
    expect(road.uniforms.uSunResponse.value).toBe(1);
  });
});
