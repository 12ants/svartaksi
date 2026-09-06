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

- [ ] Inspect the GLB's mesh transforms, indexed triangles, materials, and component bounds with an offline script. Record asset checksum, coordinate convention, component IDs, physical wheel count, hub centers, and left/right/front/rear assignments in the asset notes.
- [ ] Inspect those assignments manually in the existing model authoring tools. Require all tyre/rim parts and no body/trim triangles in a wheel. If ambiguous, stop the geometry change and request a named-wheel re-export; retain the procedural fallback.
- [ ] Define the CPU-only grouping interface below. `restCenter` is in final bus coordinates after baking source transforms and `busShellScale()`. `suspensionIndex` uses the existing six-entry order documented by `setBusWheelTravel`; distinct visual groups may share a travel source when the asset has a different tyre count.

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

- [ ] Write fixtures containing two wheel components plus nearby body trim, with shared material and transformed parents. Assert every triangle belongs to exactly one output, normals/UVs survive, reconstructed neutral positions match the input, and body triangles stay stationary.
- [ ] Run `pnpm test -- tests/svartaksi/busShellWheels.test.ts`, confirm failure for the missing extraction behavior, then implement extraction according to the measured assignments. Bake nonuniform scale before adding rotation groups to avoid wheel distortion during steering.
- [ ] Reject unexpected asset topology with a descriptive load error; the existing `loadBusShell().catch(...)` keeps the full procedural bus. Test that an unmatched component cannot produce a partially installed shell.

## Task 2: Connect authored wheels to existing animation

**Files:** modify `src/svartaksi/busShell.ts`, `src/svartaksi/busModel.ts`,
`src/svartaksi/busShellWheels.ts`; extend `tests/svartaksi/busShell.test.ts`,
`tests/svartaksi/busShellWheels.test.ts`, and `tests/svartaksi/busModel.test.ts`.

**Interfaces:** `BusShell` gains wheel metadata; `applyBusShell` retains a reference to it.
Keep group-only test shells compatible with an optional wheel list. Existing setters remain
public and keep updating procedural groups so fallback remains usable.

- [ ] Test steering, absolute roll, and suspension without a renderer. Use a synthetic wheel at `(1, 0.5, 2)` and assert the center does not orbit when rotated.

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

- [ ] Compute steer angles once in `setBusSteer`; apply the existing left/right results to shell wheels. Forward absolute roll from `setBusWheelRoll` and per-index displacement from `setBusWheelTravel`, always relative to `restCenter` rather than accumulating displacement.
- [ ] Keep shell geometry out of the procedural groups hidden by `isBusShellPart`. Remove the original wheel triangles from the static shell; verify no duplicate wheels, no body holes, and no hidden animated children.
- [ ] Run `pnpm test -- tests/svartaksi/busShellWheels.test.ts tests/svartaksi/busShell.test.ts tests/svartaksi/busModel.test.ts tests/svartaksi/busSuspension.test.ts tests/svartaksi/glbParts.test.ts`.
- [ ] Manually ride and inspect straight motion, both turns, bumps, braking, and a failed shell load. Confirm procedural doors, saloon, destination signs, and lights still work. Record the wheel draw-call increase separately from optimization results.
- [ ] Run `pnpm test:all` and `pnpm build`; commit as `fix: restore authored bus wheel animation` with a reference to this plan.

## Task 3: Make shell resource ownership explicit

**Files:** modify `src/svartaksi/busShell.ts`, inspect `src/svartaksi/busModel.ts` disposal
and runtime cleanup; extend `tests/svartaksi/busShell.test.ts`.

- [ ] Mock a loader result with an interior-only geometry, a shared material, and a retained exterior mesh. Spy on each resource's `dispose`; verify detached interiors and retained resources are released once, repeated shell disposal is inert, and live shared materials are not disposed during interior removal.
- [ ] Collect unique geometry/material resources before removing interior meshes. Add any newly split geometries to the same owner. Keep detached resources owned until teardown, or release only those proved exclusive to discarded meshes.

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

- [ ] Ensure only one owner traverses/disposes the attached shell: inspect the bus model's existing cleanup and detach or exclude shell resources before that traversal. Cover both normal teardown and a load resolving after runtime disposal.
- [ ] Current `bus1.glb` contains zero textures. Do not add generic texture scanning for a nonexistent problem; add explicit texture ownership if a future asset introduces them.
- [ ] Run the shell/model suites, `pnpm test:all`, and `pnpm build`; commit independently as `fix: own bus shell resources through teardown`.

## Task 4: Optional camera-only runtime extraction

**Files:** `src/svartaksi/svartaksiRuntime.tsx`, existing `cameraRig.ts` and
`cameraSettings.ts`; create `src/svartaksi/runtimeCamera.ts` and
`tests/svartaksi/runtimeCamera.test.ts` only if this extraction is selected.

- [ ] First inventory the camera block's inputs and mutable state: intro transition, mode-entry time, vehicle/on-foot rig, terrain clamp, responsiveness, and FOV.
- [ ] Add characterization tests for mode switches, intro completion, terrain clearance, and repeated FOV values before moving the block. Reuse `tests/svartaksi/cameraRig.test.ts` fixtures.
- [ ] Move only the final transform application into a closure that owns scratch objects; leave mode/intro decisions at the existing frame location. Suggested boundary:

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

- [ ] Create the closure once per mounted runtime, not per frame. Test two instances to exclude shared scratch-state coupling; compare transforms to the old expressions.
- [ ] Manually check every camera mode during walking, driving, bus riding, and entry/exit. Run the camera suites, `pnpm test:all`, and `pnpm build`.
- [ ] Record this as `refactor: isolate camera transform application`. Do not describe file-size reduction as an FPS improvement. Further subsystem extraction requires its own boundary design.
