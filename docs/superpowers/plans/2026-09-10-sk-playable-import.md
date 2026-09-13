# SK Playable Characters and Vehicles Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. This document authorizes planning only; implementation is a separate task.

**Goal:** Import SK's car, Boxman, aeroplane, and helicopter into Svartaksi as selectable, playable entities with SK's authored geometry, animations, controls, and handling properties.

**Architecture:** Retain Svartaksi's R3F canvas, fixed-step loop, streamed city, and custom physics world. Extract SK's metadata and gameplay rules into focused modules, adapting their physics operations to Svartaksi bodies and raycast vehicles. Keep the imported entities in a registry with one active player controller and continue simulating unoccupied vehicles.

**Tech Stack:** Existing TypeScript, React, R3F, Three.js, custom physics, pnpm, and Vitest. No runtime Cannon dependency or second renderer.

**Spec:** The user's request to import `../sk`'s four entities with their properties; the scope, property inventory, and acceptance criteria below make that request concrete.

## Global Constraints

- Preserve the custom physics architecture, as required by `AGENTS.md`.
- Keep gameplay tuning in configuration and arithmetic in pure, testable modules.
- Use the existing pnpm toolchain; `package.json` currently pins `pnpm@12.3.4` (the version mentioned in `AGENTS.md` is older).
- Preserve existing Saab, bus, foot, blob, horse, story, and reset flows.
- Do not depend on files outside Svartaksi at runtime or build time after import.
- Use manual rendering/feel checks; do not add browser automation without a separate request.
- Follow existing two-space indentation, single quotes, and semicolons.
- Do not commit or publish as part of this planning request.

## Scope and Parity Contract

“Car” means `sk/public/assets/car.glb`, not the alternative Saab models. “Aeroplane” means `airplane.glb`; `small_plane.glb` is the starting map asset, not the requested aircraft. Boxman is a character that can walk, sprint, jump, enter vehicles, occupy passenger seats, switch connected seats, drive, and exit.

Add the imports alongside existing gameplay. Provide a visible **SK playground** action that places Boxman and all three vehicles together on a clear, grounded staging area, plus a return-to-existing-game action. Normal interaction must work after spawning: walking to vehicles and entering them, not just viewing models or teleporting the camera between props. The staging layout includes an unobstructed takeoff lane derived from measured takeoff distance and a helicopter landing area. It must use Svartaksi's world/physics, including collisions with its city.

Source baseline inspected:

- SK: `6baca52ab9680bf525915da25b90249f3038a06f`.
- Svartaksi: `01f2e5900badb65409de6e45658310986c0ac5e9`.

Exact asset bytes, authored dimensions, key bindings, state transitions, and source tuning are the initial contract. Identical trajectories cannot be promised across different contact solvers. Measure source trajectories first, then require comparable outcomes within declared tolerances; record any deviation rather than silently replacing SK handling with Saab handling. If the adapter cannot achieve the acceptance criteria, stop that implementation milestone and report the specific mismatch before changing the architecture.

Out of scope: importing SK's world, UI shell, AI traffic/path system, other models, or replacing Svartaksi physics globally.

## Verified Source Inventory

