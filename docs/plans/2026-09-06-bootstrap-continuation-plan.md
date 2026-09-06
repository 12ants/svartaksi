# Bootstrap Continuation Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` if available to implement this plan task by task. Steps use checkboxes for tracking. Claude is the intended implementer.

**Goal:** Restore visible bus wheel motion, establish resource ownership, and make a bounded runtime extraction possible.

**Architecture:** Keep the procedural bus as the gameplay authority. Prepare authored geometry in final bus coordinates, attach wheel visuals to separate steer/roll groups, and synchronize them from the existing bus setters. Separate visual pivots from physics axle locations.

**Tech Stack:** TypeScript, Three.js, React Three Fiber, Vitest/jsdom, pnpm.

**Spec:** [Claude handoff](2026-09-06-claude-handoff.md#design-requirements).

## Global constraints

Preserve `BUS_DIMENSIONS`, physics, routing, interiors, lamp behavior, fallback, stable seeds,
and frame update order. No browser automation, new physics engine, or unrelated rewrite.
No asset pivot numbers have been measured in this planning session: derive and record them
before implementing wheel extraction. Never silently guess wheel centers from body bounds.

## Task 1: Establish a wheel extraction contract

**Files:** inspect `src/models/bus1.glb`, `src/svartaksi/glbParts.ts`, `busShell.ts`,
`busModel.ts`, `busGeometry.ts`; create `src/svartaksi/busShellWheels.ts`,
`tests/svartaksi/busShellWheels.test.ts`, and `docs/plans/2026-09-06-bus-wheel-asset-notes.md`.

**Approaches:** Prefer an authored re-export with named wheel nodes if the source asset
is available. With only the committed material-batched GLB, use connected triangle
components and measured wheel regions. Do not apply the Saab's axis-gap split to the
entire bus: body trim shares material and spatial ranges with wheels.

- [x] Inspect the GLB's mesh transforms, indexed triangles, materials, and component bounds with an offline script. Record asset checksum, coordinate convention, component IDs, physical wheel count, hub centers, and left/right/front/rear assignments in the asset notes.
  **Result 2026-09-06:** `scripts/inspect-bus-glb.mjs` (committed, deterministic). Four wheels, 8 components / 1,772 triangles each, hub centres and sidedness recorded in [the asset notes](2026-09-06-bus-wheel-asset-notes.md).
- [ ] **Manual authoring-tool inspection UNVERIFIED — headless worktree.** Inspect those assignments manually in the existing model authoring tools. Require all tyre/rim parts and no body/trim triangles in a wheel. If ambiguous, stop the geometry change and request a named-wheel re-export; retain the procedural fallback.
  **Ruling 2026-09-06: not ambiguous, proceed.** The all-tyre/rim-and-no-body requirement is checked exhaustively by the script over every component of every mesh (the "straddles" report is empty) rather than sampled by eye, and the runtime extraction throws rather than installing a partial shell. What the missing eyeball check does *not* cover is listed under "Manual inspection: UNVERIFIED" in the asset notes.
- [x] Define the CPU-only grouping interface below.
  **Result 2026-09-06:** `src/svartaksi/busShellWheels.ts`, interface as specified. `BUS_SHELL_WHEEL_HUBS` carries the measured hubs and the six-entry `suspensionIndex` mapping (rear wheels take their dual pair's outer entry). `restCenter` is in final bus coordinates after baking source transforms and `busShellScale()`. `suspensionIndex` uses the existing six-entry order documented by `setBusWheelTravel`; distinct visual groups may share a travel source when the asset has a different tyre count.

```ts
export interface BusShellWheel {
  steer: THREE.Group;
  roll: THREE.Group;
  restCenter: THREE.Vector3;
  front: boolean;
  side: 1 | -1;
  suspensionIndex: number;
}
export interface BusShellWheelState {
  leftSteer: number;
  rightSteer: number;
  rollRadians: number;
  travel: readonly number[];
}
export function updateBusShellWheels(
  wheels: readonly BusShellWheel[], state: BusShellWheelState,
): void;
```

- [x] Write fixtures containing two wheel components plus nearby body trim, with shared material and transformed parents. Assert every triangle belongs to exactly one output, normals/UVs survive, reconstructed neutral positions match the input, and body triangles stay stationary.
  **Result 2026-09-06:** `tests/svartaksi/busShellWheels.test.ts`. The fixture parents carry the asset's own −90° X turn and millimetre offset, and the tyre mesh's buffer also carries the arch.
- [x] Run `pnpm test -- tests/svartaksi/busShellWheels.test.ts`, confirm failure for the missing extraction behavior, then implement extraction according to the measured assignments. Bake nonuniform scale before adding rotation groups to avoid wheel distortion during steering.
  **Result 2026-09-06:** observed failing first (`Failed to resolve import "@/svartaksi/busShellWheels"`), then 17/17 passing. The scale is baked into the wheel vertices and the shell's own group carries no transform, so the steer and roll groups rotate in unscaled bus space.
- [x] Reject unexpected asset topology with a descriptive load error; the existing `loadBusShell().catch(...)` keeps the full procedural bus. Test that an unmatched component cannot produce a partially installed shell.
  **Result 2026-09-06:** classification completes and is validated before anything is mutated. Two throw paths — a component straddling a cylinder, and a hub with no geometry — each covered by a test that also asserts the source geometry and the scene are untouched.

## Task 2: Connect authored wheels to existing animation

**Files:** modify `src/svartaksi/busShell.ts`, `src/svartaksi/busModel.ts`,
`src/svartaksi/busShellWheels.ts`; extend `tests/svartaksi/busShell.test.ts`,
`tests/svartaksi/busShellWheels.test.ts`, and `tests/svartaksi/busModel.test.ts`.

**Interfaces:** `BusShell` gains wheel metadata; `applyBusShell` retains a reference to it.
Keep group-only test shells compatible with an optional wheel list. Existing setters remain
public and keep updating procedural groups so fallback remains usable.

- [x] Test steering, absolute roll, and suspension without a renderer. Use a synthetic wheel at `(1, 0.5, 2)` and assert the center does not orbit when rotated.

```ts
updateBusShellWheels([wheel], {
  leftSteer: 0.2, rightSteer: 0.15, rollRadians: 0.7,
  travel: [0, 0, 0, 0, 0.1, 0],
});
expect(wheel.steer.position.y).toBeCloseTo(wheel.restCenter.y + 0.1);
expect(wheel.roll.rotation.x).toBeCloseTo(0.7);
// Fixture: front left, side +1, suspensionIndex 4.
expect(wheel.steer.rotation.y).toBeCloseTo(0.2);
```

- [x] Compute steer angles once in `setBusSteer`; apply the existing left/right results to shell wheels. Forward absolute roll from `setBusWheelRoll` and per-index displacement from `setBusWheelTravel`, always relative to `restCenter` rather than accumulating displacement.
  **Result 2026-09-06:** one Ackermann split per frame, shared by both sets of wheels. The state is kept per model whether or not a shell has arrived, so `applyBusShell` replays it and a shell that lands mid-ride does not snap its wheels straight for a frame.
- [x] Keep shell geometry out of the procedural groups hidden by `isBusShellPart`. Remove the original wheel triangles from the static shell; verify no duplicate wheels, no body holes, and no hidden animated children.
  **Result 2026-09-06:** the wheel triangles are removed by rewriting the source index, so no body vertex moves and the remaining triangles are byte-identical to what the loader produced. Tested: every authored wheel is visible up its whole ancestor chain, every procedural wheel group is hidden somewhere up its own, and triangles extracted plus triangles kept equal the input.
- [x] Run `pnpm test -- tests/svartaksi/busShellWheels.test.ts tests/svartaksi/busShell.test.ts tests/svartaksi/busModel.test.ts tests/svartaksi/busSuspension.test.ts tests/svartaksi/glbParts.test.ts`.
  **Result 2026-09-06:** 5 files, 86 tests, all passing.
- [ ] **UNVERIFIED — headless worktree, no browser.** Manually ride and inspect straight motion, both turns, bumps, braking, and a failed shell load. Confirm procedural doors, saloon, destination signs, and lights still work. Record the wheel draw-call increase separately from optimization results.
  **2026-09-06:** the draw-call increase *is* recorded and is **+7** for the shell (14 meshes without the interior, 1 emptied by the split, 8 added = 2 materials × 4 wheels → 21), measured by `scripts/inspect-bus-glb.mjs` and written up in the asset notes as a cost of the animation, not a result of optimisation. Its frame-time effect is unmeasured. Nothing about how the wheels *look* in motion has been seen by anyone.
- [x] Run `pnpm test:all` and `pnpm build`; commit as `fix: restore authored bus wheel animation` with a reference to this plan.
  **Result 2026-09-06:** lint clean, `tsc --noEmit` clean, 1,451 tests passing, `pnpm build` succeeded.

## Task 3: Make shell resource ownership explicit

**Files:** modify `src/svartaksi/busShell.ts`, inspect `src/svartaksi/busModel.ts` disposal
and runtime cleanup; extend `tests/svartaksi/busShell.test.ts`.

- [x] Mock a loader result with an interior-only geometry, a shared material, and a retained exterior mesh. Spy on each resource's `dispose`; verify detached interiors and retained resources are released once, repeated shell disposal is inert, and live shared materials are not disposed during interior removal.
  **Result 2026-09-06:** five tests in `tests/svartaksi/busShell.test.ts`, against a `createBusShell` seam that takes an already-loaded scene, so no loader, network or GPU is involved.
- [x] Collect unique geometry/material resources before removing interior meshes. Add any newly split geometries to the same owner. Keep detached resources owned until teardown, or release only those proved exclusive to discarded meshes.
  **Result 2026-09-06:** ownership is taken from the whole loaded scene before anything is detached, the split's geometries join the same set, and teardown walks the set rather than the tree. Nothing is released during interior removal.

```ts
const geometries = new Set<THREE.BufferGeometry>();
const materials = new Set<THREE.Material>();
let disposed = false;
// Populate sets from the complete loaded scene before detaching anything.
const disposeOwned = () => {
  if (disposed) return;
  disposed = true;
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
};
```

- [x] Ensure only one owner traverses/disposes the attached shell: inspect the bus model's existing cleanup and detach or exclude shell resources before that traversal. Cover both normal teardown and a load resolving after runtime disposal.
  **Result 2026-09-06:** found a real double-dispose — `disposeBus` traverses the whole bus group, which since the bootstrap has included the attached shell, so the runtime's `busModel.dispose()` followed by `busShell.dispose()` disposed every shell resource twice. `createBusModel`'s teardown now hands the shell back to its owner before sweeping. Both paths tested; the late-load path was already correct in the runtime and is now covered.
- [x] Current `bus1.glb` contains zero textures. Do not add generic texture scanning for a nonexistent problem; add explicit texture ownership if a future asset introduces them.
  **Result 2026-09-06:** no texture scanning added. Confirmed zero textures and zero images by `scripts/inspect-bus-glb.mjs`; `loadBusShell` says so and says what to do if that changes.
- [x] Run the shell/model suites, `pnpm test:all`, and `pnpm build`; commit independently as `fix: own bus shell resources through teardown`.
  **Result 2026-09-06:** shell/model/wheel suites 69 passing; lint clean, `tsc --noEmit` clean, 1,456 tests passing, `pnpm build` succeeded.

## Task 4: Optional camera-only runtime extraction

**Files:** `src/svartaksi/svartaksiRuntime.tsx`, existing `cameraRig.ts` and
`cameraSettings.ts`; create `src/svartaksi/runtimeCamera.ts` and
`tests/svartaksi/runtimeCamera.test.ts` only if this extraction is selected.

- [x] First inventory the camera block's inputs and mutable state: intro transition, mode-entry time, vehicle/on-foot rig, terrain clamp, responsiveness, and FOV.
  **Result 2026-09-07:** intro timing, cockpit handoff, mode-entry clocks, rig selection,
  terrain clamping, and responsiveness remain at their original frame-loop location. Only
  the resolved pose easing and change-only FOV application cross the new boundary.
- [x] Add characterization tests for mode switches, intro completion, terrain clearance, and repeated FOV values before moving the block. Reuse `tests/svartaksi/cameraRig.test.ts` fixtures.
  **Result 2026-09-07:** existing `cameraRig.test.ts` cases cover orbit entry, intro
  completion, and terrain/deck clearance. `runtimeCamera.test.ts` adds transform easing,
  nested two-instance isolation, non-perspective handling, and repeated-FOV coverage.
- [x] Move only the final transform application into a closure that owns scratch objects; leave mode/intro decisions at the existing frame location. Suggested boundary:

```ts
export function createCameraTransformApplier() {
  const rotation = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  return (camera: THREE.Camera, position: THREE.Vector3,
    lookAt: THREE.Vector3, blend: number): void => {
    rotation.setFromRotationMatrix(matrix.lookAt(position, lookAt, camera.up));
    camera.position.lerp(position, blend);
    camera.quaternion.slerp(rotation, blend);
  };
}
```

- [x] Create the closure once per mounted runtime, not per frame. Test two instances to exclude shared scratch-state coupling; compare transforms to the old expressions.
  **Result 2026-09-07:** `useState(createCameraTransformApplier)` constructs one closure
  per mount. Its matrix and quaternion are reused across frames, and the re-entrant
  two-instance test would fail if either scratch object moved to module scope.
- [ ] Manually check every camera mode during walking, driving, bus riding, and entry/exit. Run the camera suites, `pnpm test:all`, and `pnpm build`.
  **Automated result 2026-09-07:** 38 focused camera tests and the full 145-file,
  1,466-test suite pass; lint, typecheck, and production build pass. Manual camera-mode
  checks remain unverified.
- [x] Record this as `refactor: isolate camera transform application`. Do not describe file-size reduction as an FPS improvement. Further subsystem extraction requires its own boundary design.
