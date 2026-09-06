# three.js / R3F — Current Best Practices (post-cutoff)

Last verified: 2026-09-06

Practices and additions that appeared after the May 2025 training cutoff, relevant
to a WebGLRenderer + React Three Fiber project like this one. WebGPU/TSL-specific
material (compute shaders, node materials, `three/webgpu` imports) is **not**
included here in depth — this project uses the classic WebGLRenderer path via R3F,
and pulling in WebGPU-only guidance would be speculative noise. If a future WebGPU
migration is scoded, research that separately rather than assuming this doc covers it.

## three.js

- **Compilation/build performance improved ~3x** as of r184 — if build times were a
  known pain point before, worth re-measuring rather than assuming old numbers.
- **`Object3D.dispose()`** was added (r186, just past the current 0.185.1 pin — watch
  for it on the next bump). Custom `Object3D` subclasses that override `dispose()`
  will need to call `super.dispose()` once the project updates past r185.
- **PBR lighting accuracy improved** (r180–r181): indirect specular and energy
  conservation calculations changed, and rough materials (roughness > 0.5) render
  brighter than before. If any material tuning was done against an older three.js
  version's rendering, a visual re-check is warranted — this is exactly the kind of
  silent appearance drift `deprecated-apis.md` can't catch with a grep.
- **`FBXLoader` auto-corrects +Z-up to +Y-up** (r184) — if any manual
  compensating rotation was added around FBX imports to fix orientation, it may now
  be double-applied.

## React Three Fiber v9

- Fully targets **React 19** — if the project's React version predates 19, check
  compatibility before assuming R3F v9 idioms apply as documented.
- `useLoader` supports pooling/reuse of external loader instances now, which matters
  for any code loading many similar assets (e.g., streamed building facades/props in
  `src/world/`) where a shared loader instance could reduce overhead versus a fresh
  loader per call.

## TypeScript 6.0

- Strict mode, ESM modules, and an ES2025 target are the new **defaults** — this
  project's `tsconfig.json` already opts into strict per `CLAUDE.md` ("TypeScript,
  strict, no emit"), so this default flip is not expected to change behavior here,
  but it's worth confirming `tsconfig.json` isn't relying on any option whose
  *default* changed without the project's own explicit override.
- A `--ts6-migration` flag exists for static-analysis of patterns that will break —
  useful if a future TS7 (Go-ported compiler) upgrade is ever planned, not needed now.

## Vite 8 / Vitest 4

- Vite 8's "Consistent CommonJS Interop" is a breaking change for some CJS
  dependencies; if a third-party package starts behaving oddly after a Vite bump,
  check for `legacy.inconsistentCjsInterop` before assuming it's a project bug.
- Vitest 4 replaced `poolOptions`/`maxThreads`/`maxForks`/`singleThread`/`singleFork`
  with a flatter `maxWorkers`/`isolate` config, and replaced
  `vitest.workspace.ts` with a `projects` field in the main config. If
  `vitest.config.ts` is ever touched, verify it isn't still using the old option
  names (they're silently ignored rather than erroring).
