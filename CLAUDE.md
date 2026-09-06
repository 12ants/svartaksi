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

## Engine Version Reference

@docs/engine-reference/threejs/VERSION.md