| Entity | Asset | Authored structure | Properties to carry over |
|---|---|---|---|
| Car | `../sk/public/assets/car.glb` (619,264 bytes) | Four wheels, four seats, connected front/rear seat pairs, doors, steering wheel, camera, box/sphere colliders | AWD; base mass 50; engine force 500 per driven wheel in SK; speed scale 22; five forward gears with thresholds 5/9/13/17/22, reverse -4; shift time 0.2 s; steering spring and drift correction; rear-wheel handbrake; airborne roll/pitch and self-righting |
| Boxman | `../sk/public/assets/boxman.glb` (757,340 bytes) | Skinned mesh and 34 clips | `moveSpeed=4`, walk target 0.8 (steady target 3.2 units/s), sprint target 1.4 (5.6 units/s); camera-relative movement; source velocity/rotation springs; idle/start/stop/turn/jump/fall/landing states; seated/entry/exit states |
| Aeroplane | `../sk/public/assets/airplane.glb` (457,620 bytes) | Three landing wheels, one driver seat with two entry points, propeller, two ailerons, two elevators, rudder, camera, compound colliders | Ground steering/braking; speed-dependent pitch/yaw/roll; source thrust, drag, lift and stabilization; engine ramp +0.4/s occupied, -0.12/s unoccupied; propeller rotation 60 × engine power rad/s |
| Helicopter | `../sk/public/assets/heli.glb` (477,304 bytes) | No wheels; two connected seats, doors, two rotor nodes, camera, compound colliders | Collective ascent/descent; pitch/yaw/roll; hover assistance, upright stabilization and damping; engine ramp +0.2/s occupied, -0.06/s unoccupied; rotor rotation 30 × engine power rad/s |

Both worlds use gravity magnitude 9.81 and 60 Hz simulation. SK vehicle forward is +Z, up +Y, right +X, matching Svartaksi's vehicle convention. Keep original asset scale; Svartaksi's Saab dimension fitting and merged-wheel splitting would corrupt these authored rigs.

Source references:

- `../sk/src/ts/vehicles/{Vehicle,Car,Airplane,Helicopter,VehicleSeat,VehicleDoor,Wheel}.ts`.
- `../sk/src/ts/characters/Character.ts`, `character_states/`, and `character_states/vehicles/`.
- `../sk/src/ts/physics/colliders/CapsuleCollider.ts`, `physics/spring_simulation/`.
- `../sk/src/ts/core/{KeyBinding,ControlSchemes,FunctionLibrary}.ts`.
- `../sk/src/ts/world/{World,WorldConstants,VehicleSpawnPoint}.ts`.
- `../sk/src/game/ui/VehicleLoader.tsx` for optional model-loader presets; the imported base car uses its constructor defaults, not an unrelated UI preset.

### Physics Translation Traps

1. SK passes each wheel an engine force; Svartaksi `RaycastVehicle.engineForce` is a total split between driven wheels. Convert sign and sum explicitly. SK negative engine force moves toward +Z. Copying `500` directly into Svartaksi's total-force API changes acceleration.
2. SK suspension constants are Cannon parameters, not interchangeable with Svartaksi's force coefficients. Preserve the source settings in the profile and derive converted settings from the actual bundled Cannon wheel equations. Car source values: radius 0.25, stiffness 20, rest length 0.35, travel 1, friction slip 0.8, relaxation/compression 2, roll influence 0.8. Plane: radius 0.12, stiffness 150, rest length 0.25, relaxation/compression 5; capture inherited defaults from the bundled Cannon implementation too.
3. SK adds 0.2 to authored wheel connection Y. Collision helper scale is box **half-extents**, or sphere radius from scale X. Preserve node hierarchy and source transforms; do not measure collision helper mesh bounds as chassis bounds.
4. Most aircraft control constants are velocity increments **per physics tick**, not forces: airplane pitch 0.04, yaw 0.02, roll 0.055; helicopter axes 0.07 and collective 0.15. Apply once per 1/60 s tick; do not multiply by `dt` again. Engine ramp and visual rotations are time-based.
5. Plane thrust modifiers are 0.02 cruise, 0.06 throttle, -0.05 brake, and zero for grounded idle; drag uses speed × 0.003 × power and lift is clamped to 0.05 from speed × 0.005 × power. Preserve ordering and `lastDrag` state.
6. Plane source writes mass `50 * (1 - clamp(forwardSpeed / 10, 0, 1) * 0.6)` without calling `updateMassProperties`. Establish the actual effect in the bundled Cannon source before deciding which derived properties change in the port. Do not silently interpret this as a physically consistent 50-to-20 kg inertia change. Svartaksi mass, inverse mass, and inertia must stay internally consistent; document the compatibility decision.
7. Helicopter hover compensation is gravity × fixedDt × 0.98 × sqrt(clamped upright dot), with -0.01 vertical-velocity damping; horizontal multiplier interpolates 1 to 0.995 with power, angular multiplier is 0.97. Avoid applying an additional default damping that changes these results.
8. Boxman's source capsule is three radius-0.25 spheres at Y offsets 0 and ±0.25, mass 1; ground ray length 0.57 and safe offset 0.03. Jump adds 4 vertical velocity after the relevant animation delay. Existing Svartaksi character collision is a horizontal sphere probe with separate vertical movement, so importing just a Boxman skin cannot reproduce these properties.
9. SK runs gameplay update and physics callbacks in distinct phases. Capture actual ordering, including wheel contact availability and engine power updates, before moving both into the target fixed loop.

