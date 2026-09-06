import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  getRoadFamily,
  getRoadStyle,
  getRoadStyleKey,
  getOrCreateRoadMaterial,
  isPhysicalRoadKind,
  isRenderedRoadKind,
  isRenderedWay,
  isBusDrivableKind,
  ROAD_FRAGMENT_SHADER,
  ROAD_VERTEX_SHADER,
} from '../../src/svartaksi/roadStyle';

describe('road styling', () => {
  it('rejects non-physical way kinds (ferries, rail) that should never render as a paved ribbon', () => {
    for (const kind of ['ferry', 'rail', 'transit', 'aerialway', 'light_rail', 'subway']) {
      expect(isPhysicalRoadKind(kind)).toBe(false);
    }
    for (const kind of ['residential', 'primary', 'footway', 'service']) {
      expect(isPhysicalRoadKind(kind)).toBe(true);
    }
  });

  it('classifies pedestrian-scale ways as paths', () => {
    for (const kind of ['footway', 'path', 'pedestrian', 'cycleway', 'track']) {
      expect(getRoadFamily(kind)).toBe('path');
    }
  });

  it('classifies arterial ways as major', () => {
    for (const kind of ['motorway', 'trunk', 'primary', 'secondary']) {
      expect(getRoadFamily(kind)).toBe('major');
    }
  });

  it('paints motorway/trunk as their own highway tier without moving them out of major', () => {
    // trafficLights.ts and busStops.ts both key off `getRoadFamily === 'major'` for
    // motorway/trunk already — only the paint tier splits.
    for (const kind of ['motorway', 'trunk']) {
      expect(getRoadFamily(kind)).toBe('major');
      expect(getRoadStyleKey(kind)).toBe('highway');
    }
    for (const kind of ['primary', 'secondary']) {
      expect(getRoadStyleKey(kind)).toBe('major');
    }
    for (const kind of ['residential', 'footway']) {
      expect(getRoadStyleKey(kind)).toBe(getRoadFamily(kind));
    }
  });

  it('gives a highway a solid, wider, whiter centre line than an ordinary major road', () => {
    const highway = getRoadStyle('motorway');
    const major = getRoadStyle('primary');
    expect(highway.centerLine).toBe(true);
    // Solid, not dashed — a divided carriageway, not an overtaking lane.
    expect(highway.dashLength).toBe(0);
    expect(major.dashLength).toBeGreaterThan(0);
    expect(highway.lineWidth).toBeGreaterThan(major.lineWidth);
    expect(highway.color).not.toBe(major.color);
  });

  it('falls back to minor for local/unknown ways', () => {
    for (const kind of ['residential', 'service', 'tertiary', 'unclassified', 'something-unknown']) {
      expect(getRoadFamily(kind)).toBe('minor');
    }
  });

  it('gives paths a lighter color that fades toward the edges', () => {
    const style = getRoadStyle('footway');
    expect(style.edgeFade).toBe(true);
    expect(style.centerLine).toBe(false);
    const color = new THREE.Color(style.color);
    // Lighter than the dark asphalt used for minor/major roads.
    expect(color.r + color.g + color.b).toBeGreaterThan(new THREE.Color(getRoadStyle('residential').color).r
      + new THREE.Color(getRoadStyle('residential').color).g + new THREE.Color(getRoadStyle('residential').color).b);
  });

  it('gives major roads a dashed center line and paints no edge lines anywhere', () => {
    const major = getRoadStyle('primary');
    expect(major.centerLine).toBe(true);
    expect(major.dashLength).toBeGreaterThan(0);

    expect(getRoadStyle('residential').centerLine).toBe(false);
    expect(getRoadStyle('footway').centerLine).toBe(false);

    // Edge lines are gone entirely: two painted lines a fixed fraction in from each kerb
    // read as motorway hatching on every ordinary street and fought the kerb dirt for the
    // same pixels. Nothing sets them, and the shader no longer knows how to draw them.
    expect(ROAD_FRAGMENT_SHADER).not.toContain('uEdgeLines');
  });

  it('crowns paved carriageways in the shading, and leaves paths flat', () => {
    // The ribbon is two vertices wide and stays geometrically flat; the cross-fall is a
    // normal tilt, which is what makes a wide road read as a shaped surface.
    expect(ROAD_VERTEX_SHADER).toContain('attribute vec3 aRoadSide');
    expect(ROAD_FRAGMENT_SHADER).toContain('vec3 cambered = normalize(vWorldNormal - vRoadSide * (vRoadUV.y * uCamber))');

    const cache = new Map<string, THREE.ShaderMaterial>();
    expect(getOrCreateRoadMaterial('primary', cache).uniforms.uCamber.value).toBeGreaterThan(0);
    expect(getOrCreateRoadMaterial('footway', cache).uniforms.uCamber.value).toBe(0);
  });

  it('caches one material per family regardless of how many kinds map to it', () => {
    const cache = new Map<string, THREE.ShaderMaterial>();
    const primary = getOrCreateRoadMaterial('primary', cache);
    const secondary = getOrCreateRoadMaterial('secondary', cache);
    const residential = getOrCreateRoadMaterial('residential', cache);
    expect(secondary).toBe(primary);
    expect(residential).not.toBe(primary);
    expect(cache.size).toBe(2);
  });

  it('caches motorway and trunk as one shared highway material, separate from major', () => {
    const cache = new Map<string, THREE.ShaderMaterial>();
    const motorway = getOrCreateRoadMaterial('motorway', cache);
    const trunk = getOrCreateRoadMaterial('trunk', cache);
    const primary = getOrCreateRoadMaterial('primary', cache);
    expect(trunk).toBe(motorway);
    expect(primary).not.toBe(motorway);
    expect(motorway.uniforms.uDashLength.value).toBe(0);
  });

  it('blends every road family without writing depth, so crossings cannot z-fight', () => {
    // Same-class roads are exactly coplanar where they cross, so the depth test cannot
    // separate them and the winner flipped as the camera moved. With no depth writes the
    // crossing resolves purely by roadRenderOrder, which is deterministic per road.
    const cache = new Map<string, THREE.ShaderMaterial>();
    for (const kind of ['footway', 'residential', 'primary']) {
      const material = getOrCreateRoadMaterial(kind, cache);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      // Still depth-*tested*, so terrain and buildings occlude roads normally.
      expect(material.depthTest).toBe(true);
    }
  });

  it('dissolves each road tip instead of ending on a hard rectangular lip', () => {
    expect(ROAD_FRAGMENT_SHADER).toContain('clamp(vRoadUV.z, 0.0, 1.0)');
    // The across-width fade multiplies into the tip fade rather than replacing it, so a
    // path gets both.
    expect(ROAD_FRAGMENT_SHADER).toContain('alpha *= 1.0 - smoothstep(0.4, 1.0, side)');
  });

  it('renders pedestrian/cycle paths at very low overall opacity, almost invisible next to real roads', () => {
    const path = getRoadStyle('footway');
    expect(path.opacity).toBeLessThan(0.3);

    const cache = new Map<string, THREE.ShaderMaterial>();
    const pathMaterial = getOrCreateRoadMaterial('footway', cache);
    expect(pathMaterial.uniforms.uOpacity.value).toBe(path.opacity);

    const minorMaterial = getOrCreateRoadMaterial('residential', cache);
    expect(minorMaterial.uniforms.uOpacity.value).toBe(1);
  });

  it('lights road surfaces from the shared scene lighting and receives the scene shadow', () => {
    // Asphalt used to be lit by a fixed direction with a 0.55 floor and no shadow term,
    // so a road looked identical at noon and midnight and the car's own shadow — which
    // almost always lands on a road — was invisible.
    expect(ROAD_FRAGMENT_SHADER).not.toContain('uLightDir');
    expect(ROAD_FRAGMENT_SHADER).toContain('shadeSurface(color, cambered, getShadowMask(), vViewPosition)');
    expect(ROAD_VERTEX_SHADER).toContain('#include <shadowmap_vertex>');

    const material = getOrCreateRoadMaterial('primary', new Map<string, THREE.ShaderMaterial>());
    expect(material.lights).toBe(true);
    expect(material.uniforms.uSunDirection).toBeDefined();
    expect(material.uniforms.directionalShadowMatrix).toBeDefined();
  });

  it('antialiases lane markings against their own screen footprint', () => {
    // A painted line is centimeters wide on a surface receding to the horizon; a
    // fixed-width smoothstep shimmers at any real driving distance.
    expect(ROAD_FRAGMENT_SHADER).toContain('float sidePixel = fwidth(side)');
    expect(ROAD_FRAGMENT_SHADER).toContain('float alongPixel = fwidth(vRoadUV.x)');
    expect(ROAD_FRAGMENT_SHADER).not.toContain('step(mod(vRoadUV.x, period), uDashLength)');
  });

  it('is tone mapped like every built-in material in the same frame', () => {
    expect(ROAD_FRAGMENT_SHADER).toContain('#include <tonemapping_fragment>');
  });

  it('grains, wears and dirties paved surfaces but leaves paths clean', () => {
    expect(getRoadStyle('primary').wear).toBe(1);
    expect(getRoadStyle('residential').wear).toBe(1);
    // Paths are a faint edge-faded suggestion of a trail; graining them just adds noise.
    expect(getRoadStyle('footway').wear).toBe(0);

    const cache = new Map<string, THREE.ShaderMaterial>();
    expect(getOrCreateRoadMaterial('primary', cache).uniforms.uWear.value).toBe(1);
    expect(getOrCreateRoadMaterial('footway', cache).uniforms.uWear.value).toBe(0);
  });

  it('fades surface detail out with distance instead of aliasing it into noise', () => {
    expect(ROAD_FRAGMENT_SHADER).toContain('float detailFade = uWear * (1.0 - smoothstep(40.0, 110.0, vFogDepth))');
  });

  it('picks the sky up at a grazing angle, the way real asphalt does', () => {
    // Needs the world position of the fragment, not just its road-local UV.
    expect(ROAD_VERTEX_SHADER).toContain('vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz');
    expect(ROAD_FRAGMENT_SHADER).toContain('normalize(cameraPosition - vWorldPosition)');
    expect(ROAD_FRAGMENT_SHADER).toContain('uSkyColor * uAmbientIntensity * grazing');
  });
});

