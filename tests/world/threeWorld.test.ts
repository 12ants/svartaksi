import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildBuildingGeometry, buildRoadGeometry, buildRoofGeometry, buildShallowsGeometry, buildShorelineGeometry, createThreeWorld, MAX_BUILDING_DRAW_DISTANCE, MAX_TERRAIN_DRAW_DISTANCE, roadRenderOrder, roadSurfaceElevation } from '../../src/world/threeWorld';
import { computeTerrainClearance, terrainHeightAt, WATER_SURFACE_EPSILON } from '../../src/world/terrain';
import { WATER_SHELF_WIDTH } from '../../src/world/waterIndex';
import { buildParkGeometry } from '../../src/world/terrainGeometry';
import { buildingColliderDescriptor } from '../../src/world/buildingColliders';
import type { WorldData } from '../../src/world/types';
import { DEFAULT_RENDER_OPTIONS } from '../../src/world/renderOptions';
import { sceneLighting } from '../../src/world/timeOfDay';
import { INSPECTION_USER_DATA_KEY } from '../../src/world/inspection';
import { buildRoadElevationProfiles, roadElevationAtPoint, type RoadElevationProfile } from '../../src/world/roadElevationProfile';

function worldData(source: WorldData['source']): WorldData {
  return {
    source,
    roads: [],
    water: [],
    parks: [],
    labels: [],
    objects: [],
    buildings: [{
      id: `${source}-building`,
      height: 16,
      properties: { type: 'apartments' },
      rings: [[{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 8 }, { x: 0, z: 8 }]],
    }],
  };
}