## Target File Map

All paths below are relative to `svartaksi/`. New names are proposed interfaces, not existing APIs.

| Files | Responsibility |
|---|---|
| `src/models/sk/{car,boxman,airplane,heli}.glb` | Self-contained copies of original assets |
| `src/svartaksi/sk/{profiles,assetManifest,loadAsset,vehicleMetadata}.ts` | Source tuning, bundled URLs, rig cloning, metadata validation |
| `src/svartaksi/sk/{types,registry,controls}.ts` | Entity lifecycle, active control target, normalized SK actions |
| `src/svartaksi/sk/{vehicleBody,wheelAdapter,carController,airplaneController,helicopterController}.ts` | Custom-physics bindings and source handling rules |
| `src/svartaksi/sk/{boxmanModel,boxmanController,boxmanStates,seats}.ts` | Skeleton animation, locomotion, occupation, transitions |
| `src/svartaksi/sk/{playground,spawnPlacement}.ts` | Assembly and collision-aware staging layout |
| `tests/svartaksi/sk/*.test.ts`, `tests/svartaksi/sk/fixtures/*` | Metadata, state, integration and reference-trace tests |
| `tests/physics/skCompatibility.test.ts` | Physics translation and city collision regressions |
| `src/svartaksi/svartaksiRuntime.tsx` | Thin mount/tick/render/input/reset bindings |
| `src/svartaksi/playerInput.ts`, `src/App.tsx`, `src/components/TouchControls.tsx` | Input and visible selection/help integration |
| `src/svartaksi/{runtimeCamera,cameraRig,resetGame}.ts` | Active entity framing and reset integration where needed |
| `docs/architecture/sk-playable-import.md`, `README.md` | Source provenance, physics mapping, control and verification documentation |

Extend `src/physics/{world,vehicle,rigidBody}.ts` only where the compatibility tests establish a missing capability. Existing vehicles must retain their defaults. Do not add an unrestricted force-hook framework merely to host three controllers.

## Task 1: Capture the Source Contract and Vendor the Assets

**Files:** The four model copies; `assetManifest.ts`, `profiles.ts`; architecture document; `tests/svartaksi/sk/assets.test.ts`; `tests/svartaksi/sk/fixtures/source-manifest.json` and `source-traces.json`.

- [ ] Record source revisions, SHA-256 hashes, animation names/durations, node metadata, and relevant source code provenance. Inspect repository history for asset/code notices and preserve any applicable attribution; do not invent an asset license.
- [ ] Copy the four GLBs without re-exporting or compressing them. Use Vite URL imports, for example:

```ts
import carUrl from '../../models/sk/car.glb?url';
import boxmanUrl from '../../models/sk/boxman.glb?url';
import airplaneUrl from '../../models/sk/airplane.glb?url';
import heliUrl from '../../models/sk/heli.glb?url';

export const skAssetUrls = { car: carUrl, boxman: boxmanUrl, airplane: airplaneUrl, heli: heliUrl };
```

