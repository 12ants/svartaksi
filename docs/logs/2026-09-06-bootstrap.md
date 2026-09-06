# Bootstrap: svartaksi from nacka + Sketchbook

Date: 2026-09-06

What this session built, and the decisions inside it that a later session should not have
to re-derive from the diff.

## Where the code came from

- **`nacka`** — everything structural: the Vite/React/TypeScript setup, the OSM-to-geometry
  world pipeline (`src/world/`), the physics solver and raycast vehicle (`src/physics/`),
  the HUD, the story engine, the authoring tools. Copied wholesale and renamed
  `nacka` -> `svartaksi` throughout.
- **[Sketchbook](https://github.com/swift502/Sketchbook)** — the vehicle entry/exit
  character states, ported to this project's idiom as pure modules (`vehicleEntry.ts`,
  `springSimulator.ts`) rather than lifted as classes.
- **`game-studio` (Claude Code Game Studios)** — the studio scaffold: `.claude/`
  (agents, skills, hooks, rules), `docs/`, `design/`, `production/`.

## Deliberately not carried over

- **nacka's `docs/`.** Its backlog, progress log, guides and performance notes are that
  project's history, not this one's. Two items from its TODO were acted on here and are
  recorded below; the rest was left behind on purpose.
- **Browser testing.** No Playwright, no e2e specs, no screenshot scripts, no
  `@browserbasehq/stagehand`. `tests/svartaksi/leanTestSuite.test.ts`, which existed only
  to assert the shape of the e2e scripts, went with them. See `CLAUDE.md`.
- **`vendor/three-editor-r185`** (25MB). The author's model editor loads it from
  `BASE_URL` at runtime, so the panel is an empty iframe until someone runs
  `scripts/vendor-three-editor.sh`. Kept as a fetch, not a commit.
- **The Godot, Unity and Unreal specialist agents** and `docs/engine-reference/`. This
  game's engine is three.js from npm; 15 agents for three engines it does not use are
  noise, and a vendored API snapshot for an engine it does not use is worse than none.

## The rename that changed the city

`areaId: 'nacka-world'` in `facadeRecords.ts` is not a place name — it is hashed with each
building's id to pick that building's facade variant. Renaming it to `'svartaksi-world'`
repainted every building, and because facades batch by profile, it also split batches that
used to merge: two of `facadeRenderer`'s tests failed on `batches: 1` becoming `batches: 2`,
which is a draw call that did not need to exist. The seed is now frozen with a comment
saying why. **Any string that feeds a hash is a seed; renaming it is a gameplay change.**

## Vehicles

Both assets are exported one mesh per material, so neither has a wheel, a door or a lamp
as a separable object. `glbParts.ts` is the answer to that: cluster a geometry's triangles
along an axis by the gap between them, and re-emit each cluster about its own pivot.

- **`saab90.glb` is the player's car.** Authored Z-up and origin-centred; the correction is
  baked into the vertices at load (`orientToCarSpace`), its two axle meshes are split into
  four turning wheels, and its five body panels merge into one draw call. The physics car
  is rebuilt to the asset's own measured dimensions — 4.92m long, 2.66m wheelbase, 0.355m
  wheels — so what you collide with is the shape you can see. A procedural stand-in built
  to the same numbers covers the load, and is swapped out in place so the physics vehicle's
  references to the wheel hubs stay valid.
- **`bus1.glb` replaces the procedural bus's skin only.** The saloon, doors, cab, signs and
  destination display stay procedural, because the player walks around inside them and the
  asset's baked interior does not agree with the aisle and seat colliders. It is fitted
  per-axis to `BUS_DIMENSIONS` rather than the sheet being re-derived from it — the sheet
  is what the route profiler and the turning circle were built against.
  - **Known regression:** the bus's wheels no longer turn or roll. The asset's rims and
    tyres are spread across meshes shared with every other white and black part of the
    body, so they cannot be split out the way the Saab's axles could, and the procedural
    wheels that do animate sit at the sheet's axle positions rather than the asset's
    arches. `setBusSteer`/`setBusWheelRoll` still drive the hidden groups, so this is a
    matter of splitting the asset, not of rebuilding the runtime.

## Getting in and out

`vehicleEntry.ts` is the port of Sketchbook's `OpenVehicleDoor` -> `EnteringVehicle` ->
`Sitting`, and `ExitingVehicle` -> `CloseVehicleDoorOutside`. Two properties are the point
of it:

- **It is computed in the car's own frame.** A car that rolls or turns mid-sequence carries
  the half-seated body with it. Sketchbook gets this by re-parenting the character to the
  vehicle; here the runtime converts once per frame with the car's current pose.
- **It can be abandoned.** Asking to move while the door is still opening steps away
  instead. Once the body is folding into the seat it is too late, which is also the source's
  rule.

Pressing E near the car starts it; `inputPaused` suppresses steering for the duration, and
the frame loop reads past that pause for the one input the sequence still answers.

## Two things fixed from nacka's own backlog

- **`onSpeech` was accepted by `createRuntime` and never forwarded**, so
  `callbacks.onSpeech(line)` was a call on `undefined` — a crash the first time anyone at
  the camp spoke. Found by adding a `typecheck` script, which nacka did not have; four
  other latent type errors came with it.
- **The four placement stages that ran whole between two of the world builder's yields** —
  trees, street lamps, traffic signals, neon signs — now yield inside themselves. nacka's
  TODO left this open pending an answer to "does the spacing/dedupe logic need to see the
  whole input array first?" It does not: lamps and trees carry nothing across their outer
  loop, the signal scan only ever adds into a map, and the neon walk's `taken` set is built
  in an order fixed by an explicit sort rather than by where the frame ended. Each stage now
  has a `*Job` generator that yields every 256 items (16 for tree areas, which are whole
  polygons), and an eager form that drains it — so a sliced build and an eager one cannot
  disagree. `tests/world/incrementalPlacement.test.ts` holds both properties: identical
  output, and more than one yield.

## Still open

- The bus's wheels (above).
- No hardware performance baseline. Every frame-time figure nacka ever recorded was
  SwiftShader; the slice-overrun fix above is justified by counts and by the structure of
  the loops, not by a measured frame time on a real GPU.
- `svartaksiRuntime.tsx` is still ~4100 lines and still mixes the bus autopilot, on-foot
  movement, car physics, camera rigs and the streaming state machine in one frame loop.