describe('which ways get drawn and driven', () => {
  it('drops bus-only carriageways from the drawn world', () => {
    // A bus guideway painted as ordinary asphalt puts a road where general traffic
    // cannot go, and OSM often maps one alongside the street it runs beside — two
    // overlapping ribbons.
    expect(isRenderedRoadKind('bus')).toBe(false);
    expect(isRenderedRoadKind('bus_guideway')).toBe(false);

    expect(isRenderedRoadKind('primary')).toBe(true);
    expect(isRenderedRoadKind('residential')).toBe(true);
    expect(isRenderedRoadKind('footway')).toBe(true);
  });

  it('drops driveways and parking aisles but keeps real service roads', () => {
    // `service` covers two different things. The stubs are clutter across every yard;
    // the plain ones are the park drives and back streets that make up most of the
    // drivable network here — dropping the class wholesale left the spawn point with no
    // road under it, since both ways within 120m of it are service.
    expect(isRenderedWay('service', { service: 'driveway' })).toBe(false);
    expect(isRenderedWay('service', { service: 'parking_aisle' })).toBe(false);
    expect(isRenderedWay('service', { service: 'alley' })).toBe(false);
    expect(isRenderedWay('service', { subclass: 'driveway' })).toBe(false);

    expect(isRenderedWay('service', {})).toBe(true);
    expect(isRenderedWay('service', { name: 'Djurgårdsvägen' })).toBe(true);
  });

  it('keeps tunnels and negative-layer ways in the world for routing, even though they will not be drawn', () => {
    // Inclusion in WorldData is separate from surface rendering — see backlog item 9 and
    // surfaceVisibility.ts. A tunnel edge still has to exist for a route to cross it.
    expect(isRenderedWay('primary', { brunnel: 'tunnel' })).toBe(true);
    expect(isRenderedWay('primary', { tunnel: 'yes' })).toBe(true);
    expect(isRenderedWay('primary', { layer: -1 })).toBe(true);
    expect(isRenderedWay('primary', { layer: '-2' })).toBe(true);

    // Bridges and raised ways are above ground and stay.
    expect(isRenderedWay('primary', { brunnel: 'bridge', layer: 1 })).toBe(true);
    expect(isRenderedWay('primary', {})).toBe(true);
  });

  it('routes the bus over paved public carriageways only', () => {
    // The graph used to include every way, so a route could send an 11-metre vehicle
    // down a gravel walking path between two lawns.
    for (const kind of ['footway', 'path', 'steps', 'cycleway', 'track']) {
      expect(isBusDrivableKind(kind)).toBe(false);
    }
    // Service stays drivable: the driveways and parking aisles were already dropped from
    // the world by isRenderedWay, so what reaches the graph under this class is real road
    // — and in Djurgården it is most of the road there is.
    expect(isBusDrivableKind('service')).toBe(true);

    for (const kind of ['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'street']) {
      expect(isBusDrivableKind(kind)).toBe(true);
    }
  });
});