- [ ] Build a source trace fixture using SK's actual local Cannon alias and `src/test/createTestWorld.ts` where possible. Sample at 60 Hz on flat ground after settling: car 10 s throttle, reverse, braking, steering; Boxman walk/sprint/jump; airplane takeoff and each rotation axis; helicopter spin-up, neutral hover, ascend, descend and each axis. Include input tick ranges, initial pose, source settings, sampling phase, positions, velocities, engine power, gear, grounded wheel count and active animation/state. Keep the export helper in the target test tooling and source fixtures in Svartaksi; SK remains unchanged.
- [ ] Capture per-tick source equations separately from full contact trajectories so a solver mismatch can be distinguished from a wrong controller port. Resolve mass assignment and wheel-force semantics by reading `../sk/src/lib/cannon/cannon.js`.
- [ ] Test actual GLB JSON chunks from disk, not hand-written model mocks: counts must be 4/3/0 wheels and 4/1/2 seats for car/plane/heli; Boxman must expose all 34 clips and the four imported asset hashes must match the source snapshot.
- [ ] Run `pnpm test -- tests/svartaksi/sk/assets.test.ts`. Expected: asset inventory passes and source traces are reproducible from the recorded input scripts. Do not label generated or guessed numbers as measured traces.

## Task 2: Load and Validate the Authored Rigs

**Files:** `loadAsset.ts`, `vehicleMetadata.ts`, `boxmanModel.ts`; tests `metadata.test.ts`, `modelLifecycle.test.ts`.

**Interfaces:** `loadSkAsset(kind: SkKind): Promise<LoadedSkAsset>`; define `SkKind = 'car' | 'boxman' | 'airplane' | 'heli'` in `types.ts`. `LoadedSkAsset` contains `root: THREE.Group`, `animations: THREE.AnimationClip[]`, and `dispose(): void`. `readVehicleMetadata(root: THREE.Object3D): VehicleMetadata` returns typed wheel, collider, seat, camera and moving-part records with local transforms and resolved node references.

- [ ] Write failing tests for missing seat references, string-valued steering metadata, both airplane entries, half-extents, and preservation of wheel/door pivots. A seat referencing a missing `entrance_1` must fail with asset, seat and reference names, rather than becoming playable with an invalid pose.
- [ ] Use existing `gltfLoaders.ts`. Clone skinned characters with `SkeletonUtils.clone` from the installed Three.js examples module, give each character its own mixer, and preserve clip names. Clone materials only where mutable per-instance state needs independence; define ownership so disposing one clone cannot destroy another.
- [ ] Parse `userData.data`, `drive`, `steering === 'true'`, `seat_type`, `entry_points`, `connected_seats`, and `door_object`. Resolve semicolon-separated references after collecting nodes. Hide only metadata helpers, not the seats' visible surrounding geometry.
- [ ] Keep helper dimensions and transforms faithful to SK. Test nested transforms against the source's actual body-space interpretation before introducing generalized world-transform conversion. Keep bind-pose rotations for rotors/control surfaces.
- [ ] Guard asynchronous completion after unmount/reset; dispose stale instances and expose load/error state. No enabled selection before assets and metadata are ready.
- [ ] Run `pnpm test -- tests/svartaksi/sk/metadata.test.ts tests/svartaksi/sk/modelLifecycle.test.ts`. Expected: valid rigs load, invalid rigs fail descriptively, clones animate independently, and cleanup is idempotent.

## Task 3: Establish Physics and Control Ownership

**Files:** `types.ts`, `registry.ts`, `vehicleBody.ts`, `wheelAdapter.ts`, `controls.ts`; `tests/svartaksi/sk/registry.test.ts`; `tests/physics/skCompatibility.test.ts`.

**Interfaces:** Use this lifecycle boundary; controllers own source state, the runtime owns the one world step:

```ts
export interface SkEntity {
  id: string;
  kind: SkKind;
  root: THREE.Object3D;
  body: RigidBody;
  beforePhysics(dt: number): void;
  afterPhysics(dt: number): void;
  render(alpha: number): void;
  reset(position: THREE.Vector3, quaternion: THREE.Quaternion): void;
  dispose(): void;
}

export interface SkActions {
  held: ReadonlySet<string>;
  pressed: ReadonlySet<string>;
  released: ReadonlySet<string>;
}
```

`registry.ts` exposes `add(entity)`, `remove(id)`, `get(id)`, `entities()`, `setActive(id | null)`, `active()` and `dispose()`. `controls.ts` exposes `sampleSkActions(kind, input)` using `SkControlInput` defined there as keyboard codes plus touch action names. Input edges are consumed once per fixed tick, while held state persists across catch-up ticks.

- [ ] Write regression tests proving one body registration and one simulation step per tick, continued gravity on unoccupied aircraft, no input leakage between entities, and complete cleanup on reset.
- [ ] Create compound bodies from imported colliders and SK friction/damping settings; adapt collision categories to Svartaksi buildings, props, terrain and vehicles. Use its collision world, not a disconnected Cannon island.
- [ ] Translate wheel suspension/damping, per-wheel propulsion and brake masks. If target vehicle APIs lack per-wheel braking needed for SK's rear-only handbrake, add a backward-compatible optional wheel selection instead of changing every vehicle's brake distribution.
- [ ] Drive controller operations at 60 Hz in the measured source order. If ordering cannot be expressed around `physics.step(dt)`, add a narrowly scoped optional pre-integration callback to `PhysicsWorld.step`; document its phase and test invocation count. Wheel forces must run once, not once in the adapter and again in `world.step`.
- [ ] Keep previous/current poses for interpolation. Preserve full quaternion orientation on imported bodies: `syncCarBodyFromGroup` zeros velocities and reduces rotation to yaw, so it must never be used on these aircraft.
- [ ] Run `pnpm test -- tests/svartaksi/sk/registry.test.ts tests/physics/skCompatibility.test.ts tests/physics/vehicle.test.ts tests/physics/world.test.ts`. Expected: new compatibility cases and existing physics regressions pass.

## Task 4: Make Boxman Playable on Foot

**Files:** `boxmanController.ts`, `boxmanStates.ts`, `profiles.ts`; tests `boxmanController.test.ts`, `boxmanStates.test.ts`.

**Interfaces:** `createBoxmanController(asset: LoadedSkAsset, world: PhysicsWorld): SkEntity` with an additional `setActions(actions: SkActions, cameraYaw: number): void`. State IDs and clip mapping live in `boxmanStates.ts`, copied from the source state library; other systems request semantic transitions through this controller rather than changing mixer actions directly.

- [ ] Write trace-based tests for camera-relative walking, sprint transitions, delayed idle/running jumps, fall and landing selection, no repeated jump from a held key, and source turn/start/stop animation selection.
- [ ] Port velocity and rotation spring behavior, including changes per state, using existing `springSimulator.ts` only where its math matches SK. Preserve movement influence during airborne states and source landing thresholds. Implement the source three-sphere body in the target solver with grounded ray handling, slope normal response and restrained character rotation.
- [ ] Bind all source locomotion clips, blend times and completion conditions. Drive simulation state on fixed ticks and animation rendering without duplicate movement/root-motion application.
- [ ] Test collision with a wall, low obstacle, slope, moving support, ceiling and falling off an edge. Inherit support-point velocity at jump/exit according to source behavior. Prevent the generic foot/blob vertical loop from also moving Boxman.
- [ ] Run `pnpm test -- tests/svartaksi/sk/boxmanController.test.ts tests/svartaksi/sk/boxmanStates.test.ts`. Expected: state/clip sequence agrees with SK; flat-ground target speed and jump measurements satisfy the parity gates below.

## Task 5: Port Car Handling

**Files:** `carController.ts`, `profiles.ts`, `wheelAdapter.ts`; `tests/svartaksi/sk/carController.test.ts`.

