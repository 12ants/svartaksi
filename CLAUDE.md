# SVARTAKSI

A driving game about a black taxi, set in a real city streamed from OpenStreetMap, built
with three.js and React. Developed through the Claude Code Game Studios agent
architecture: specialised subagents own their domains, and the studio's rules and quality
gates apply to everything in `src/`.

## Technology Stack

- **Engine**: three.js (`three`), rendered through React (`@react-three/fiber`)
- **Language**: TypeScript, strict, no emit — `tsc` is a checker, Vite is the compiler
- **World data**: OpenStreetMap vector tiles via MapLibre, cached under `vendor/worldcache`
- **Physics**: this project's own — `src/physics/` (rigid bodies, a raycast vehicle, a
  character controller). There is no third-party physics engine and none is wanted
- **Build**: Vite; **package manager**: pnpm (enforced by `only-allow`)
- **Tests**: Vitest in jsdom. There is deliberately **no browser/e2e layer** — see below
- **Deploy**: Cloudflare Pages (`pnpm deploy`)

## Project Structure

- `src/svartaksi/` — the game: runtime frame loop, vehicles, characters, story, config
- `src/world/` — turning OSM data into geometry: terrain, roads, facades, props, streaming
- `src/physics/` — the solver, colliders, the raycast vehicle, the character controller
- `src/components/`, `src/hooks/` — the React HUD and overlays around the canvas
- `src/author/` — the in-browser authoring tools (world editor, story editor, models)
- `src/models/` — GLB assets compiled in by Vite (`bus1.glb`, `saab90.glb`, characters)
- `tests/` — mirrors `src/`; every pure module is expected to have one
- `design/`, `docs/`, `production/` — the studio's design registry, ADRs and session state

## Architecture

Two apps share one `src/`, split at the Vite entry points (`vite.config.ts`'s
`rollupOptions.input`): `index.html` → `src/main.tsx` → `App.tsx` is the shipped game;
`author/index.html` → `src/author/main.tsx` → `AuthorApp.tsx` is the in-browser author
tool (model/story/procedural-world editors) that is never bundled into it. Both alias
`@` to `src/`.

`App.tsx` itself is presentation-only — HUD state, overlays, persisted settings — and
owns no rendering. All Three.js and gameplay logic lives behind one imperative factory,
`createSvartaksiRuntime` (`src/svartaksi/svartaksiRuntime.tsx`, ~4.2k lines): it mounts
its own React-three-fiber root into the host `<div>` App.tsx hands it and runs the whole
sim from a single `useFrame` loop, exposing only setters (`setCameraMode`,
`setRenderOptions`, `teleportTo`, …) and callbacks (`onStatus`, `onMode`, `onSpeed`, …)
across the boundary — App.tsx never reaches into scene internals.

**World data flow** (OSM → pixels), each stage its own module:
1. `world/providers/maplibreProvider.ts` streams OSM vector tiles; decoding happens off
   the main thread in `vectorTileDecode.worker.ts`.
2. Tiles are normalized into one local-coordinate `WorldData` model (`world/geo.ts`,
   `world/normalize.ts`, `world/types.ts`) — everything downstream works in local metres,
   not lng/lat.
3. `world/threeWorld.ts` turns `WorldData` into the renderable scene, delegating to
   per-feature modules (`terrain.ts`, `facadeRenderer.ts`/`buildingFacade.ts`,
   `roadRibbon.ts`, `propRegistry.ts`, `streetLights.ts`, `vegetation.ts`, …).
4. The same `WorldData` also drives static physics colliders in parallel
   (`buildingColliders.ts`, `bridgeColliders.ts` → `physics/buildingLayer.ts`,
   `physics/bridgeLayer.ts`) — geometry and collision are derived from one source, not
   kept in sync by hand.
5. `buildScheduler.ts` + `streamPrediction.ts` + `worldDataCache.ts` re-stream data as
   the player moves and cache what's fetched; `vendor/worldcache` is a committed snapshot
   of the opening area so first load works offline (regenerate via
   `pnpm prefetch:world`).

**Physics** (`src/physics/`) is a self-contained rigid-body/raycast-vehicle/character-
controller stack driven every frame by `svartaksiRuntime.tsx` alongside rendering: the
car's raycast vehicle (`svartaksi/carPhysics.ts` → `physics/vehicle.ts`), the walking/blob
character controller (`physics/characterController.ts`), and the static colliders from
step 4 above.

**Vehicles** are authored GLB assets (`src/models/saab90.glb`, `bus1.glb`) fitted at load
to whatever dimensions the physics and routing already agree on — `svartaksi/glbParts.ts`
splits the Saab's axle meshes back into four independently-turning wheels. Getting in and
out is a procedural sequence ported from Sketchbook (`svartaksi/vehicleEntry.ts`, `alightPath.ts`),
computed entirely in the car's own reference frame so a rolling car carries the character
with it.

**Story** is a small persistent flag store (`story/storyRuntime.ts`) plus a declarative
trigger/quest engine (`story/storyEngine.ts`) stepped once a second against authored
story projects (`story/projects/*.json`, shape enforced by `story/validateStoryProject.ts`)
— this is what drives the in-game phone's inbox and notes screen.

## Testing Policy

Unit tests only, run with `pnpm test`. Anything that needs a WebGL context is not tested
here — which is why the game's arithmetic lives in pure modules (`busGeometry.ts`,
`vehicleEntry.ts`, `glbParts.ts`, `alightPath.ts`, `cameraRig.ts`) that a test can call
without a canvas. When adding a system, put the part that can be wrong in a pure module
and test that; the scene-graph binding around it is deliberately thin.

Browser automation was dropped from this project on purpose. Do not add Playwright,
Puppeteer or a screenshot harness without being asked for one.

## Commands

```
pnpm dev         # vite dev server on :7777
pnpm test        # vitest, jsdom
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm test:all    # lint + typecheck + test — run this before saying something works
pnpm build       # production build
pnpm exec vitest run tests/world/geo.test.ts   # a single test file
pnpm prefetch:world   # regenerate the vendor/worldcache offline snapshot
```

## Coding Standards

@.claude/docs/coding-standards.md

Beyond those, this codebase has a house style worth matching:

- **Every constant carries its unit and its reason.** `SPRING_RATE` is derived from the
  car's mass and how far it should sit on its springs, not tuned by eye. If you cannot
  say where a number came from, that is the comment to write.
- **Comments explain the decision, not the syntax.** Prefer one paragraph on why a thing
  is the way it is over five lines restating what the code does.
- **Pure first.** New arithmetic goes in a module with no `THREE.Scene`, no DOM and no
  refs, and gets a test. The runtime binds it.

## Coordination Rules

@.claude/docs/coordination-rules.md

## Collaboration Protocol

**User-driven collaboration, not autonomous execution.**
Every task follows: **Question -> Options -> Decision -> Draft -> Approval**

See `docs/COLLABORATIVE-DESIGN-PRINCIPLE.md` for the full protocol.

## Context Management

@.claude/docs/context-management.md
