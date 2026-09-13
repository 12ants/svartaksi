# Analysis: state of the game, and what to improve next

Date: 2026-09-13

Status: analysis + one proposed implementation slice. Findings are verified against the
tree at `cfe4666`; the slice itself needs its own acceptance notes.

## Method

Read-only pass over `src/` (187 files, ~36k lines), the dated plans in `docs/plans/`, the
performance notes, and one full `pnpm test:all` run. No behavioural claims here come from
playing the game — this project has no browser-automation layer by design, so everything
below is either static reading or unit-test evidence.

## Baseline health: green

`pnpm test:all` passes end to end — ESLint clean, `tsc --noEmit` clean, 148 test files /
1550 tests passing in 383s. There is no failing gate to fix and no lint debt to pay down.
That matters for what follows: the useful work here is *additive feel work*, not repair.

The codebase is in better shape than its own session-start hook suggests. The hook warns
about "0 design docs" and "no production planning", but that is a path assumption — the
studio scaffolding looks for `design/gdd/` and a populated `production/`, while this
project actually documents itself in `docs/plans/`, `docs/architecture/` and unusually
thorough module headers. The gap is filing, not knowledge.

## Findings, in priority order

### 1. The game-feel roadmap's first bullet is already done (stale doc)

`docs/plans/2026-09-06-game-feel-variation-roadmap.md`'s P1 slice opens with "ease steering
sensitivity with speed while preserving direct low-speed manoeuvring". That exists:
`applyCarControls` (`src/svartaksi/carPhysics.ts:145`) computes

```
steerLimit = CAR_MAX_STEER * (0.34 + 0.66 / (1 + absSpeed / 15))
```

and the file header documents it as the one deliberate departure from realism. Anyone
picking that roadmap up cold would re-implement it. The roadmap should be marked.

### 2. Camera look-ahead into turns is the real un-done half of that slice — **recommended**

The same P1 bullet asks for "a small configurable camera look-ahead into turns ... with
reduced-motion disabling". Nothing in `cameraRig.ts` reads steering or yaw rate: every
follow mode is a pure function of body position and instantaneous heading, so the shot
points exactly where the car points and never into the corner it is entering.

This is the highest-value slice available for its size:

- it is pure geometry, and `cameraRig.ts` is already a pure module with a test file, which
  is exactly what this project's "pure first, the runtime binds it" rule asks for;
- the existing `CameraSettings` dial architecture (`cameraSettings.ts` +
  `CAMERA_SETTING_BOUNDS` + the HUD sliders in `App.tsx`) already has a slot shape for one
  more configurable value, so "configurable" and "reduced-motion disabling" are the same
  one control rather than a new accessibility subsystem;
- it changes how the game reads at every speed in every follow mode, for well under a
  hundred lines.

### 3. Input buffering for discrete actions — not implemented, deferred

The roadmap also asks for input buffering on enter/exit, phone, doors and camera mode.
`playerInput.ts` is a pure axis merger with no time dimension at all, so a press that lands
during a vehicle-entry sequence is simply dropped. Worth doing, but it touches the entry
state machine in `svartaksiRuntime.tsx` rather than a pure module, so it is a larger and
riskier slice than #2. Deferred deliberately, not overlooked.

### 4. `docs/TODO.md` is referenced by three code comments and has never existed

`src/svartaksi/horseBody.ts:7`, `src/svartaksi/svartaksiRuntime.tsx:3542` and
`src/world/terrain.ts:457` each cite `docs/TODO.md` for a known limitation (the horse's
kinematic body, the freecam look-rate discrepancy, water polygons not cut over their bank).
`git log --all -- docs/TODO.md` returns nothing: the file was never committed, so three
real caveats point at a document a reader cannot open. Either the file should be restored
from whatever it was, or each comment should carry its own caveat inline. A report line,
not a work item — the comments are still individually informative.

### 5. Test-suite wall time is friction, but it is not a game improvement

383s for 1550 unit tests, of which 692s is cumulative jsdom *environment* setup across
workers — the environment costs roughly twice what the assertions do. Most of these suites
test pure arithmetic and need no DOM. Moving the pure suites to the `node` environment
would cut the loop substantially. Listed for completeness and explicitly not proposed:
the ask was to improve the game.

### 6. `svartaksiRuntime.tsx` is 4210 lines

Known, and load-bearing rather than accidental — it is the single `useFrame` loop the whole
architecture is organised around, and the project has been steadily extracting pure modules
out of it (`cameraRig`, `alightPath`, `glbParts`, `busGeometry`, `runtimeCamera`). The
extraction habit is the right one and is already working. No action proposed; the roadmap's
own note that camera extraction stays "maintainability work unless allocations show it
matters" is the correct call.

## Proposed slice: camera look-ahead into turns

See the ADR filed alongside this document for the design and its rationale.