**Interfaces:** `createSkCar(asset: LoadedSkAsset, world: PhysicsWorld): SkVehicle`; `SkVehicle` extends `SkEntity` with `setActions(actions: SkActions): void` and `setDriverOccupied(occupied: boolean): void`. Define it in `types.ts`; airplane and helicopter use the same interface.

- [ ] Write failing source-trace tests for acceleration/gears, 0.2 s shifting, reverse, throttle release, rear-wheel handbrake, speed-dependent steering, and airborne controls.
- [ ] Port `Car.update`, `physicsPreStep`, and action edge effects into the new controller and adapter. Keep source AWD filtering, measured signed forward speed, steering spring, drift correction, gear thresholds, and source force persistence/release semantics.
- [ ] Preserve steering-wheel animation and four independent suspension/steer/roll wheel transforms. Preserve source air-spin timer, forward-tilt arming and low-speed self-righting; avoid importing source world/UI dependencies.
- [ ] Run `pnpm test -- tests/svartaksi/sk/carController.test.ts tests/physics/skCompatibility.test.ts`. Expected: control outputs agree with the source and measured acceleration, braking and turning meet the parity gates.

## Task 6: Port Aeroplane Flight and Landing Gear

**Files:** `airplaneController.ts`, `profiles.ts`; `tests/svartaksi/sk/airplaneController.test.ts`.

**Interfaces:** `createSkAirplane(asset: LoadedSkAsset, world: PhysicsWorld): SkVehicle`.

- [ ] Write failing tests from the source for occupied/unoccupied engine ramps, grounded steering, B wheel brake, speed-dependent control authority, thrust/drag/lift ordering, stabilization and angular damping. Include zero velocity, reverse ground travel and simultaneous opposite controls.
- [ ] Port the source flight equations with explicit local axes and one-tick increments. Carry `lastDrag`, engine power and all surface springs in controller state. Implement the Task 1 mass compatibility decision with a regression test.
- [ ] Bind propeller, opposite aileron rotations, both elevators, rudder and steering wheel assemblies with source local axes. Do not convert the plane into a boosted car or add an artificial altitude lock.
- [ ] Verify a full ground start, takeoff, climb, turn, descent, landing and wheel-braked stop using the source trace inputs; document the measured clear runway length used by spawn placement.
- [ ] Run `pnpm test -- tests/svartaksi/sk/airplaneController.test.ts tests/physics/skCompatibility.test.ts`. Expected: equations match the source fixtures and the plane takes off and lands on the shared terrain.

## Task 7: Port Helicopter Flight

**Files:** `helicopterController.ts`, `profiles.ts`; `tests/svartaksi/sk/helicopterController.test.ts`.

**Interfaces:** `createSkHelicopter(asset: LoadedSkAsset, world: PhysicsWorld): SkVehicle`.

- [ ] Write failing source tests for 5 s engine spin-up, gradual spin-down, collective, all rotational axes, tilted lift, hover compensation, damping, and unoccupied descent.
- [ ] Port `Helicopter.update` and `physicsPreStep` using the source order. Use compound body/skid collisions and zero wheels; do not attach a fictitious ground vehicle for lift or support.
- [ ] Animate both rotor nodes using their own authored local X axes, including the tail rotor. Keep engines and passive physics updating after the driver exits.
- [ ] Run `pnpm test -- tests/svartaksi/sk/helicopterController.test.ts tests/physics/skCompatibility.test.ts`. Expected: spin-up/down and free-flight deltas agree with source fixtures; takeoff, turns, descent and grounded landing work.

## Task 8: Connect Seats, Doors and Player Handoffs

**Files:** `seats.ts`, `boxmanStates.ts`, `registry.ts`; reference existing `src/svartaksi/vehicleEntry.ts`; tests `seats.test.ts`, `playableHandoff.test.ts`.