describe('Three.js world geometry', () => {
  const hasFacade = (scene: THREE.Scene) => {
    let found = false;
    scene.traverse(child => {
      if (child.name.startsWith('svartaksi-facades:residential:stockholm-dusk:')) found = true;
    });
    return found;
  };

  describe('incremental rebuilds', () => {
    /** A world with enough content that an incremental rebuild has to yield at least
     * once before it can finish. */
    function busyWorld(): WorldData {
      const data = worldData('maplibre');
      for (let index = 0; index < 120; index += 1) {
        data.roads.push({
          id: `road-${index}`,
          kind: 'residential',
          width: 6,
          points: [{ x: index, z: 0 }, { x: index, z: 40 }],
        });
      }
      return data;
    }

    it('keeps the old world on screen until the new one is finished', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace(worldData('open'));
      const before = scene.getObjectByName('world:open');
      expect(before).toBeDefined();

      world.replace(busyWorld(), { incremental: true });

      // Mid-build: the new root is staged off-scene, so what a frame renders right now
      // is still the complete previous world rather than a half-built new one.
      expect(world.isBuilding()).toBe(true);
      expect(scene.getObjectByName('world:open')).toBe(before);
      expect(scene.getObjectByName('world:maplibre')).toBeUndefined();
    });

    it('swaps the new world in once pumping completes it', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace(worldData('open'));
      world.replace(busyWorld(), { incremental: true });

      let guard = 0;
      while (world.pump(0) && guard < 10_000) guard += 1;

      expect(world.isBuilding()).toBe(false);
      expect(scene.getObjectByName('world:open')).toBeUndefined();
      expect(scene.getObjectByName('world:maplibre')).toBeDefined();
      // All 120 roads are 'residential' (style key 'minor') and all lie on the ground, so
      // they merge into one draw call instead of one mesh per road — see the
      // road-geometry-merge doc. The per-face inspection record count (6 faces per
      // straight, 2-point road: its own quad plus the two endpoint stubs') is what now
      // proves every road was actually built.
      const roadsGroup = scene.getObjectByName('world:roads');
      expect(roadsGroup?.children.length).toBe(1);
      const roadMesh = roadsGroup?.children[0] as THREE.Mesh;
      expect((roadMesh.userData[INSPECTION_USER_DATA_KEY] as unknown[]).length).toBe(720);
      expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThan(0);
      expect(scene.children.filter(child => child.name.startsWith('world:'))).toHaveLength(1);
    });

    it('reports build progress that rises while building and settles at 1 when idle', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      // Nothing building: a loading screen can read this without special-casing idle.
      expect(world.buildProgress()).toBe(1);

      world.replace(busyWorld(), { incremental: true });
      expect(world.buildProgress()).toBe(0);

      world.pump(0);
      const early = world.buildProgress();
      expect(early).toBeGreaterThan(0);
      // Never claims completion while work remains — a bar that hits 100% and then
      // waits is the one thing a progress readout must not do.
      expect(early).toBeLessThan(1);

      world.pump(0);
      expect(world.buildProgress()).toBeGreaterThan(early);
      expect(world.buildProgress()).toBeLessThan(1);

      let guard = 0;
      while (world.pump(0) && guard < 10_000) guard += 1;
      expect(world.buildProgress()).toBe(1);
    });

    it('reports completed build diagnostics from counts already known to the builder', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace(busyWorld(), { incremental: true });

      const started = world.buildDiagnostics();
      expect(started).toMatchObject({
        estimatedSlices: expect.any(Number), finishedSlices: 0, complete: false,
        input: { buildings: 1, roads: 120, water: 0, parks: 0, objects: 0 },
      });

      let guard = 0;
      while (world.pump(0) && guard < 10_000) guard += 1;

      const completed = world.buildDiagnostics();
      expect(completed).toMatchObject({
        generationId: started.generationId,
        complete: true,
        input: { roads: 120 },
        built: { buildings: 1, roads: 120, water: 0, parks: 0, objects: expect.any(Number) },
      });
      expect(completed.built.objects).toBeGreaterThan(0);
      expect(completed.finishedSlices).toBeGreaterThan(0);
      expect(completed.worstSliceMs).toBeGreaterThanOrEqual(0);
      expect(completed.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('anchors the ground planes where the camera ended up, not where it started', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace(busyWorld(), { incremental: true });
      // The player keeps driving while the world builds.
      world.setAnchor(500, -300);
      let guard = 0;
      while (world.pump(0) && guard < 10_000) guard += 1;

      const ground = scene.getObjectByName('world:ground')?.children[0];
      expect(ground?.position.x).toBe(500);
      expect(ground?.position.z).toBe(-300);
    });

    it('abandons a superseded rebuild instead of letting it overwrite the newer one', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace(busyWorld(), { incremental: true });
      world.pump(0);

      world.replace(worldData('open'));

      expect(world.isBuilding()).toBe(false);
      expect(scene.getObjectByName('world:open')).toBeDefined();
      expect(scene.getObjectByName('world:maplibre')).toBeUndefined();
    });

    it('resets the active build timing when a newer generation supersedes it', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace(busyWorld(), { incremental: true });
      world.pump(0);
      const superseded = world.buildDiagnostics();

      world.replace(worldData('open'), { incremental: true });
      const replacement = world.buildDiagnostics();
      expect(replacement).toMatchObject({
        generationId: superseded.generationId + 1,
        finishedSlices: 0,
        complete: false,
        replacementCount: superseded.replacementCount + 1,
        input: { buildings: 1, roads: 0, water: 0, parks: 0, objects: 0 },
      });

      let guard = 0;
      while (world.pump(0) && guard < 10_000) guard += 1;
      expect(world.buildDiagnostics().complete).toBe(true);
    });

    it('reuses facade shader materials across a rebuild rather than recompiling them', () => {
      // Disposing the shared material cache on every rebuild forced a full shader
      // recompile per streamed world, which is expensive enough under WebGL to be felt
      // as a freeze on its own.
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace(worldData('maplibre'));
      const materialOf = () => {
        let material: THREE.Material | undefined;
        scene.traverse((child) => {
          if (child instanceof THREE.Mesh && child.name.startsWith('svartaksi-facades:')) {
            material ??= child.material as THREE.Material;
          }
        });
        return material;
      };
      const first = materialOf();
      expect(first).toBeDefined();

      world.replace(worldData('maplibre'));

      expect(materialOf()).toBe(first);
    });
  });

  it('builds a horizontal road ribbon at the requested width', () => {
    const road = {
      id: 'road', kind: 'residential', width: 8,
      points: [{ x: -10, z: 0 }, { x: 10, z: 0 }],
    };
    const geometry = buildRoadGeometry(road);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.min.z).toBeCloseTo(-4);
    expect(geometry.boundingBox?.max.z).toBeCloseTo(4);
    expect(geometry.boundingBox?.min.y).toBeCloseTo(roadSurfaceElevation(road));
    expect(geometry.boundingBox?.min.y).toBeGreaterThan(0.13);
    const normal = geometry.getAttribute('normal');
    expect(normal.getY(0)).toBeGreaterThan(0);
  });

  it('extrudes a bridge deck downward into a solid slab, unlike a plain or tunnel road', () => {
    const flat = {
      id: 'road', kind: 'residential', width: 8,
      points: [{ x: -10, z: 0 }, { x: 10, z: 0 }],
    };
    const bridge = { ...flat, id: 'bridge', structure: 'bridge' as const };
    const tunnel = { ...flat, id: 'tunnel', structure: 'tunnel' as const };

    const flatGeometry = buildRoadGeometry(flat);
    const bridgeGeometry = buildRoadGeometry(bridge);
    const tunnelGeometry = buildRoadGeometry(tunnel);

    // A plain or tunnel road stays a single top ribbon; a bridge gets an underside
    // ribbon, two side walls and two end caps, each with its own copies of the vertices
    // it needs so no face group borrows another's normal (see extrudeDeckUnderside).
    // 2N for the top, 2N underside, 2N per wall, 4 per cap: 8N+8 against the ribbon's 2N.
    const ribbon = flatGeometry.getAttribute('position').count;
    expect(bridgeGeometry.getAttribute('position').count).toBe(ribbon * 4 + 8);
    expect(tunnelGeometry.getAttribute('position').count).toBe(ribbon);

    // Every attribute buffer stays the same length as position, so the shared road
    // material never sees a mismatched vertex count.
    expect(bridgeGeometry.getAttribute('aRoadUV').count).toBe(bridgeGeometry.getAttribute('position').count);
    expect(bridgeGeometry.getAttribute('aRoadSide').count).toBe(bridgeGeometry.getAttribute('position').count);

    bridgeGeometry.computeBoundingBox();
    flatGeometry.computeBoundingBox();
    // The deck now reaches measurably below the flat ribbon's own surface — it reads
    // as a slab with real thickness rather than an infinitely thin plane.
    expect(bridgeGeometry.boundingBox!.min.y).toBeLessThan(flatGeometry.boundingBox!.min.y - 0.1);
  });

  it('carries the slab out along an approach ramp and closes it off where the ramp reaches grade', () => {
    // The seam this fixes: OSM tags the bridge over its span alone, so the ramp carrying
    // the deck back to street level is an ordinary way. Drawn as a bare ribbon it left the
    // viaduct ending in a paper streamer hanging off the end cap of its own slab.
    const ramp = {
      id: 'ramp', kind: 'primary' as const, width: 10,
      points: [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 80, z: 0 }],
    };
    const lifted: RoadElevationProfile = {
      roadId: 'ramp', structure: 'ground', layer: 0, width: 10, unresolvedCrossings: [],
      samples: [
        { distanceAlong: 0, point: ramp.points[0], height: roadSurfaceElevation(ramp) + 4.5 },
        { distanceAlong: 40, point: ramp.points[1], height: roadSurfaceElevation(ramp) + 2.2 },
        { distanceAlong: 80, point: ramp.points[2], height: roadSurfaceElevation(ramp) },
      ],
    };
    const geometry = buildRoadGeometry(ramp, [], lifted);
    const flat = buildRoadGeometry(ramp);
    const ribbon = flat.getAttribute('position').count;

    // The ramp is a slab now, not a ribbon.
    expect(geometry.getAttribute('position').count).toBeGreaterThan(ribbon);

    // Its thickness tapers with its lift: full depth under the high end, nothing at all
    // where it has come back to street level, so the slab closes into the ground rather
    // than ending on a step.
    const position = geometry.getAttribute('position');
    const undersideDrop = (point: number) => position.getY(point * 2) - position.getY(ribbon + point * 2);
    expect(undersideDrop(0)).toBeCloseTo(0.4, 3);
    expect(undersideDrop(ribbon / 2 - 1)).toBeCloseTo(0, 3);
  });

  it('leaves an ordinary road on the ground a plain ribbon, with no slab to pay for', () => {
    const road = { id: 'road', kind: 'residential' as const, width: 8, points: [{ x: 0, z: 0 }, { x: 60, z: 0 }] };
    const grounded: RoadElevationProfile = {
      roadId: 'road', structure: 'ground', layer: 0, width: 8, unresolvedCrossings: [],
      samples: road.points.map((point, index) => ({
        distanceAlong: index * 60, point, height: roadSurfaceElevation(road),
      })),
    };
    expect(buildRoadGeometry(road, [], grounded).getAttribute('position').count)
      .toBe(buildRoadGeometry(road).getAttribute('position').count);
  });

  it('lights a deck like a carriageway: its surface keeps a flat-up normal and its walls do not', () => {
    // A road ribbon is two vertices wide, so every vertex of the deck surface is also a
    // wall corner. Sharing them let computeVertexNormals average the wall in, which tilted
    // the deck's own normal outward — by different amounts on its two sides — and lit a
    // flat carriageway as a shallow lopsided roof.
    const flat = { id: 'road', kind: 'primary' as const, width: 10, points: [{ x: 0, z: 0 }, { x: 60, z: 0 }] };
    const deck = buildRoadGeometry({ ...flat, id: 'deck', structure: 'bridge' as const, layer: 1 });
    const normal = deck.getAttribute('normal');
    const position = deck.getAttribute('position');

    // The top ribbon is the first 2N vertices, and every one of them faces straight up —
    // exactly what the same road without a deck gets.
    const ribbon = buildRoadGeometry(flat).getAttribute('position').count;
    for (let vertex = 0; vertex < ribbon; vertex += 1) {
      expect(normal.getY(vertex)).toBeCloseTo(1, 5);
    }

    // ...and the slab is genuinely closed, so it is a well-behaved shadow caster: every
    // face direction a box has is present, none of them borrowing the deck's up-normal.
    let downward = 0;
    let sideways = 0;
    let endOn = 0;
    for (let vertex = ribbon; vertex < normal.count; vertex += 1) {
      if (normal.getY(vertex) < -0.99) downward += 1;
      if (Math.abs(normal.getZ(vertex)) > 0.99) sideways += 1;
      if (Math.abs(normal.getX(vertex)) > 0.99) endOn += 1;
    }
    expect(downward).toBe(ribbon);
    expect(sideways).toBe(ribbon * 2);
    expect(endOn).toBe(8);
    // The underside sits a slab's thickness below the surface it mirrors.
    expect(position.getY(ribbon)).toBeCloseTo(position.getY(0) - 0.4, 5);
  });

  it('joins segments at a bend with one shared, correctly mitered vertex pair (no gap/overlap)', () => {
    // An L-shaped road: straight east, then straight north.
    const road = {
      id: 'bend', kind: 'residential', width: 6,
      points: [{ x: -20, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 20 }],
    };
    const geometry = buildRoadGeometry(road);
    const position = geometry.getAttribute('position');
    // 3 mapped points plus one endpoint stub at each end (see extendRoadEndpoints)
    // × 2 (left/right) = 10 vertices total: the incoming and outgoing segment at the
    // bend share the exact same joint vertices (indices 4/5) instead of each segment
    // emitting its own — that's what makes the ribbon continuous instead of a chain of
    // independently-gapped/overlapping quads.
    expect(position.count).toBe(10);
    // A 90° bend's miter is the bisector stretched by 1/cos(45°) = √2, a known
    // identity for miter joins — so the joint vertex sits √2·halfWidth from the
    // centerline point instead of halfWidth (which would undershoot the corner).
    const joint = new THREE.Vector3(0, position.getY(4), 0);
    const jointLeft = new THREE.Vector3().fromBufferAttribute(position, 4);
    expect(joint.distanceTo(jointLeft)).toBeCloseTo(3 * Math.SQRT2, 3);
  });

  it('carries an aRoadUV attribute with cumulative arc length and a -1..1 cross-width axis', () => {
    const road = {
      id: 'uv', kind: 'primary', width: 10,
      points: [{ x: 0, z: 0 }, { x: 30, z: 0 }],
    };
    const geometry = buildRoadGeometry(road);
    const roadUV = geometry.getAttribute('aRoadUV');
    expect(roadUV).toBeDefined();
    // Each end gains a stub half the road's own width long (see extendRoadEndpoints, so
    // two roads meeting at a junction visually overlap) — a 30m road at width 10 becomes
    // 40m (5m added at each end) end to end, over four point pairs: start stub, mapped
    // start, mapped end, end stub.
    expect(roadUV.count).toBe(8);
    expect(roadUV.getX(0)).toBeCloseTo(0);
    expect(roadUV.getX(2)).toBeCloseTo(5);
    expect(roadUV.getX(4)).toBeCloseTo(35);
    expect(roadUV.getX(6)).toBeCloseTo(40);
    // One side of the ribbon is +1, the other -1, on both ends.
    expect(Math.abs(roadUV.getY(0))).toBeCloseTo(1);
    expect(roadUV.getY(0)).toBeCloseTo(-roadUV.getY(1));
  });

  it('ramps the aRoadUV tip channel across exactly the stretch the endpoints were extended by', () => {
    // z is what the shader dissolves the tip with: 0 at the extended tip so the ribbon
    // trails off instead of ending on a hard lip, back to 1 by the road's own mapped end
    // so nothing that was actually surveyed is faded.
    //
    // The channel is a *vertex* attribute, so it can only say "opaque from here" at a
    // vertex that exists. A straight two-point way — the commonest shape in a vector
    // tile — has only two, and when the extension moved them outward instead of adding
    // its own, both were tips reading 0 and the interpolation between them left the whole
    // ribbon transparent. Hence the mapped endpoints staying put.
    const road = {
      id: 'cap', kind: 'primary', width: 10,
      points: [{ x: 0, z: 0 }, { x: 30, z: 0 }],
    };
    const roadUV = buildRoadGeometry(road).getAttribute('aRoadUV');
    expect(roadUV.itemSize).toBe(3);

    // Vertices 0/1 are the start stub's tip and 6/7 the end stub's; 2/3 and 4/5 are the
    // road's own mapped ends, fully opaque, with nothing faded in between them.
    expect(roadUV.getZ(0)).toBeCloseTo(0);
    expect(roadUV.getZ(2)).toBeCloseTo(1);
    expect(roadUV.getZ(4)).toBeCloseTo(1);
    expect(roadUV.getZ(6)).toBeCloseTo(0);

    // Nothing about that depends on the road having interior points of its own.
    const withInteriorPoint = buildRoadGeometry({
      id: 'cap2', kind: 'primary', width: 10,
      points: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 30, z: 0 }],
    }).getAttribute('aRoadUV');
    for (let vertex = 2; vertex <= 7; vertex += 1) expect(withInteriorPoint.getZ(vertex)).toBeCloseTo(1);
  });

  it('leaves the tip channel opaque where the road is a deck standing off the ground', () => {
    // A deck's end hands over to the approach ramp that continues it, not to the ground,
    // so there is nothing there to dissolve into — and the underside/side walls/end caps
    // copy this same channel, so fading it makes the whole slab see-through at its ends.
    const deck = {
      id: 'deck', kind: 'primary' as const, width: 10, structure: 'bridge' as const, layer: 1,
      points: [{ x: 0, z: 0 }, { x: 30, z: 0 }],
    };
    const lifted = {
      roadId: 'deck', structure: 'bridge' as const, layer: 1, width: 10, unresolvedCrossings: [],
      samples: [
        { distanceAlong: 0, point: deck.points[0], height: 5 },
        { distanceAlong: 30, point: deck.points[1], height: 5 },
      ],
    };
    const roadUV = buildRoadGeometry(deck, [], lifted).getAttribute('aRoadUV');
    for (let vertex = 0; vertex < roadUV.count; vertex += 1) expect(roadUV.getZ(vertex)).toBeCloseTo(1);
  });

  it('extends each end past its own mapped point, so two roads meeting at a shared junction node overlap instead of leaving a gap', () => {
    // Two independent roads sharing an intended junction at (100, 0) — as if two
    // separate OSM ways were mapped meeting exactly there.
    const roadA = { id: 'a', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] };
    const roadB = { id: 'b', kind: 'residential', width: 8, points: [{ x: 100, z: 0 }, { x: 200, z: 0 }] };
    const a = buildRoadGeometry(roadA);
    const b = buildRoadGeometry(roadB);
    a.computeBoundingBox();
    b.computeBoundingBox();

    // Each ribbon actually reaches past x=100 into the other's territory (half its own
    // width past the shared point), not stopping exactly at the mapped junction.
    expect(a.boundingBox!.max.x).toBeGreaterThan(100);
    expect(b.boundingBox!.min.x).toBeLessThan(100);
    // ...and the true endpoint (x=0 / x=200) is left untouched.
    expect(a.boundingBox!.min.x).toBeCloseTo(0 - 4); // half of width 8
    expect(b.boundingBox!.max.x).toBeCloseTo(200 + 4);
  });

  it('floors the endpoint extension for very narrow roads instead of an unnoticeably small one', () => {
    // width/2 alone would extend this 0.6m-wide path by just 0.3m — the 0.5m floor
    // takes over instead, so even a very narrow path still bridges a typical gap.
    const path = { id: 'p', kind: 'path', width: 0.6, points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] };
    const geometry = buildRoadGeometry(path);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.x).toBeCloseTo(-0.5);
    expect(geometry.boundingBox!.max.x).toBeCloseTo(50.5);
  });

  it('hands a deck over to its approach at the same height, so the two ribbons meet instead of stepping', () => {
    // The rendered check behind the profile-level one in roadElevationProfile.test.ts:
    // the deck's own vertices and the approach's have to agree at the node they share,
    // because that is what the player drives across.
    const span = { id: 'span', kind: 'primary', width: 10, structure: 'bridge' as const, layer: 1, points: [{ x: -15, z: 0 }, { x: 15, z: 0 }] };
    const under = { id: 'under', kind: 'residential', width: 8, points: [{ x: 0, z: -60 }, { x: 0, z: 60 }] };
    const east = { id: 'east', kind: 'primary', width: 10, points: [{ x: 15, z: 0 }, { x: 160, z: 0 }] };
    const profiles = buildRoadElevationProfiles([span, under, east], [], { baseElevation: roadSurfaceElevation });

    // Centerline height at each mapped point, read off the built ribbon rather than the
    // profile, so this covers the geometry path end to end.
    const centers = (road: typeof span | typeof east) => {
      const position = buildRoadGeometry(road, [], profiles.get(road.id)).getAttribute('position');
      const out: { x: number; y: number }[] = [];
      // Only the top ribbon: both of these roads are decks now (the approach carries the
      // span's lift, so it is extruded too), and everything past the ribbon's own
      // 2-per-point pairs is underside and wall.
      const ribbon = (road.points.length + 2) * 2;
      for (let vertex = 0; vertex < ribbon; vertex += 2) out.push({ x: position.getX(vertex), y: position.getY(vertex) });
      return out;
    };
    const deck = centers(span);
    const approach = centers(east);

    // The deck's east end and the approach's west end are the same junction node...
    const deckEnd = deck.find((point) => Math.abs(point.x - 15) < 1e-6)!;
    const approachStart = approach.find((point) => Math.abs(point.x - 15) < 1e-6)!;
    expect(approachStart.y).toBeCloseTo(deckEnd.y, 6);
    // ...the deck is genuinely up in the air there, not merely consistent at ground level...
    expect(deckEnd.y).toBeGreaterThan(2);
    // ...and the approach has come back down to street level by its far end.
    expect(approach[approach.length - 1].y).toBeCloseTo(roadSurfaceElevation(east), 1);

    // Physics reads the same profiles, so a vehicle rolling off the deck onto the
    // approach is grounded on the ramp it can see rather than snapping to the terrain
    // under it — the "no snapping between terrain and road heights" half of backlog 8.
    expect(roadElevationAtPoint(15, 0, profiles)).toBeCloseTo(deckEnd.y, 6);
    expect(roadElevationAtPoint(40, 0, profiles)!).toBeGreaterThan(roadSurfaceElevation(east));
  });

  it('draws an elevated deck in its own depth-writing pass, after the roads it crosses over', () => {
    // A bridge tagged over the span, an ordinary street passing under it, and the street
    // the deck hands over to at each end.
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    world.replace({
      ...worldData('maplibre'),
      roads: [
        { id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1, points: [{ x: -15, z: 0 }, { x: 15, z: 0 }] },
        { id: 'under', kind: 'residential', width: 8, points: [{ x: 0, z: -60 }, { x: 0, z: 60 }] },
        { id: 'east', kind: 'primary', width: 10, points: [{ x: 15, z: 0 }, { x: 160, z: 0 }] },
      ],
    });

    // Carriageways only: the roads group also holds the merged parapet and pier meshes,
    // which are ordinary opaque geometry in their own materials and play no part in the
    // road layering this test is about.
    const STRUCTURE_MESHES = new Set(['world:road-railings', 'world:bridge-piers']);
    const meshes = (scene.getObjectByName('world:roads')?.children ?? [])
      .filter((child): child is THREE.Mesh => child instanceof THREE.Mesh && !STRUCTURE_MESHES.has(child.name));
    const materialOf = (mesh: THREE.Mesh) => mesh.material as THREE.ShaderMaterial;
    const decks = meshes.filter((mesh) => materialOf(mesh).depthWrite);
    const grounded = meshes.filter((mesh) => !materialOf(mesh).depthWrite);
    expect(decks.length).toBeGreaterThan(0);
    expect(grounded.length).toBeGreaterThan(0);

    // Without the depth write, the street underneath paints straight over the deck
    // crossing above it — the single most obvious way a grade separation reads as broken.
    // With it, and with every deck drawn after every ground ribbon, the deck covers.
    const lowestDeck = Math.min(...decks.map((mesh) => mesh.renderOrder));
    const highestGround = Math.max(...grounded.map((mesh) => mesh.renderOrder));
    expect(lowestDeck).toBeGreaterThan(highestGround);

    // The two variants are separate materials, not one mutated in place, so a ground
    // ribbon never inherits the deck's depth behavior.
    expect(new Set(meshes.map(materialOf)).size).toBe(meshes.length);

    // A deck is the one road geometry with a world underneath it to shadow. A ground
    // ribbon can only cast onto itself, which is why it still doesn't.
    for (const mesh of decks) expect(mesh.castShadow).toBe(true);
    for (const mesh of grounded) expect(mesh.castShadow).toBe(false);
    for (const mesh of meshes) expect(mesh.receiveShadow).toBe(true);
  });

  it('gives intersecting road meshes stable, class-aware elevation layers', () => {
    const residential = { id: 'local-a', kind: 'residential', width: 7, points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] };
    const primary = { ...residential, id: 'main-a', kind: 'primary' };
    expect(roadSurfaceElevation(primary)).toBeGreaterThan(roadSurfaceElevation(residential));
    expect(roadSurfaceElevation(residential)).toBe(roadSurfaceElevation(residential));
  });

  it('separates road classes by more than the depth buffer can lose, and ignores road id', () => {
    const residential = { id: 'local-a', kind: 'residential', width: 7, points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] };
    const tertiary = { ...residential, id: 'local-b', kind: 'tertiary' };
    expect(roadSurfaceElevation(tertiary) - roadSurfaceElevation(residential)).toBeGreaterThanOrEqual(0.005);
    // Two roads of the same class sit at exactly one height; same-class overlaps are
    // resolved by draw order, not by sub-millimeter elevation noise nothing can see.
    expect(roadSurfaceElevation({ ...residential, id: 'a-totally-different-id' }))
      .toBe(roadSurfaceElevation(residential));
  });

  it('pins each road to a camera-independent draw slot so same-class junctions cannot flicker', () => {
    const a = { id: 'local-a', kind: 'residential', width: 7, points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] };
    const b = { ...a, id: 'local-b' };
    expect(roadRenderOrder(a)).not.toBe(roadRenderOrder(b));
    expect(roadRenderOrder(a)).toBe(roadRenderOrder({ ...a }));
    // Draw order agrees with the elevation layering rather than fighting it.
    expect(roadRenderOrder({ ...a, kind: 'motorway' })).toBeGreaterThan(roadRenderOrder({ ...a, kind: 'footway' }));
    expect(Number.isInteger(roadRenderOrder(a))).toBe(true);
  });

  it('merges same-material roads into one draw call per style key and keeps every road inspectable', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    // 'minor' (residential/tertiary), 'major' (primary) and 'highway' (motorway) —
    // three style keys, so three merged meshes regardless of how many roads share each.
    data.roads.push(
      { id: 'local-a', kind: 'residential', width: 7, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] },
      { id: 'local-b', kind: 'tertiary', width: 7, points: [{ x: 0, z: 20 }, { x: 10, z: 20 }] },
      { id: 'main-a', kind: 'primary', width: 10, points: [{ x: 0, z: 40 }, { x: 10, z: 40 }] },
      { id: 'motorway-a', kind: 'motorway', width: 14, points: [{ x: 0, z: 60 }, { x: 10, z: 60 }] },
    );
    world.replace(data);

    const roadsGroup = scene.getObjectByName('world:roads')!;
    expect(roadsGroup.children.length).toBe(3);

    const minorMesh = roadsGroup.children.find((child) => {
      const records = (child as THREE.Mesh).userData[INSPECTION_USER_DATA_KEY] as { id: string }[];
      return records.some((record) => record.id === 'local-a');
    }) as THREE.Mesh;
    // Both minor-family roads (residential + tertiary) share one draw call.
    const minorIds = new Set((minorMesh.userData[INSPECTION_USER_DATA_KEY] as { id: string }[]).map((r) => r.id));
    expect(minorIds).toEqual(new Set(['local-a', 'local-b']));

    // Each hit face resolves back to its own road, not the whole merged mesh — this is
    // what the inspector reads (see worldInspector.ts's recordForIntersection).
    const records = minorMesh.userData[INSPECTION_USER_DATA_KEY] as { id: string }[];
    const firstRoadFaceCount = records.filter((record) => record.id === records[0].id).length;
    expect(records[0].id).not.toBe(records[records.length - 1].id);
    expect(firstRoadFaceCount).toBeGreaterThan(0);
    expect(firstRoadFaceCount).toBeLessThan(records.length);
  });

  it('raises a road above a park/landuse mound it runs through instead of being buried inside it', () => {
    const road = { id: 'through-park', kind: 'residential', width: 6, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] };
    const forest = { id: 'forest-a', kind: 'forest', rings: [[{ x: -5, z: -5 }, { x: 15, z: -5 }, { x: 15, z: 5 }, { x: -5, z: 5 }]] };

    const bare = buildRoadGeometry(road);
    const cleared = buildRoadGeometry(road, computeTerrainClearance([forest]));
    bare.computeBoundingBox();
    cleared.computeBoundingBox();

    // Wood banks rise 0.6-1.1m (see parkExtrusionHeight); the road's own baseline
    // elevation is under 0.19, so without clearance it would sit inside the solid bank.
    expect(bare.boundingBox!.min.y).toBeLessThan(0.6);
    expect(cleared.boundingBox!.min.y).toBeGreaterThan(0.6);
    expect(cleared.boundingBox!.min.y).toBeGreaterThan(bare.boundingBox!.min.y);
  });

  it('samples terrain height by actual containment, not by bounding box', () => {
    // An L-shaped wood. Its bounding box covers the whole 100x100 square, but the
    // notch at (80, 80) is open ground — a road or a tree there stands at zero.
    const wood = {
      id: 'l-shaped', kind: 'forest',
      rings: [[
        { x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 40 },
        { x: 40, z: 40 }, { x: 40, z: 100 }, { x: 0, z: 100 },
      ]],
    };
    const clearance = computeTerrainClearance([wood]);

    expect(terrainHeightAt({ x: 20, z: 20 }, clearance)).toBeGreaterThan(0.6);
    expect(terrainHeightAt({ x: 80, z: 80 }, clearance)).toBe(0);
    expect(terrainHeightAt({ x: 500, z: 500 }, clearance)).toBe(0);
    expect(terrainHeightAt({ x: 20, z: 20 }, [])).toBe(0);
  });

  it('reports the tallest terrain under a point where polygons overlap', () => {
    const ring = [[{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 50, z: 50 }, { x: 0, z: 50 }]];
    const clearance = computeTerrainClearance([
      { id: 'grass', kind: 'grass', rings: ring },
      { id: 'wood', kind: 'wood', rings: ring },
    ]);
    // The wood is the taller of the two, and it is the one a road has to clear.
    expect(terrainHeightAt({ x: 25, z: 25 }, clearance)).toBeGreaterThan(0.6);
  });

  it('keeps landuse low enough that its edges are not cliffs', () => {
    // Polygon boundaries are a data seam, not a feature of the ground: anything tall
    // enough to read as a step turns every park border into a wall.
    const height = (kind: string, id: string) => {
      const geometry = buildParkGeometry({
        id, kind, rings: [[{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 40 }, { x: 0, z: 40 }]],
      });
      geometry.computeBoundingBox();
      return geometry.boundingBox!.max.y;
    };
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(height('forest', id)).toBeLessThan(1.2);
      expect(height('park', id)).toBeLessThan(0.2);
      // Still off the ground plane, which is what keeps duplicate polygons apart.
      expect(height('park', id)).toBeGreaterThan(0.05);
    }
  });

  it('builds an inward foam band around a water polygon instead of a hard shoreline edge', () => {
    const ring = [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 40 }, { x: 0, z: 40 }];
    const geometry = buildShorelineGeometry(ring, 0.02, 1.6);
    expect(geometry).not.toBeNull();
    geometry!.computeBoundingBox();

    // Two rings of vertices: the water's own boundary and one offset inward by the
    // band width — never outward over land, which the boundary alone can't guarantee
    // (a slightly-too-wide band on a small or concave pond would fold back on itself).
    const position = geometry!.getAttribute('position');
    expect(position.count).toBe(ring.length * 2);
    expect(geometry!.boundingBox!.min.x).toBeCloseTo(0);
    expect(geometry!.boundingBox!.max.x).toBeCloseTo(40);

    // Foam is brightest at the true shoreline and fades into the water's own tint —
    // it blends into the surface it sits on rather than needing its own alpha channel.
    const color = geometry!.getAttribute('color');
    const outerBrightness = color.getX(0) + color.getY(0) + color.getZ(0);
    const innerBrightness = color.getX(ring.length) + color.getY(ring.length) + color.getZ(ring.length);
    expect(outerBrightness).toBeGreaterThan(innerBrightness);
  });

  it('returns null for a shoreline band on a degenerate ring', () => {
    expect(buildShorelineGeometry([], 0.02, 1.6)).toBeNull();
    expect(buildShorelineGeometry([{ x: 0, z: 0 }, { x: 1, z: 0 }], 0.02, 1.6)).toBeNull();
  });

  it('keeps the foam band inward everywhere on a concave (L-shaped) water polygon', () => {
    // An L-shaped pond, the shape the old centroid-direction offset broke on: the
    // reflex (inner) corner's "toward the centroid" direction points roughly along the
    // notch, not into the water on either side of it, so a foam vertex built that way
    // could land outside the ring entirely. insetRing's per-edge miter has no such
    // failure mode.
    const lShape = [
      { x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 20 },
      { x: 20, z: 20 }, { x: 20, z: 40 }, { x: 0, z: 40 },
    ];
    const geometry = buildShorelineGeometry(lShape, 0.02, 1.6);
    expect(geometry).not.toBeNull();
    const position = geometry!.getAttribute('position');
    const pointInRing = (x: number, z: number) => {
      let inside = false;
      for (let i = 0, j = lShape.length - 1; i < lShape.length; j = i, i += 1) {
        const a = lShape[i];
        const b = lShape[j];
        if (((a.z > z) !== (b.z > z)) && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || Number.EPSILON) + a.x) {
          inside = !inside;
        }
      }
      return inside;
    };
    // The inner ring (indices lShape.length..2*lShape.length-1) must stay inside the
    // water polygon, never fold out over land.
    for (let i = lShape.length; i < position.count; i += 1) {
      expect(pointInRing(position.getX(i), position.getZ(i))).toBe(true);
    }
  });

  it('washes the shallows in from the shore and fades them out where wading ends', () => {
    const ring = [{ x: 0, z: 0 }, { x: 80, z: 0 }, { x: 80, z: 80 }, { x: 0, z: 80 }];
    const geometry = buildShallowsGeometry(ring, 0.02, WATER_SHELF_WIDTH)!;
    expect(geometry).not.toBeNull();

    const color = geometry.getAttribute('color');
    // Four components, which is what lets the band end in open water without a seam:
    // opaque bottom-colour at the shore, fully transparent at the shelf edge.
    expect(color.itemSize).toBe(4);
    expect(color.getW(0)).toBeGreaterThan(0.2);
    expect(color.getW(ring.length)).toBe(0);

    // The band reaches exactly as far in as the depth model says you can still stand.
    const position = geometry.getAttribute('position');
    expect(position.getX(ring.length)).toBeCloseTo(WATER_SHELF_WIDTH, 5);
  });

  it('narrows a band rather than folding it inside-out on water too small to hold it', () => {
    // insetRing miters corners inward with no notion of the ring running out of interior,
    // so an inset wider than the polygon's own half-width turns the inner ring inside-out
    // and the band draws back over itself. A 6m-wide stream cannot hold a 7m shelf.
    const narrow = [{ x: 0, z: 0 }, { x: 200, z: 0 }, { x: 200, z: 6 }, { x: 0, z: 6 }];
    const geometry = buildShallowsGeometry(narrow, 0.02, WATER_SHELF_WIDTH)!;
    expect(geometry).not.toBeNull();
    const position = geometry.getAttribute('position');
    for (let index = narrow.length; index < position.count; index += 1) {
      // Every inner vertex still inside the stream, on the correct side of both banks.
      expect(position.getZ(index)).toBeGreaterThan(0);
      expect(position.getZ(index)).toBeLessThan(6);
    }
  });

  it('builds no band at all for water narrower than the band would be', () => {
    const sliver = [{ x: 0, z: 0 }, { x: 200, z: 0 }, { x: 200, z: 0.05 }, { x: 0, z: 0.05 }];
    expect(buildShallowsGeometry(sliver, 0.02, WATER_SHELF_WIDTH)).toBeNull();
    expect(buildShorelineGeometry(sliver, 0.02, 1.6)).toBeNull();
  });

  it('stacks the three water layers in the order they read: surface, shallows, then foam', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.water.push({
      id: 'bay',
      kind: 'water',
      rings: [[{ x: 0, z: 0 }, { x: 80, z: 0 }, { x: 80, z: 80 }, { x: 0, z: 80 }]],
    });
    world.replace(data);

    const surface = scene.getObjectByName('world:water-surface:bay') as THREE.Mesh;
    const shallows = scene.getObjectByName('world:water-shallows:bay') as THREE.Mesh;
    const foam = scene.getObjectByName('world:water-shoreline:bay') as THREE.Mesh;
    expect(shallows).toBeInstanceOf(THREE.Mesh);
    expect(surface.renderOrder).toBeLessThan(shallows.renderOrder);
    expect(shallows.renderOrder).toBeLessThan(foam.renderOrder);
    // And each sits a hair above the one below it, all measured off the same datum.
    const heightOf = (mesh: THREE.Mesh) => {
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox!.max.y;
    };
    expect(heightOf(shallows)).toBeGreaterThan(heightOf(surface));
    expect(heightOf(foam)).toBeGreaterThan(heightOf(shallows));
  });

  it('stands street furniture on the ground under it rather than at y = 0', () => {
    // Every batch but the lamps was planted at the base ground plane regardless of the
    // landuse under it, so a shelter beside a mound stood knee-deep in the bank.
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    const mound = [{ x: -400, z: -400 }, { x: 400, z: -400 }, { x: 400, z: 400 }, { x: -400, z: 400 }];
    data.parks.push({ id: 'wood', kind: 'forest', rings: [mound] });
    // Two main roads crossing, which is what earns a signalised junction and a shelter,
    // plus a back lane, which is what earns a post box.
    data.roads.push({ id: 'main', kind: 'primary', width: 14, points: [{ x: -300, z: 0 }, { x: 300, z: 0 }] });
    data.roads.push({ id: 'cross', kind: 'primary', width: 12, points: [{ x: 0, z: -300 }, { x: 0, z: 300 }] });
    data.roads.push({ id: 'lane', kind: 'residential', width: 7, points: [{ x: -300, z: 60 }, { x: 300, z: 60 }] });
    world.replace(data);

    // Ground level well inside the wood — what everything standing there is measured from.
    const ground = terrainHeightAt({ x: 0, z: 0 }, computeTerrainClearance(data.parks));
    expect(ground).toBeGreaterThan(0.5);

    /** Lowest instance origin across every mesh in a batch. The bottom of a pole sits at
     * the placement's own base, so nothing in the batch should be under the ground. */
    const lowestIn = (groupName: string) => {
      const group = scene.getObjectByName(groupName);
      if (!group) return null;
      const matrix = new THREE.Matrix4();
      let lowest = Infinity;
      group.traverse((child) => {
        if (!(child instanceof THREE.InstancedMesh)) return;
        for (let index = 0; index < child.count; index += 1) {
          child.getMatrixAt(index, matrix);
          lowest = Math.min(lowest, matrix.elements[13]);
        }
      });
      return Number.isFinite(lowest) ? lowest : null;
    };

    const batches = ['world:bus-stops', 'world:mailboxes', 'world:traffic-lights']
      .map((name) => ({ name, y: lowestIn(name) }))
      .filter((entry): entry is { name: string; y: number } => entry.y !== null);
    // All three are the point of this test; if a fixture change stops one being placed,
    // that should fail here rather than quietly reduce what is being checked.
    expect(batches.map((entry) => entry.name)).toEqual([
      'world:bus-stops', 'world:mailboxes', 'world:traffic-lights',
    ]);
    for (const entry of batches) {
      expect(entry.y, entry.name).toBeGreaterThan(ground - 0.1);
    }

    // And the collision frames go with them — a prop whose body is at y=0 while its mesh
    // is a metre up is the same bug in the half nobody can see.
    const furniture = world.getProps().filter((prop) =>
      prop.kind === 'bus-stop' || prop.kind === 'mailbox' || prop.kind === 'traffic-signal');
    expect(furniture.length).toBeGreaterThan(0);
    for (const prop of furniture) expect(prop.position.y).toBeGreaterThan(ground - 0.1);
  });

  it('draws water from the shared terrain datum, clearing a mound it sits inside rather than a fixed y', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('water-datum');
    // A tall forest mound with a pond ring sitting on the same footprint, standing in
    // for a pond inside a wood: the fixed-height water plane used to draw flat through
    // the mound instead of resting on top of it.
    const ring = [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 30 }, { x: 0, z: 30 }];
    data.parks.push({ id: 'mound', kind: 'forest', rings: [ring] });
    data.water.push({ id: 'pond', kind: 'water', rings: [ring] });
    // Slope 0: a vertical-sided mound, so the ring's own vertices sit at the mound's
    // full height instead of ramping to 0 exactly at the boundary they share with the
    // water ring — keeps the fixture's "ground under the water ring" unambiguous.
    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, terrain: { ...DEFAULT_RENDER_OPTIONS.terrain, slope: 0 } });
    world.replace(data);
    let guard = 0;
    while (world.pump(0) && guard < 10_000) guard += 1;

    const surface = scene.getObjectByName('world:water-surface:pond') as THREE.Mesh;
    expect(surface).toBeDefined();
    surface.geometry.computeBoundingBox();
    const waterY = surface.geometry.boundingBox!.max.y;

    const clearance = computeTerrainClearance(data.parks, { ...DEFAULT_RENDER_OPTIONS.terrain, slope: 0 });
    const groundHeight = Math.max(...ring.map((p) => terrainHeightAt(p, clearance)));
    expect(groundHeight).toBeGreaterThan(0);
    expect(waterY).toBeCloseTo(groundHeight + WATER_SURFACE_EPSILON, 4);
  });

  it('slopes a landuse polygon\'s edge inward instead of walling it off', () => {
    // The mound is a frustum: its base is the polygon's own outline and its top face is
    // that outline pulled in by the ramp, so every side is a bank rather than a wall.
    const geometry = buildParkGeometry({
      id: 'bevel-check', kind: 'park', rings: [[{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 40 }, { x: 0, z: 40 }]],
    });
    geometry.computeBoundingBox();
    const maxY = geometry.boundingBox!.max.y;
    const position = geometry.getAttribute('position');
    let baseMaxX = -Infinity;
    let topMaxX = -Infinity;
    for (let index = 0; index < position.count; index += 1) {
      if (position.getY(index) > maxY - 1e-4) topMaxX = Math.max(topMaxX, position.getX(index));
      else baseMaxX = Math.max(baseMaxX, position.getX(index));
    }
    expect(baseMaxX).toBeCloseTo(40, 5);
    expect(topMaxX).toBeLessThan(baseMaxX - 0.5);
    // The slope must not visibly enlarge the polygon: it reaches inward from the mapped
    // footprint, so the base still stays within the original 0..40 square.
    expect(geometry.boundingBox!.min.x).toBeGreaterThan(-0.2);
    expect(geometry.boundingBox!.max.x).toBeLessThan(40.2);
  });

  it('leaves a road at its normal low elevation when no park/landuse polygon overlaps it', () => {
    const road = { id: 'clear', kind: 'residential', width: 6, points: [{ x: 100, z: 100 }, { x: 110, z: 100 }] };
    const farForest = { id: 'forest-b', kind: 'forest', rings: [[{ x: -5, z: -5 }, { x: 15, z: -5 }, { x: 15, z: 5 }, { x: -5, z: 5 }]] };

    const withTerrain = buildRoadGeometry(road, computeTerrainClearance([farForest]));
    const withoutTerrain = buildRoadGeometry(road);
    withTerrain.computeBoundingBox();
    withoutTerrain.computeBoundingBox();

    expect(withTerrain.boundingBox!.min.y).toBeCloseTo(withoutTerrain.boundingBox!.min.y);
  });

  it('ramps a road up/down gradually over a park it briefly clips, instead of spiking at a single vertex', () => {
    // A road running mostly outside a small forest polygon, dipping through just its
    // corner for one segment — the exact shape that used to produce an isolated
    // one-vertex elevation spike (a bounding-box hit at one point, baseline everywhere
    // else either side of it).
    const road = {
      id: 'clips-corner', kind: 'residential', width: 6,
      points: [
        { x: 0, z: 0 }, { x: 20, z: 0 }, { x: 40, z: 0 }, { x: 60, z: 0 },
        { x: 80, z: 0 }, { x: 100, z: 0 }, { x: 120, z: 0 },
      ],
    };
    const forest = { id: 'corner-forest', kind: 'forest', rings: [[{ x: 55, z: -5 }, { x: 65, z: -5 }, { x: 65, z: 5 }, { x: 55, z: 5 }]] };
    const geometry = buildRoadGeometry(road, computeTerrainClearance([forest]));
    const position = geometry.getAttribute('position');
    // One centerline sample per point pair. Read straight off the ribbon rather than off
    // `road.points`, so the endpoint stubs extendRoadEndpoints adds are included in the
    // slope check instead of being assumed away.
    const centers: { x: number; y: number }[] = [];
    for (let i = 0; i < position.count; i += 2) centers.push({ x: position.getX(i), y: position.getY(i) });
    const elevations = centers.map((center) => center.y);

    // Every consecutive step must respect the slope cap — no instant jump back to baseline.
    for (let i = 1; i < centers.length; i += 1) {
      const segmentLength = Math.abs(centers[i].x - centers[i - 1].x);
      expect(Math.abs(elevations[i] - elevations[i - 1])).toBeLessThanOrEqual(segmentLength * 0.06 + 1e-9);
    }
    // The clipped segment itself is still raised above the forest's own height...
    expect(Math.max(...elevations)).toBeGreaterThan(0.6);
    // ...but the far ends of the road, well clear of the forest, stay at baseline.
    expect(elevations[0]).toBeCloseTo(roadSurfaceElevation(road));
    expect(elevations[elevations.length - 1]).toBeCloseTo(roadSurfaceElevation(road));
  });

  it('keeps a road visibly above an overlapping park mound through the full render pipeline, not buried inside it', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.roads.push({ id: 'through-park', kind: 'residential', width: 6, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] });
    data.parks.push({ id: 'forest', kind: 'forest', rings: [[{ x: -5, z: -5 }, { x: 15, z: -5 }, { x: 15, z: 5 }, { x: -5, z: 5 }]] });
    world.replace(data);

    const roadMesh = scene.getObjectByName('world:roads')?.children[0] as THREE.Mesh;
    const parkMesh = scene.getObjectByName('world:parks')?.children[0] as THREE.Mesh;
    // The mound slopes down at its own edges, so "above the park" is a question asked
    // per point: every vertex of the road ribbon has to clear the terrain underneath
    // that vertex, not the tallest point of the polygon somewhere else.
    const clearance = computeTerrainClearance(data.parks);
    const position = roadMesh.geometry.getAttribute('position');
    expect(position.count).toBeGreaterThan(0);
    for (let index = 0; index < position.count; index += 1) {
      const ground = terrainHeightAt({ x: position.getX(index), z: position.getZ(index) }, clearance);
      expect(position.getY(index)).toBeGreaterThanOrEqual(ground);
    }
    parkMesh.geometry.computeBoundingBox();
    expect(parkMesh.geometry.boundingBox!.max.y).toBeGreaterThan(0.6);
  });

  it('extrudes a building footprint to its mapped height', () => {
    const geometry = buildBuildingGeometry({
      id: 'building', height: 24,
      rings: [[{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }]],
    });
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.max.y).toBeCloseTo(24);
  });

  it('renders a separate roof cap above the building walls', () => {
    const building = {
      id: 'roofed', height: 18, properties: {},
      rings: [[{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 8, z: 6 }, { x: 0, z: 6 }]],
    };
    const roof = buildRoofGeometry(building);
    roof.computeBoundingBox();
    expect(roof.boundingBox?.min.y).toBeGreaterThanOrEqual(18.035);
    expect(roof.boundingBox?.max.y).toBeGreaterThanOrEqual(18.035);
  });

  it('extrudes landuse areas into real terrain instead of a paper-thin decal, forests rising taller than lawns', () => {
    const forest = buildParkGeometry({ id: 'forest-a', kind: 'forest', rings: [[{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }]] });
    const grass = buildParkGeometry({ id: 'grass-a', kind: 'grass', rings: [[{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }]] });
    forest.computeBoundingBox();
    grass.computeBoundingBox();
    expect(forest.boundingBox?.min.y).toBeCloseTo(0);
    expect(grass.boundingBox?.min.y).toBeCloseTo(0);
    expect(forest.boundingBox!.max.y).toBeGreaterThan(1);
    expect(grass.boundingBox!.max.y).toBeGreaterThan(0);
    expect(grass.boundingBox!.max.y).toBeLessThan(1);
    expect(forest.boundingBox!.max.y).toBeGreaterThan(grass.boundingBox!.max.y);
  });

  it('gives two overlapping landuse polygons different extrusion heights, so they cannot sit exactly coplanar', () => {
    const ring = [[{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }]];
    const a = buildParkGeometry({ id: 'overlap-a', kind: 'park', rings: ring });
    const b = buildParkGeometry({ id: 'overlap-b', kind: 'park', rings: ring });
    a.computeBoundingBox();
    b.computeBoundingBox();
    expect(a.boundingBox!.max.y).not.toBeCloseTo(b.boundingBox!.max.y, 5);
  });

  it('gives grass-like landuse a procedural normal map, but not non-vegetated urban landuse', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    const ring = [[{ x: 200, z: 200 }, { x: 210, z: 200 }, { x: 210, z: 210 }, { x: 200, z: 210 }]];
    data.parks.push(
      { id: 'lawn', kind: 'grass', rings: ring },
      { id: 'city-block', kind: 'residential', rings: [[{ x: 300, z: 300 }, { x: 310, z: 300 }, { x: 310, z: 310 }, { x: 300, z: 310 }]] },
    );
    world.replace(data);

    const parkMeshes = (scene.getObjectByName('world:parks')?.children ?? []) as THREE.Mesh[];
    const materials = parkMeshes.map((mesh) => mesh.material as THREE.MeshStandardMaterial);
    expect(materials.some((material) => material.normalMap != null)).toBe(true);
    expect(materials.some((material) => material.normalMap == null)).toBe(true);
  });

  it('replaces facade batches with the world root and removes them on disposal', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);

    world.replace(worldData('maplibre'));
    expect(scene.children.filter(child => child.name.startsWith('world:'))).toHaveLength(1);
    expect(hasFacade(scene)).toBe(true);
    expect(scene.getObjectByName('world:roofs')).toBeDefined();

    world.replace(worldData('open'));
    expect(scene.children.filter(child => child.name.startsWith('world:'))).toHaveLength(1);
    expect(scene.getObjectByName('world:maplibre')).toBeUndefined();
    expect(hasFacade(scene)).toBe(true);

    world.dispose();
    expect(scene.children.filter(child => child.name.startsWith('world:'))).toHaveLength(0);
    expect(hasFacade(scene)).toBe(false);
  });

  it('draws facade walls without a duplicate plain-box building underneath, but still caps a roof', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    world.replace(worldData('maplibre'));

    // Facades are on by default, so the plain extruded-box fallback must not also be drawn.
    expect(scene.getObjectByName('world:buildings')).toBeUndefined();
    expect(hasFacade(scene)).toBe(true);
    expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThan(0);
  });

  it('creates exactly one named roof cap per visible building and no rooftop equipment', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.buildings = Array.from({ length: 20 }, (_, index) => ({
      id: `flat-roof-${index}`,
      height: 12,
      properties: { 'roof:shape': 'flat' },
      rings: [[
        { x: index * 16, z: 0 },
        { x: index * 16 + 12, z: 0 },
        { x: index * 16 + 12, z: 8 },
        { x: index * 16, z: 8 },
      ]],
    }));

    world.replace(data);

    const roofs = scene.getObjectByName('world:roofs');
    expect(roofs?.children).toHaveLength(data.buildings.length);
    expect(roofs?.children.every(child => child.name.startsWith('world:roof:'))).toBe(true);
  });

  it('places the building mesh, roof and facade walls on the same ground the physics collider uses', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    // A forest mound under the building's footprint gives it a non-zero terrain base —
    // the same base buildingColliderDescriptor samples for the physics box.
    data.parks = [{
      id: 'mound',
      kind: 'forest',
      rings: [[{ x: -20, z: -20 }, { x: 40, z: -20 }, { x: 40, z: 30 }, { x: -20, z: 30 }]],
    }];
    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, facades: false });
    world.replace(data);

    const building = data.buildings[0];
    const terrain = computeTerrainClearance(data.parks, DEFAULT_RENDER_OPTIONS.terrain);
    const centroid = { x: 6, z: 4 };
    const expectedBaseY = terrainHeightAt(centroid, terrain);
    expect(expectedBaseY).toBeGreaterThan(0);

    const mesh = scene.getObjectByName('world:buildings')?.children[0] as THREE.Mesh;
    const roof = scene.getObjectByName(`world:roof:${building.id}`) as THREE.Mesh;
    expect(mesh.position.y).toBeCloseTo(expectedBaseY, 5);
    expect(roof.position.y).toBeCloseTo(expectedBaseY, 5);

    const descriptor = buildingColliderDescriptor(building, terrain);
    expect(descriptor?.boxes[0]?.y).toBeCloseTo(expectedBaseY + building.height / 2, 5);
  });

  it('renders fitted entrance surroundings in bounded instanced batches', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);

    world.replace(worldData('maplibre'));

    const doorstep = scene.getObjectByName('svartaksi-facades:doorsteps:step');
    expect(doorstep).toBeInstanceOf(THREE.InstancedMesh);
    expect((doorstep as THREE.InstancedMesh).count).toBe(1);
    expect(doorstep?.castShadow).toBe(true);
    expect(doorstep?.receiveShadow).toBe(true);
  });

  it('falls back to a plain box building when facades are switched off, still with a roof', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    world.replace(worldData('maplibre'));

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, facades: false });

    expect(hasFacade(scene)).toBe(false);
    expect(scene.getObjectByName('world:buildings')?.children.length).toBeGreaterThan(0);
    expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThan(0);
  });

  it('renders facades with the box style switched off, still with a roof and no floating box', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    world.replace(worldData('maplibre'));

    // Facades used to be gated behind the box-style toggle (`buildings`), so turning
    // the box off silently killed facades too. They must now render independently.
    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, buildings: false });

    expect(hasFacade(scene)).toBe(true);
    expect(scene.getObjectByName('world:buildings')).toBeUndefined();
    expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThan(0);
  });

  it('renders nothing building-related when both the box style and facades are off', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    world.replace(worldData('maplibre'));

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, buildings: false, facades: false });

    expect(hasFacade(scene)).toBe(false);
    expect(scene.getObjectByName('world:buildings')).toBeUndefined();
    expect(scene.getObjectByName('world:roofs')).toBeUndefined();
  });

  it('falls back to a plain box for one building whose facade record fails, even while facades are on for the rest', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.buildings.push({
      id: 'degenerate',
      height: 12,
      properties: {},
      // A repeated vertex produces a zero-length edge, which buildFacadeRecord
      // rejects (extractEdges returns null) — this building must still get *some*
      // wall representation instead of ending up with a floating roof and no walls.
      rings: [[{ x: 20, z: 0 }, { x: 25, z: 0 }, { x: 25, z: 0 }, { x: 20, z: 5 }]],
    });
    world.replace(data);

    // The well-formed building still renders exclusively via facades...
    expect(hasFacade(scene)).toBe(true);
    // ...while the degenerate one gets a plain box fallback instead of nothing.
    expect(scene.getObjectByName('world:buildings')?.children.length).toBe(1);
    expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThanOrEqual(2);
  });

  it('receives shadows on every world surface but only casts from surfaces with volume', () => {
    // Every *shaded* surface receives — an unlit material (a lamp lens) is excluded,
    // since nothing the shadow map says could change what it draws. Casting is the
    // selective half: a flat sliver (ground plane, water sheet, road ribbon) or a
    // curb-height landuse slab can only ever shadow itself, which is a shadow nobody can
    // see bought at the price of a shadow-map pass over every such surface in range.
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.roads.push({ id: 'road', kind: 'primary', width: 8, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] });
    data.water.push({ id: 'water', rings: [[{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }]] });
    data.parks.push({ id: 'park', kind: 'park', rings: [[{ x: 30, z: 0 }, { x: 34, z: 0 }, { x: 34, z: 4 }]] });
    data.parks.push({ id: 'wood', kind: 'forest', rings: [[{ x: 40, z: 0 }, { x: 44, z: 0 }, { x: 44, z: 4 }]] });
    world.replace(data);

    const meshes: THREE.Mesh[] = [];
    scene.traverse((object) => { if (object instanceof THREE.Mesh) meshes.push(object); });
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      if ((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) instanceof THREE.MeshBasicMaterial) {
        // A self-lit lens is the light, not a thing the light falls on: it must neither
        // cast (a hard blob under every lamp post at a low sun) nor receive.
        expect([mesh.name, mesh.castShadow, mesh.receiveShadow]).toEqual([mesh.name, false, false]);
        continue;
      }
      expect([mesh.name, mesh.receiveShadow]).toEqual([mesh.name, true]);
    }

    const groupNames = (name: string) => scene.getObjectByName(name)?.children ?? [];
    for (const flat of [...groupNames('world:ground'), ...groupNames('world:water'), ...groupNames('world:roads')]) {
      expect([flat.name, flat.castShadow]).toEqual([flat.name, false]);
    }

    // No landuse kind casts: they all rise by well under a metre now, and a shadow from
    // a bank that low is a dark rim traced along every polygon edge in the world.
    const parks = groupNames('world:parks');
    expect(parks.map((mesh) => mesh.castShadow)).toEqual([false, false]);
  });

  it('drives every custom shader material from one time-of-day lighting state', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.roads.push({ id: 'road', kind: 'primary', width: 8, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] });
    world.replace(data);

    world.setSceneLighting(sceneLighting(22));

    const shaderMaterials: THREE.ShaderMaterial[] = [];
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial) {
        shaderMaterials.push(object.material);
      }
    });
    // Both families are represented — a road ribbon and at least one facade batch.
    expect(shaderMaterials.length).toBeGreaterThanOrEqual(2);
    for (const material of shaderMaterials) {
      expect(material.uniforms.uNightFactor.value).toBe(1);
      expect(material.uniforms.uSunIntensity.value).toBe(sceneLighting(22).sunIntensity);
    }
  });

  it('re-applies the cached lighting to materials minted by a later rebuild', () => {
    // Facade materials are recreated whenever the visible building set changes (up to
    // 4x/sec while driving). A material born between two time-of-day changes would
    // otherwise render at its permanently-noon defaults until the next one.
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    world.setSceneLighting(sceneLighting(22));
    world.replace(worldData('maplibre'));

    let facade: THREE.Mesh | undefined;
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.name.startsWith('svartaksi-facades:')) facade ??= child;
    });
    expect(facade).toBeDefined();
    expect((facade!.material as THREE.ShaderMaterial).uniforms.uNightFactor.value).toBe(1);
  });

  it('applies surface visibility options to the current world without new data', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.roads.push({ id: 'road', kind: 'primary', width: 8, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] });
    data.water.push({ id: 'water', rings: [[{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }]] });
    world.replace(data);

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, roads: false, water: false, facades: false });

    expect(scene.getObjectByName('world:roads')).toBeUndefined();
    expect(scene.getObjectByName('world:water')).toBeUndefined();
    expect(hasFacade(scene)).toBe(false);
    expect(scene.getObjectByName('world:buildings')).toBeDefined();
  });

  it('renders mapped street furniture as instanced geometry', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.objects.push(
      { id: 'bench-1', kind: 'bench', point: { x: 2, z: 3 }, properties: {} },
      { id: 'basket-1', kind: 'waste_basket', point: { x: 4, z: 3 }, properties: {} },
    );
    world.replace(data);

    expect(scene.getObjectByName('world:objects:bench')).toBeInstanceOf(THREE.InstancedMesh);
    expect(scene.getObjectByName('world:objects:waste_basket')).toBeInstanceOf(THREE.InstancedMesh);
  });

  it('renders mapped trees through the vegetation batches, not as generic furniture', () => {
    // Trees share one instanced batch with the procedurally scattered ones so a street
    // tree and a forest tree cost the same four draw calls between them.
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.objects.push(
      { id: 'tree-1', kind: 'tree', point: { x: 5, z: 6 }, properties: { leaf_type: 'needleleaved' } },
      { id: 'tree-2', kind: 'tree', point: { x: 9, z: 6 }, properties: { leaf_type: 'broadleaved' } },
    );
    world.replace(data);

    expect(scene.getObjectByName('world:objects:tree')).toBeUndefined();
    expect(scene.getObjectByName('world:trees:needleleaf')).toBeInstanceOf(THREE.InstancedMesh);
    expect(scene.getObjectByName('world:trees:broadleaf')).toBeInstanceOf(THREE.InstancedMesh);
    expect(scene.getObjectByName('world:trees:trunks')).toBeInstanceOf(THREE.InstancedMesh);
  });

  it('plants trees inside a wood polygon and stands them on top of its terrain', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.parks.push({
      id: 'wood-1',
      kind: 'wood',
      rings: [[{ x: -60, z: -60 }, { x: 60, z: -60 }, { x: 60, z: 60 }, { x: -60, z: 60 }]],
    });
    world.replace(data);

    const trunks = scene.getObjectByName('world:trees:trunks') as THREE.InstancedMesh | undefined;
    expect(trunks?.count).toBeGreaterThan(20);

    // A wood extrudes into a solid bank 0.6-1.1m tall. Planting at y=0 would bury
    // every trunk inside the very polygon that placed it.
    const matrix = new THREE.Matrix4();
    trunks!.getMatrixAt(0, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).y).toBeGreaterThan(0.6);
  });

  it('controls procedural street lights independently from mapped street furniture', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.roads.push({ id: 'road', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] });
    world.replace(data);

    const lights = scene.getObjectByName('world:street-lights');
    expect(lights).toBeDefined();
    expect(lights?.getObjectByName('world:street-lights:poles')).toBeInstanceOf(THREE.InstancedMesh);
    const bulbs = lights?.getObjectByName('world:street-lights:bulbs') as THREE.InstancedMesh;
    expect(bulbs).toBeInstanceOf(THREE.InstancedMesh);

    // The lamps are baked rather than simulated, so "switching them on" is a repaint of
    // the lens material from the same night factor everything else is shaded by.
    const lens = bulbs.material as THREE.MeshBasicMaterial;
    world.setSceneLighting(sceneLighting(12));
    const byDay = lens.color.getHex();
    world.setSceneLighting(sceneLighting(23));
    expect(lens.color.getHex()).not.toBe(byDay);
    expect(lens.color.r + lens.color.g + lens.color.b)
      .toBeGreaterThan(new THREE.Color(byDay).r + new THREE.Color(byDay).g + new THREE.Color(byDay).b);

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, streetFurniture: false });
    expect(scene.getObjectByName('world:street-lights')).toBeDefined();

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, streetLights: false });
    expect(scene.getObjectByName('world:street-lights')).toBeUndefined();
  });

  it('builds glass bus shelters on the street-furniture toggle, with a baked tube', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.roads.push({ id: 'route', kind: 'primary', width: 14, points: [{ x: -400, z: 0 }, { x: 400, z: 0 }] });
    world.replace(data);

    const shelters = scene.getObjectByName('world:bus-stops');
    expect(shelters).toBeDefined();
    for (const part of ['bars', 'glass-back', 'glass-sides', 'roof', 'tube', 'bench-seat', 'bench-legs']) {
      expect(shelters?.getObjectByName(`world:bus-stops:${part}`)).toBeInstanceOf(THREE.InstancedMesh);
    }
    // Four corner bars per shelter, one back panel — same batch, different instance counts.
    const bars = shelters?.getObjectByName('world:bus-stops:bars') as THREE.InstancedMesh;
    const back = shelters?.getObjectByName('world:bus-stops:glass-back') as THREE.InstancedMesh;
    expect(bars.count).toBe(back.count * 4);

    // The tube is baked like the lamp lenses: night is a repaint, not a light.
    const tube = (shelters?.getObjectByName('world:bus-stops:tube') as THREE.InstancedMesh)
      .material as THREE.MeshBasicMaterial;
    world.setSceneLighting(sceneLighting(12));
    const byDay = new THREE.Color(tube.color.getHex());
    world.setSceneLighting(sceneLighting(23));
    expect(tube.color.getHex()).not.toBe(byDay.getHex());
    expect(tube.color.r + tube.color.g + tube.color.b).toBeGreaterThan(byDay.r + byDay.g + byDay.b);

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, streetLights: false });
    expect(scene.getObjectByName('world:bus-stops')).toBeDefined();

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, streetFurniture: false });
    expect(scene.getObjectByName('world:bus-stops')).toBeUndefined();
  });

  it('signals a junction of two crossing roads, on the street-lighting toggle', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.roads.push(
      { id: 'main', kind: 'primary', width: 14, points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] },
      { id: 'side', kind: 'residential', width: 9, points: [{ x: 0, z: -80 }, { x: 0, z: 80 }] },
    );
    world.replace(data);

    expect(scene.getObjectByName('world:traffic-lights')).toBeDefined();
    expect(scene.getObjectByName('world:traffic-lights:green')).toBeInstanceOf(THREE.InstancedMesh);

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, streetLights: false });
    expect(scene.getObjectByName('world:traffic-lights')).toBeUndefined();
  });

  it('hangs neon over a storefront, on the street-furniture toggle', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    // worldData's building spans x 0..12, z 0..8 and stands 16m tall.
    data.objects.push({ id: 'shop', kind: 'storefront', point: { x: 6, z: -3 }, properties: { class: 'bar' } });
    world.replace(data);

    expect(scene.getObjectByName('world:neon-signs:faces')).toBeInstanceOf(THREE.InstancedMesh);

    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, streetFurniture: false });
    expect(scene.getObjectByName('world:neon-signs')).toBeUndefined();
  });

  it('drives the animated world from one clock, and survives having nothing to animate', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.roads.push(
      { id: 'main', kind: 'primary', width: 14, points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] },
      { id: 'side', kind: 'residential', width: 9, points: [{ x: 0, z: -80 }, { x: 0, z: 80 }] },
    );
    // Before any world exists at all: setAnimationTime must be safe to call every frame.
    expect(() => world.setAnimationTime(3)).not.toThrow();

    world.replace(data);
    const lens = scene.getObjectByName('world:traffic-lights:green') as THREE.InstancedMesh;
    const brightness = (index: number) => {
      const color = new THREE.Color();
      lens.getColorAt(index, color);
      return color.r + color.g + color.b;
    };
    // The commit already replayed the clock, so a junction is lit on its first frame
    // rather than showing every lens dark until the next tick.
    const first = brightness(0);
    const second = brightness(2);
    expect(Math.max(first, second)).toBeGreaterThan(Math.min(first, second));

    world.setAnimationTime(17);
    expect(brightness(0)).not.toBe(first);
  });

  it('wires cinematic materials and facade details to their actual scene consumers', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.water.push({
      id: 'water',
      kind: 'water',
      rings: [[{ x: 20, z: 20 }, { x: 30, z: 20 }, { x: 30, z: 30 }, { x: 20, z: 30 }]],
    });
    world.replace(data);

    const cinematicWater = scene.getObjectByName('world:water-surface:water') as THREE.Mesh;
    expect((cinematicWater.material as THREE.MeshStandardMaterial).normalMap).not.toBeNull();
    expect(scene.getObjectByName('svartaksi-facades:doorsteps:step')).toBeDefined();

    world.setRenderOptions({
      ...DEFAULT_RENDER_OPTIONS,
      cinematicMaterials: false,
      facadeDetails: false,
    });

    const simpleWater = scene.getObjectByName('world:water-surface:water') as THREE.Mesh;
    expect((simpleWater.material as THREE.MeshStandardMaterial).normalMap).toBeNull();
    expect(scene.getObjectByName('svartaksi-facades:doorsteps:step')).toBeUndefined();
  });

  it('draws a foam shoreline band alongside every water surface', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.water.push({
      id: 'water',
      kind: 'water',
      rings: [[{ x: 20, z: 20 }, { x: 30, z: 20 }, { x: 30, z: 30 }, { x: 20, z: 30 }]],
    });
    world.replace(data);

    const shoreline = scene.getObjectByName('world:water-shoreline:water') as THREE.Mesh;
    expect(shoreline).toBeInstanceOf(THREE.Mesh);
    expect((shoreline.material as THREE.MeshBasicMaterial).vertexColors).toBe(true);
  });

  it('shares one water material and one foam material across every polygon in a build', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    for (let index = 0; index < 4; index += 1) {
      const x = 20 + index * 40;
      data.water.push({
        id: `pond${index}`,
        kind: 'water',
        rings: [[{ x, z: 20 }, { x: x + 10, z: 20 }, { x: x + 10, z: 30 }, { x, z: 30 }]],
      });
    }
    world.replace(data);

    // One shader compile and one uniform write for the whole build, not one per polygon —
    // the water was previously constructing a material per lake.
    const surfaces = [0, 1, 2, 3].map((index) => scene.getObjectByName(`world:water-surface:pond${index}`) as THREE.Mesh);
    const foams = [0, 1, 2, 3].map((index) => scene.getObjectByName(`world:water-shoreline:pond${index}`) as THREE.Mesh);
    expect(new Set(surfaces.map((mesh) => mesh.material)).size).toBe(1);
    expect(new Set(foams.map((mesh) => mesh.material)).size).toBe(1);
    expect(surfaces[0].material).not.toBe(foams[0].material);
  });

  it('drives the water clock from setAnimationTime, and replays it into a fresh build', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    data.water.push({
      id: 'water',
      kind: 'water',
      rings: [[{ x: 20, z: 20 }, { x: 30, z: 20 }, { x: 30, z: 30 }, { x: 20, z: 30 }]],
    });
    world.replace(data);
    world.setAnimationTime(7.5);

    const clockOf = () => {
      const surface = scene.getObjectByName('world:water-surface:water') as THREE.Mesh;
      return (surface.material as THREE.Material).userData.waterTime as { value: number };
    };
    expect(clockOf().value).toBe(7.5);

    // A rebuild makes new materials; the world's own last-known time is replayed into
    // them on commit, so the waves do not restart from zero every time a chunk streams.
    world.replace(worldData('maplibre'));
    world.replace(data);
    expect(clockOf().value).toBe(7.5);
  });

  it('draws buildings only within the (short) building draw distance, but roads/water/parks well beyond it', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const farButWithinTerrain = MAX_BUILDING_DRAW_DISTANCE + 400;
    expect(farButWithinTerrain).toBeLessThan(MAX_TERRAIN_DRAW_DISTANCE);
    const data: WorldData = {
      source: 'maplibre',
      labels: [],
      objects: [],
      buildings: [{
        id: 'far-building',
        height: 12,
        properties: {},
        rings: [[
          { x: farButWithinTerrain, z: 0 }, { x: farButWithinTerrain + 10, z: 0 },
          { x: farButWithinTerrain + 10, z: 8 }, { x: farButWithinTerrain, z: 8 },
        ]],
      }],
      roads: [{ id: 'far-road', kind: 'residential', width: 6, points: [{ x: farButWithinTerrain, z: 20 }, { x: farButWithinTerrain + 10, z: 20 }] }],
      water: [{ id: 'far-water', rings: [[{ x: farButWithinTerrain, z: 40 }, { x: farButWithinTerrain + 10, z: 40 }, { x: farButWithinTerrain + 10, z: 50 }]] }],
      parks: [{ id: 'far-park', kind: 'park', rings: [[{ x: farButWithinTerrain, z: 60 }, { x: farButWithinTerrain + 10, z: 60 }, { x: farButWithinTerrain + 10, z: 70 }]] }],
    };
    world.replace(data);

    expect(scene.getObjectByName('world:roofs')?.children.length ?? 0).toBe(0);
    expect(scene.getObjectByName('world:roads')?.children.length).toBe(1);
    expect(scene.getObjectByName('world:water')?.children.length).toBeGreaterThanOrEqual(2); // fallback + surface
    expect(scene.getObjectByName('world:parks')?.children.length).toBe(1);
  });

  describe('surface visibility (backlog item 9)', () => {
    it('draws an ordinary road by default', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      const data = worldData('maplibre');
      data.roads.push({ id: 'plain', kind: 'residential', width: 6, points: [{ x: 0, z: 20 }, { x: 20, z: 20 }] });
      world.replace(data);

      expect(scene.getObjectByName('world:roads')?.children.length).toBe(1);
    });

    it('does not draw a tunnel by default, but keeps it in WorldData and still profiles it for routing/physics', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      const data = worldData('maplibre');
      // A crossing road so buildRoadElevationProfiles (item 8) actually has grade-
      // separation evidence to resolve — a profile-less lone way proves nothing about
      // whether hidden roads keep their elevation data once they matter for routing.
      data.roads.push(
        { id: 'under', kind: 'residential', width: 6, structure: 'tunnel', points: [{ x: 10, z: -20 }, { x: 10, z: 20 }] },
        { id: 'over', kind: 'residential', width: 6, points: [{ x: -20, z: 0 }, { x: 40, z: 0 }] },
      );
      world.replace(data);

      // Inclusion for routing/physics survives even though nothing is drawn: WorldData
      // still carries the tunnel, and its RoadElevationProfile still resolves.
      expect(data.roads.some((road) => road.id === 'under')).toBe(true);
      expect(scene.getObjectByName('world:roads')?.children.length).toBe(1); // only 'over'
      expect(world.getRoadElevationProfiles().has('under')).toBe(true);
    });

    it('draws a negative-layer (underpass) ground road, unlike a tunnel', () => {
      // A negative layer is ordering evidence, not a structure: the elevation profile
      // lifts the road above rather than digging this one, so the underpass is an
      // ordinary at-grade ribbon. Hiding it left a hole in the street grid under every
      // bridge, which reads worse than the case the old caution guarded against.
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      const data = worldData('maplibre');
      data.roads.push({ id: 'covered', kind: 'residential', width: 6, structure: 'ground', layer: -1, points: [{ x: 0, z: 20 }, { x: 20, z: 20 }] });
      world.replace(data);

      expect(data.roads.some((road) => road.id === 'covered')).toBe(true);
      expect(scene.getObjectByName('world:roads')?.children.length).toBe(1);
    });

    it('draws the underpass beneath the deck that crosses it, without a gap in the grid', () => {
      // The end-to-end shape of the change: both roads reach the scene, and the crossing
      // deck is lifted clear above the carriageway rather than the two fighting for the
      // same pixels.
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace({
        ...worldData('maplibre'),
        roads: [
          { id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1, points: [{ x: -40, z: 0 }, { x: 40, z: 0 }] },
          { id: 'below', kind: 'residential', width: 8, structure: 'ground', layer: -1, points: [{ x: 0, z: -40 }, { x: 0, z: 40 }] },
        ],
      });

      const structures = new Set(['world:road-railings', 'world:bridge-piers']);
      const carriageways = (scene.getObjectByName('world:roads')?.children ?? [])
        .filter((child) => !structures.has(child.name));
      expect(carriageways.length).toBeGreaterThan(0);

      // Where they cross, the deck is above the underpass by a real clearance rather
      // than coplanar with it.
      const profiles = world.getRoadElevationProfiles();
      const deckHeight = roadElevationAtPoint(0, 0, profiles, 0.5);
      expect(deckHeight).not.toBeNull();
      expect(deckHeight!).toBeGreaterThan(2);
    });

    it('keeps a bridge surface-visible', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      const data = worldData('maplibre');
      data.roads.push({ id: 'over', kind: 'residential', width: 6, structure: 'bridge', layer: 1, points: [{ x: 0, z: 20 }, { x: 20, z: 20 }] });
      world.replace(data);

      const roads = scene.getObjectByName('world:roads')?.children ?? [];
      // One carriageway mesh, plus the parapet a tagged bridge always gets. Supports are
      // excluded alongside the parapet: whether this span stands high enough off its own
      // baseline to earn any is the elevation profile's business, not this test's.
      const structures = new Set(['world:road-railings', 'world:bridge-piers']);
      expect(roads.filter((child) => !structures.has(child.name))).toHaveLength(1);
      expect(roads.some((child) => child.name === 'world:road-railings')).toBe(true);
    });

    it('stands supports under a deck that is genuinely in the air', () => {
      // The end-to-end check for bridgePiers: the pure placement module has its own
      // suite, so what this proves is the wiring — that a real elevated span reaches it
      // and that the merged mesh lands in the scene with shadows on, which is the whole
      // point (a deck was already casting a shadow with nothing under it casting one).
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace({
        ...worldData('maplibre'),
        roads: [
          { id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1, points: [{ x: -60, z: 0 }, { x: 60, z: 0 }] },
          { id: 'under', kind: 'residential', width: 8, points: [{ x: 0, z: -60 }, { x: 0, z: 60 }] },
        ],
      });

      const roads = scene.getObjectByName('world:roads')?.children ?? [];
      const piers = roads.find((child) => child.name === 'world:bridge-piers');
      expect(piers).toBeInstanceOf(THREE.Mesh);
      expect((piers as THREE.Mesh).castShadow).toBe(true);
      expect((piers as THREE.Mesh).receiveShadow).toBe(true);

      // Supports stop at the underside of the deck and reach down toward the baseline,
      // rather than floating at deck height or hanging in the air.
      const position = (piers as THREE.Mesh).geometry.getAttribute('position');
      let minY = Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < position.count; index += 1) {
        minY = Math.min(minY, position.getY(index));
        maxY = Math.max(maxY, position.getY(index));
      }
      expect(maxY).toBeLessThan(roadSurfaceElevation({ id: 'span', kind: 'primary', width: 10, points: [] }) + 100);
      expect(minY).toBeLessThan(maxY - 0.5);
    });

    it('keeps supports out of the carriageway running beneath the deck', () => {
      // A column dropped into the street the viaduct crosses would be a concrete block in
      // a live road, and precisely at the underpass the deck exists to clear.
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace({
        ...worldData('maplibre'),
        roads: [
          { id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1, points: [{ x: -60, z: 0 }, { x: 60, z: 0 }] },
          { id: 'under', kind: 'residential', width: 8, points: [{ x: 0, z: -60 }, { x: 0, z: 60 }] },
        ],
      });

      const roads = scene.getObjectByName('world:roads')?.children ?? [];
      const piers = roads.find((child) => child.name === 'world:bridge-piers') as THREE.Mesh | undefined;
      expect(piers).toBeDefined();
      const position = piers!.geometry.getAttribute('position');
      // The crossing street runs along x=0 and is 8m wide, so nothing may stand within
      // half its width of that line.
      for (let index = 0; index < position.count; index += 1) {
        expect(Math.abs(position.getX(index))).toBeGreaterThan(4);
      }
    });

    it('walls the cutting a tunnel approach ramp is dug into', () => {
      // A tunnel bore is never painted, but the approach carrying the street down to it
      // is an ordinary visible road that the profile digs. The ground is a solid plane at
      // grade, so before this the ribbon simply vanished into it and the car sank with it.
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace({
        ...worldData('maplibre'),
        roads: [
          { id: 'bore', kind: 'primary', width: 10, structure: 'tunnel', points: [{ x: -30, z: 0 }, { x: 30, z: 0 }] },
          { id: 'approach', kind: 'primary', width: 10, points: [{ x: 30, z: 0 }, { x: 120, z: 0 }] },
          { id: 'over', kind: 'residential', width: 8, points: [{ x: 0, z: -50 }, { x: 0, z: 50 }] },
        ],
      });

      const roads = scene.getObjectByName('world:roads')?.children ?? [];
      const trench = roads.find((child) => child.name === 'world:tunnel-trenches') as THREE.Mesh | undefined;
      expect(trench).toBeInstanceOf(THREE.Mesh);
      expect(trench!.castShadow).toBe(true);

      // The approach is dug several metres down at the portal and climbs back to grade,
      // so the walls span that range: down to the road surface, up past grade.
      const position = trench!.geometry.getAttribute('position');
      let minY = Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < position.count; index += 1) {
        minY = Math.min(minY, position.getY(index));
        maxY = Math.max(maxY, position.getY(index));
      }
      expect(minY).toBeLessThan(-2);
      expect(maxY).toBeGreaterThan(0);
    });

    it('builds no cutting for a road that never leaves grade', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.replace({
        ...worldData('maplibre'),
        roads: [
          { id: 'flat', kind: 'residential', width: 8, points: [{ x: -40, z: 0 }, { x: 40, z: 0 }] },
        ],
      });
      const roads = scene.getObjectByName('world:roads')?.children ?? [];
      expect(roads.some((child) => child.name === 'world:tunnel-trenches')).toBe(false);
    });

    it('reveals hidden roads only through the explicit debug override, not by default', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      const data = worldData('maplibre');
      data.roads.push({ id: 'under', kind: 'residential', width: 6, structure: 'tunnel', points: [{ x: 0, z: 20 }, { x: 20, z: 20 }] });
      world.replace(data);
      expect(scene.getObjectByName('world:roads')?.children.length).toBe(0);

      world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, debugShowHiddenRoads: true });
      expect(scene.getObjectByName('world:roads')?.children.length).toBe(1);

      world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, debugShowHiddenRoads: false });
      expect(scene.getObjectByName('world:roads')?.children.length).toBe(0);
    });
  });

  it('follows the current anchor (car position), not the world origin, when applying the building cutoff', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    // The default fixture building sits near (6, 4) — far outside the building cutoff
    // once the anchor moves several kilometers away, even though it's right at the origin.
    world.setAnchor(10_000, 10_000);
    world.replace(data);

    expect(scene.getObjectByName('world:roofs')?.children.length ?? 0).toBe(0);
  });

  it('draws a distant building as a plain box instead of a full facade, even though its facade record is valid', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    const data = worldData('maplibre');
    // The default fixture building's facade record resolves fine (it's a plain
    // rectangle) — this isn't the degenerate-record fallback from the test above.
    // Anchoring at 400 units away puts it inside the 500-unit draw distance (so it
    // still renders) but past the facade detail cutoff, where the batched instanced
    // walls buy nothing over a plain box: a few pixels of silhouette either way.
    world.setAnchor(400, 4);
    world.replace(data);

    expect(hasFacade(scene)).toBe(false);
    expect(scene.getObjectByName('world:buildings')?.children.length).toBe(1);
    expect(scene.getObjectByName('world:roofs')?.children.length).toBe(1);
  });

  describe('updateVisibleBuildings (frustum culling)', () => {
    // The default worldData() fixture building's footprint is centered near (6, 4);
    // anchoring there keeps it well within the (unscaled) building draw distance
    // regardless of camera position, so these tests isolate the frustum effect alone.
    function cameraLookingAlongZ(z: number, target: number): THREE.PerspectiveCamera {
      const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
      camera.position.set(6, 5, z);
      camera.lookAt(6, 5, target);
      camera.updateProjectionMatrix();
      return camera;
    }

    it('keeps a building in view when the camera actually faces it', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.setAnchor(6, 4);
      world.replace(worldData('maplibre'));

      const facingCamera = cameraLookingAlongZ(-50, 4); // looking toward +z, building at z=4 is ahead
      world.updateVisibleBuildings(facingCamera);

      expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThan(0);
    });

    it('drops a building from the render once the camera turns away from it', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.setAnchor(6, 4);
      world.replace(worldData('maplibre'));
      // Confirm it starts visible from a facing camera...
      world.updateVisibleBuildings(cameraLookingAlongZ(-50, 4));
      expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThan(0);

      // ...then turn the same camera around — the building (z=4) is now behind it.
      const awayCamera = cameraLookingAlongZ(-50, -100);
      world.updateVisibleBuildings(awayCamera);

      expect(scene.getObjectByName('world:roofs')?.children.length ?? 0).toBe(0);
    });

    it('does not rebuild the buildings layer when the visible set has not changed', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      world.setAnchor(6, 4);
      world.replace(worldData('maplibre'));

      const camera = cameraLookingAlongZ(-50, 4);
      world.updateVisibleBuildings(camera);
      const roofsAfterFirst = scene.getObjectByName('world:roofs');
      expect(roofsAfterFirst).toBeDefined();

      world.updateVisibleBuildings(camera);
      const roofsAfterSecond = scene.getObjectByName('world:roofs');
      // Same object instance — proof the buildings/roofs layer was not torn down and
      // rebuilt a second time for an unchanged visible set.
      expect(roofsAfterSecond).toBe(roofsAfterFirst);
    });

    it('never frustum-culls water/roads/parks — they stay distance-only, even when the camera faces away from everything', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      const data = worldData('maplibre');
      data.roads.push({ id: 'road', kind: 'residential', width: 8, points: [{ x: 6, z: 4 }, { x: 16, z: 4 }] });
      data.water.push({ id: 'water', rings: [[{ x: 6, z: 4 }, { x: 10, z: 4 }, { x: 10, z: 8 }]] });
      data.parks.push({ id: 'park', kind: 'park', rings: [[{ x: 6, z: 4 }, { x: 10, z: 4 }, { x: 10, z: 8 }]] });
      world.setAnchor(6, 4);
      world.replace(data);

      // Facing squarely away from every surface, including the roads/water/park just added.
      const awayCamera = cameraLookingAlongZ(-50, -500);
      world.updateVisibleBuildings(awayCamera);

      expect(scene.getObjectByName('world:roads')?.children.length).toBe(1);
      expect(scene.getObjectByName('world:water')?.children.length).toBeGreaterThanOrEqual(2);
      expect(scene.getObjectByName('world:parks')?.children.length).toBe(1);
    });
  });

  describe('setRenderBudgetScale', () => {
    it('pulls the effective building draw distance inward under a reduced budget', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      const distance = MAX_BUILDING_DRAW_DISTANCE - 50; // inside the full-scale cutoff...
      const data: WorldData = {
        source: 'maplibre',
        labels: [],
        objects: [],
        buildings: [{
          id: 'near-edge',
          height: 12,
          properties: {},
          rings: [[
            { x: distance, z: 0 }, { x: distance + 10, z: 0 },
            { x: distance + 10, z: 8 }, { x: distance, z: 8 },
          ]],
        }],
        roads: [], water: [], parks: [],
      };
      world.replace(data);
      expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThan(0);

      // ...but well outside a halved effective distance.
      world.setRenderBudgetScale(0.5);
      world.updateVisibleBuildings(null);

      expect(scene.getObjectByName('world:roofs')?.children.length ?? 0).toBe(0);
    });

    it('restores the full draw distance when the scale returns to 1', () => {
      const scene = new THREE.Scene();
      const world = createThreeWorld(scene);
      const distance = MAX_BUILDING_DRAW_DISTANCE - 50;
      const data: WorldData = {
        source: 'maplibre',
        labels: [],
        objects: [],
        buildings: [{
          id: 'near-edge',
          height: 12,
          properties: {},
          rings: [[
            { x: distance, z: 0 }, { x: distance + 10, z: 0 },
            { x: distance + 10, z: 8 }, { x: distance, z: 8 },
          ]],
        }],
        roads: [], water: [], parks: [],
      };
      world.replace(data);
      world.setRenderBudgetScale(0.5);
      world.updateVisibleBuildings(null);
      expect(scene.getObjectByName('world:roofs')?.children.length ?? 0).toBe(0);

      world.setRenderBudgetScale(1);
      world.updateVisibleBuildings(null);
      expect(scene.getObjectByName('world:roofs')?.children.length).toBeGreaterThan(0);
    });
  });
});


