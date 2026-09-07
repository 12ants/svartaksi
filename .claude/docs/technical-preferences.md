# Technical Preferences

<!-- Populated by /setup-engine. Updated as the user makes decisions throughout development. -->
<!-- All agents reference this file for project-specific standards and conventions. -->

## Engine & Language

- **Engine**: three.js `0.185.1`, via React Three Fiber `9.7.0` (React binding, not a game engine in the Godot/Unity/Unreal sense)
- **Language**: TypeScript `6.0.3`, strict, no emit — `tsc` is a checker, Vite is the compiler
- **Rendering**: three.js WebGL renderer through `@react-three/fiber`; world geometry generated from OpenStreetMap vector tiles (MapLibre), cached under `vendor/worldcache`
- **Physics**: project's own solver in `src/physics/` — rigid bodies, raycast vehicle, character controller. No third-party physics engine.
- **Build**: Vite `8.2.1`; package manager pnpm (enforced by `only-allow`)
- **Tests**: Vitest `4.1.10`, jsdom — unit tests only, no browser/e2e layer by design

## Input & Platform

<!-- Written by /setup-engine. Read by /ux-design, /ux-review, /test-setup, /team-ui, and /dev-story -->
<!-- to scope interaction specs, test helpers, and implementation to the correct input methods. -->

- **Target Platforms**: Web / Browser (desktop and mobile), deployed to Cloudflare Pages
- **Input Methods**: Keyboard/Mouse, Touch, Gamepad (partial)
- **Primary Input**: Keyboard/Mouse
- **Gamepad Support**: Partial
- **Touch Support**: Partial — on-screen driving controls not yet built; add when a mobile-first pass is scheduled
- **Platform Notes**: No hover-only interactions if touch parity is pursued further; WebGL context loss/restore should be handled gracefully on mobile browsers

## Naming Conventions

<!-- Derived from actual house style observed in src/physics/ and src/world/ — factory functions + interfaces, not classes -->

- **Classes**: Avoided in favor of factory functions returning interfaces (e.g., `createBroadphase(): Broadphase`) — see `src/physics/broadphase.ts`
- **Variables/functions**: camelCase (e.g., `resolveCharacterMovement`, `moveSpeed`)
- **Types/Interfaces**: PascalCase (e.g., `BodyPair`, `CharacterMoveResult`)
- **Files**: camelCase matching primary export (e.g., `bridgeColliders.ts`, `characterController.ts`)
- **Constants**: UPPER_SNAKE_CASE, each one documented with its unit and derivation (per CLAUDE.md house style)

## Performance Budgets

- **Target Framerate**: 60 fps
- **Frame Budget**: 16.6 ms
- **Draw Calls**: Keep under ~1500 per frame as a browser-WebGL guideline; revisit once instancing/batching for streamed world geometry is measured
- **Memory Ceiling**: [TO BE CONFIGURED — depends on world-streaming radius, set once profiled]

## Testing

- **Framework**: Vitest (jsdom)
- **Minimum Coverage**: Every pure module under `src/physics/`, `src/world/` arithmetic, and gameplay formulas must have a test (per CLAUDE.md Testing Policy)
- **Required Tests**: Pure-module unit tests for anything that can be wrong numerically. No WebGL/browser tests — deliberately out of scope.

## Forbidden Patterns

<!-- Add patterns that should never appear in this project's codebase -->
- Third-party physics engines (Rapier, Cannon-es, Ammo, etc.) — this project's physics is hand-rolled by design
- Playwright, Puppeteer, or any screenshot/browser-automation test harness — dropped from this project on purpose

## Allowed Libraries / Addons

<!-- Add approved third-party dependencies here -->
- `three`, `@react-three/fiber` — rendering
- `maplibre-gl` (or equivalent) — OSM vector tile consumption for world data
- [Add further libraries here only as they are actively integrated]

## Architecture Decisions Log

<!-- Quick reference linking to full ADRs in docs/architecture/ -->
- [No ADRs yet — use /architecture-decision to create one]

## Engine Specialists

<!-- Written by /setup-engine when engine is configured. -->
<!-- Read by /code-review, /architecture-decision, /architecture-review, and team skills -->
<!-- to know which specialist to spawn for engine-specific validation. -->

- **Primary**: engine-programmer (three.js/R3F architecture, physics, world streaming)
- **Language/Code Specialist**: gameplay-programmer / engine-programmer (TypeScript — no dedicated per-engine code specialist exists for a custom three.js stack)
- **Shader Specialist**: technical-artist (three.js `ShaderMaterial`, GLSL)
- **UI Specialist**: ui-programmer (React HUD/overlays in `src/components/`, `src/hooks/`)
- **Additional Specialists**: performance-analyst (WebGL draw calls, frame budget), technical-director (architecture-level three.js/R3F decisions)
- **Routing Notes**: There is no vendor-provided "three.js specialist" agent — route rendering/scene-graph work to engine-programmer, physics to engine-programmer (owns `src/physics/`), UI to ui-programmer, and visual/shader work to technical-artist. Escalate cross-cutting architecture questions to technical-director.

### File Extension Routing

<!-- Skills use this table to select the right specialist per file type. -->
<!-- If a row says [TO BE CONFIGURED], fall back to Primary for that file type. -->

| File Extension / Type | Specialist to Spawn |
|-----------------------|---------------------|
| Game/engine code (`src/svartaksi/`, `src/world/`, `src/physics/`) | engine-programmer |
| Shader / material files (`ShaderMaterial`, GLSL snippets) | technical-artist |
| UI / screen files (`src/components/`, `src/hooks/`) | ui-programmer |
| Scene composition (React Three Fiber JSX scene graphs) | engine-programmer |
| Asset/model files (`src/models/*.glb`) | technical-artist |
| Authoring tools (`src/author/`) | tools-programmer |
| General architecture review | technical-director |