**Interfaces:** `createSeatManager(registry)` exposes `requestEntry(characterId, vehicleId, role)`, `requestExit(characterId)`, `requestSeatSwitch(characterId)`, `tick(dt)` and `reset()`. `role` is `'driver' | 'passenger'`. Define occupation records by stable character/vehicle/seat IDs, not by the broad player mode alone.

- [ ] Write failing tests for occupied-seat rejection, choosing either airplane entry, connected-seat switching, cancelled approach, driver-only control, and restoration of Boxman after exit.
- [ ] Reuse target entry easing only where compatible. Port SK state-specific clip/timing behavior for opening, entering, sitting, driving, switching, closing and exiting; airplane entry/exit differs from a car and may have no door. Source `VehicleDoor.ts` also contains motion behavior beyond a fixed angle tween; preserve that behavior for imported doors.
- [ ] Compose seated and transitioning Boxman poses through the full vehicle matrix/quaternion. Respect source seat orientation and character pose offsets; do not substitute Saab seat coordinates or yaw-only seat transforms.
- [ ] Implement source car exit braking rules and immediate aircraft exit requests. Airborne exit must inherit vehicle/support-point motion and transition to falling without grounding or freezing the aircraft. Check ground exits against obstacles and avoid spawning inside the chassis.
- [ ] On entry, suspend the character's independent body response; on exit, restore it exactly once. Driver loss must release actions and begin source engine spin-down; a passenger does not own aircraft controls.
- [ ] Run `pnpm test -- tests/svartaksi/sk/seats.test.ts tests/svartaksi/sk/playableHandoff.test.ts tests/svartaksi/vehicleEntry.test.ts`. Expected: complete enter/drive/switch/exit cycles with correct occupancy, clips and ownership.

## Task 9: Integrate Selection, Input, Camera and City Streaming

**Files:** `playground.ts`, `spawnPlacement.ts`, `controls.ts`; `svartaksiRuntime.tsx`, `playerInput.ts`, `App.tsx`, `TouchControls.tsx`, camera/reset bindings; tests `playground.test.ts`, `controls.test.ts`, `spawnPlacement.test.ts`, and existing affected UI tests.

- [ ] Add explicit SK modes to the player mode type and audit every mode switch/ternary in runtime, App, camera, water, HUD, story and reset handling. An aircraft must never fall through to the existing foot, horse, bus or parked-Saab update path. Keep the active imported vehicle ID separate from mode.
- [ ] Add a visible loading/error-aware SK playground action and return action. Spawn on terrain that is loaded and clear, with space between colliders and an inspected takeoff corridor. If the opening area cannot fit that corridor, offer a dedicated reachable staging location and load its terrain before enabling play; report the reason instead of placing aircraft inside city geometry.
- [ ] Wire normal keyboard bindings by active mode:

| Mode | Bindings |
|---|---|
| Boxman | WASD camera-relative move; Shift sprint; Space jump; F enter driver; G enter passenger; E source use action where applicable |
| Car | W throttle; S reverse; A/D steering; Space rear handbrake |
| Aeroplane | Shift throttle; Space air brake; B wheel brake; W/S pitch down/up; A/D roll; Q/E yaw |
| Helicopter | Shift ascend; Space descend; W/S pitch down/up; A/D roll; Q/E yaw |
| Imported vehicle | F exit; X connected seat switch; V authored first-person/chase toggle; Shift+R respawn; Shift+C free camera |

