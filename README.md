# svartaksi

A game about a black taxi. https://svartaksi.pages.dev

Built with three.js and React: a real city, streamed from OpenStreetMap and rebuilt as
geometry around you, with a Saab 90 you can walk up to, get into, and drive.

## Running it

```
pnpm install
pnpm dev
```

Then open http://localhost:7777. The world streams from OpenStreetMap on first run; a
cache of the opening area is committed under `vendor/worldcache` so the first load works
offline.

## What this is made of

The city, the streaming, the physics and the HUD come from the `nacka` project — its own
rigid-body solver and raycast vehicle, its OSM-to-geometry pipeline, its authoring tools.
Getting in and out of a vehicle is ported from [Sketchbook](https://github.com/swift502/Sketchbook):
the character walks to the door, opens it, lowers itself into the seat, and reverses all of
it to get out, all computed in the car's own frame so a rolling car carries you with it.

The vehicles are authored assets rather than procedural shapes — `src/models/saab90.glb`
and `src/models/bus1.glb` — fitted at load to the dimensions the physics and the routing
already agree on. Both are exported one mesh per material, so the Saab's axles are split
back into four turning wheels at load time (`src/svartaksi/glbParts.ts`).

## Commands

| | |
|---|---|
| `pnpm dev` | dev server on :7777 |
| `pnpm test` | unit tests (Vitest, jsdom) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test:all` | all three, in order |
| `pnpm build` | production build |
| `pnpm deploy` | prefetch the world, build, publish to Cloudflare Pages |

There is no browser-automation layer in this project by design; see `CLAUDE.md`.
