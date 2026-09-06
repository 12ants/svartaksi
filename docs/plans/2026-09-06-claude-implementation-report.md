# Claude Plan Implementation Report

Date: 2026-09-06

Branch: `claude/plan-implementation`

Base revision: `8614c5b`

## Outcome

Claude Code (Opus, maximum effort) implemented and committed the authored bus-wheel and bus
shell ownership tasks. It also produced the offline GLB inspection tooling, asset notes, and
the hardware-baseline protocol. Claude reached its five-hour session limit while beginning
the optional camera characterization; the sole untracked partial test was removed and no
partial camera implementation remains.

The independent, hardware-safe capture-buffer task was then completed in the same isolated
worktree. Hardware-dependent streaming changes were not attempted without target-device
evidence.

## Completed commits

| Commit | Result |
| --- | --- |
| `fcc5655` | Track contributor guidance and the 2026-09-06 implementation plans. |
| `c568950` | Record a reproducible performance protocol, explicitly unverified without a hardware run. |
| `718afa9` | Measure `bus1.glb` offline and record wheel topology, pivots, clearance, and asset checksum. |
| `9c5734b` | Extract the four authored wheels, give them independent steer/roll pivots, and replay current steering, roll, and suspension state when the shell arrives. |
| `dbbfe10` | Give imported shell resources one explicit owner; cover detached interiors, generated wheel geometry, late loads, repeated disposal, and the previous double-dispose path. |
| `a7635df` | Replace active-capture `push/shift` eviction with fixed-capacity circular storage while preserving report semantics. |

## Verification

- Bus wheel integration before commit: 86 focused tests passed.
- Shell ownership integration before commit: 69 focused tests passed.
- Performance sampler: 17 focused tests passed.
- Final `pnpm test:all`: lint passed, strict TypeScript passed, 144 test files passed,
  1,458 tests passed.
- Final `pnpm build`: succeeded. Vite's pre-existing warning for chunks over 500 kB remains.
- `git diff --check`: clean.

Unit-test duration is not a gameplay benchmark and no FPS improvement is claimed.

## Known costs and unverified checks

The authored split adds seven shell draw calls: 14 non-interior source meshes, one emptied
source mesh, and eight wheel meshes produce 21. Its frame-time effect has not been measured.
The inspection script found four physical wheels totalling 7,088 of the asset's 25,816
triangles; exact measurements and the `bus1.glb` checksum are in the asset notes.

The following remain deliberately unverified because this worktree has no target browser or
GPU:

- visual authoring-tool confirmation of wheel membership;
- riding inspection for straight motion, turns, bumps, braking, fallback loading, doors,
  saloon, signs, and lights;
- three-run hardware captures for stationary, bus-route, and stream-boundary scenarios;
- any claim about frame time, FPS, memory trend, or perceived feel.

## Deferred by evidence or scope

- Roadside placement loop slicing requires a stream-boundary capture showing scheduler
  overruns before implementation.
- Visibility, mailbox allocation, and rendering candidates require CPU/allocation/renderer
  evidence respectively.
- Camera transform extraction is optional maintainability work. No partial file remains;
  resume it only with its characterization tests and manual camera-mode checks.
- No deployment, push, merge, or change to the user's original dirty checkout was performed.

New product-facing recommendations are in
[the game feel, variation, and UI cohesion roadmap](2026-09-06-game-feel-variation-roadmap.md).