- [ ] Handle keyboard conflicts in both App and runtime listeners, using one active-mode dispatch result so E/B/F/V/X and Shift chords do not also invoke Svartaksi interactions. Preserve source arrow-key remapping when offered. Clear held and edge input on blur, overlay opening, reset and mode switch. Keep aircraft pitch, roll, yaw, collective/throttle and brake independent; existing `forward`/`turn` axes alone cannot represent flight.
- [ ] Extend touch controls with equivalent semantic actions for the active entity and update displayed control help. Prevent touch release from clearing a still-held keyboard action.
- [ ] Frame the active entity with its full pose and authored cockpit node. Preserve target camera collision checks and avoid following a hidden parked Saab. Freecam changes the view without claiming control of another entity.
- [ ] Feed streaming/prediction the active aircraft's horizontal position and velocity; keep terrain/building collision data loaded ahead of descent and touchdown. Test finite stream requests at altitude and speed, tile changes during flight, shadow/camera clipping, and lost network data. Do not increase streaming radius without measuring cost.
- [ ] Reset/re-entry must restore poses, wheels, input, gear, power, animation, springs and occupation; unregister old bodies and ignore late loads. Preserve existing game return state and prevent duplicate staging sets.
- [ ] Run `pnpm test -- tests/svartaksi/sk tests/components/TouchControls.test.tsx tests/svartaksi/resetGame.test.ts tests/App.test.tsx`. Expected: imports are discoverable, selectable, controllable and return cleanly to existing gameplay.

## Task 10: Validate Parity and Document the Result

**Files:** `tests/svartaksi/sk/parity.test.ts`, source fixtures, architecture document and README.

- [ ] Replay identical fixed-step source inputs in the port. Assert discrete state/gear/seat sequences and controller-only numeric results before assessing the full solver trajectories. A representative check for the helicopter ramp is:

```ts
expect(samples[300].enginePower).toBeCloseTo(1, 6);
expect(samples[300].tick).toBe(300);
```

The fixture harness records initial state at tick 0 and state after each completed tick; 300 ticks represent 5 seconds. Define fixture sample fields in the test harness rather than mixing render frame counts with physics ticks.

- [ ] Enforce proposed acceptance tolerances: controller-only deltas within 1e-6; source timed transitions within one fixed tick; steady walking/sprint speed within 5%; car acceleration time, braking distance and turn radius within 10%; airplane takeoff distance/climb rate and helicopter climb/hover drift within 10%, using an absolute 0.1 m or 0.1 m/s floor near zero. Compare normalized identical initial conditions, not a city street against SK's flat map. These are implementation gates, not claims that measurements already passed.
- [ ] Render cadence regression: replay the same input timeline at 30/60/144 Hz render cadence and verify the same completed-tick trajectory. Pausing or tab stalls must not produce unbounded catch-up.
- [ ] Manually verify in `pnpm dev`: Boxman locomotion and all entry/exit clips; car drive/reverse/handbrake; plane taxi/takeoff/turn/land; heli spin-up/hover/turn/land; passenger switching; exit from airborne aircraft; V camera; respawn; keyboard/touch; load failure; repeated reset; return to Saab/bus/blob/horse gameplay.
- [ ] Verify contact with roads, slopes, props, buildings and bridges, including fast wing/skid collisions. Svartaksi has a fast-mover sweep, but that does not by itself prove wide rotating wings cannot tunnel; add a regression for any reproduced gap and fix the minimum collision capability needed.
- [ ] Run `pnpm test:all` and `pnpm build`. Check imported asset URLs in the production build and verify it runs without the sibling SK directory. Separate any pre-existing failures from introduced regressions.
- [ ] Update README controls and the architecture document with the actual physics conversions, source provenance, trace results, measured deviations and manual verification notes. No completion claim while any of the four entities is only a visual prop or any required flow is unverified.

## Delivery Order and Main Risks

Execute Tasks 1–3 first, then Boxman and car (4–5), aircraft (6–7), occupation (8), and full runtime integration (9–10). Each task has its own test gate; source trace capture precedes handling conversion.

The largest work items are Cannon-to-custom wheel/flight parity, Boxman's complete state machine, and the existing runtime's mode-specific assumptions. Asset copying is small (2,311,528 bytes total). Avoid estimating completion from GLB load success: the project is complete only when all four entities can be played through their full interaction and movement cycles in Svartaksi.
