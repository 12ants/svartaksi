# three.js / React Three Fiber — Version Reference

Last verified: 2026-09-06

| Field | Value |
|-------|-------|
| **three.js Version** | 0.185.1 (r185) |
| **@react-three/fiber Version** | 9.7.0 |
| **Project Pinned** | 2026-09-06 |
| **LLM Knowledge Cutoff** | May 2025 (roughly three.js r160-ish) |
| **Risk Level** | HIGH — versions are well beyond LLM training data |

## Note

three.js has moved roughly 25 releases (r160 → r185) since the training cutoff, and
@react-three/fiber jumped a full major version (v8 → v9, React 19 compatibility). Do
not trust API recall for either library without checking `breaking-changes.md` and
`deprecated-apis.md` in this directory first, and prefer reading the installed
package's own `.d.ts` files under `node_modules/three/` and
`node_modules/@react-three/fiber/` over memory. `@types/three` is pinned to the same
minor as `three` — a mismatch between the two is the usual cause of an API that
"does not exist" but does (see `docs/CLAUDE.md`).

This project already independently discovered one of these changes: the shadow-map
comment at `src/svartaksi/svartaksiRuntime.tsx:3980` notes `PCFSoftShadowMap` was
deprecated in this three.js version, in favor of `PCFShadowMap` (soft by default) —
confirmed correct by this research (r182 changelog). That's a good sign the team is
already fact-checking against the installed version rather than assumption; keep
doing that.

## Other pinned tooling

- **TypeScript 6.0.3** — shipped ~March 2026, the last JS-based compiler release
  before the Go-ported TS 7. Strict mode, ESM modules, and an ES2025 target are now
  the *defaults* (not opt-in), ES5 output support is gone, and safer module interop
  is always on. If any tooling or config assumed TS 5.x defaults (non-strict, CJS
  interop quirks), check `tsconfig.json` against actual behavior rather than assuming
  the old defaults still apply.
- **Vite 8.2.1** — introduced "Consistent CommonJS Interop," a breaking change to how
  CJS modules are exposed; a `legacy.inconsistentCjsInterop: true` escape hatch exists
  if a dependency breaks under the new behavior.
- **Vitest 4.1.10** — `poolOptions` is gone; pool config (`threads`/`vm`) now lives at
  the top level of the test config. `maxThreads`/`maxForks` collapsed into a single
  `maxWorkers`; `singleThread`/`singleFork` removed (use `maxWorkers: 1, isolate:
  false` instead). Browser/test providers are now separate installable packages.
  Workspace config (`vitest.workspace.ts`) is replaced by a `projects` field inside
  the main config. If `vitest.config.ts` still uses any of the old option names,
  they are silently ignored, not errors — worth a one-time audit.