describe('live facade controls', () => {
  it('updates existing materials without replacing geometry or cancelling a staged world', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    world.replace(worldData('maplibre'));
    const root = scene.getObjectByName('world:maplibre');
    let material: THREE.ShaderMaterial | undefined;
    root!.traverse(object => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial && object.material.uniforms.uWindowBrightness) material = object.material;
    });
    world.replace(worldData('maplibre'), { incremental: true });
    const generation = world.buildDiagnostics().generationId;
    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, windowBrightness: 2, windowWarmth: -0.5 });
    expect(scene.getObjectByName('world:maplibre') === root).toBe(true);
    expect(world.buildDiagnostics().generationId).toBe(generation);
    expect(world.isBuilding()).toBe(true);
    expect(material!.uniforms.uWindowBrightness.value).toBe(2);
    expect(material!.uniforms.uWindowWarmth.value).toBe(-0.5);
    while (world.pump(0)) { /* finish the staged world */ }
    expect(material!.uniforms.uWindowBrightness.value).toBe(2);
    world.dispose();
  });

  it('casts bounded nearby window light at night and turns it off with occupancy', () => {
    const scene = new THREE.Scene();
    const world = createThreeWorld(scene);
    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, windowCastLight: true, windowOccupancy: 2 });
    world.setSceneLighting(sceneLighting(0));
    world.replace(worldData('maplibre'));
    const lights = () => {
      const found: THREE.PointLight[] = [];
      scene.traverse(object => { if (object instanceof THREE.PointLight && object.name.startsWith('window-spill:')) found.push(object); });
      return found;
    };
    expect(lights().filter(light => light.intensity > 0).length).toBeGreaterThan(0);
    expect(lights().length).toBeLessThanOrEqual(4);
    expect(lights().every(light => !light.castShadow)).toBe(true);
    world.replace(worldData('maplibre'), { incremental: true });
    world.setAnchor(1000, 1000);
    world.updateVisibleBuildings(null, { incremental: true });
    expect(lights().every(light => light.intensity === 0)).toBe(true);
    world.setAnchor(0, 0);
    world.updateVisibleBuildings(null, { incremental: true });
    expect(lights().some(light => light.intensity > 0)).toBe(true);
    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, windowCastLight: true, windowOccupancy: 0 });
    expect(lights().every(light => light.intensity === 0)).toBe(true);
    world.setRenderOptions({ ...DEFAULT_RENDER_OPTIONS, windowCastLight: true, windowOccupancy: 2 });
    world.setSceneLighting(sceneLighting(12));
    expect(lights().every(light => light.intensity === 0)).toBe(true);
    world.dispose();
    expect(lights()).toHaveLength(0);
  });
});
