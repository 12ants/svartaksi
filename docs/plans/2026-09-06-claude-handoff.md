# Claude Handoff: Bootstrap Follow-up and Performance

Date: 2026-09-06. Inspected revision: `8614c5b`.
Status: proposed implementation work; this session changes documentation only.

## Recovered context

“Previous work” is interpreted as the unfinished game bootstrap recorded in
[`../logs/2026-09-06-bootstrap.md`](../logs/2026-09-06-bootstrap.md).
The available session log lists commits but no newer feature backlog; `.remember/`
contains operational logs, without the advertised `now.md` or daily memory files.
The previous task in this conversation created the root contributor guide, which remains untouched.

The bootstrap explicitly leaves bus wheel animation, a hardware performance baseline,
and the approximately 4,100-line runtime open. Vehicle entry/exit, the speech callback
fix, and incremental trees/lights/signals/neon placement are already implemented.
Do not redo them or import nacka's old backlog.

## Read and execute in this order

1. Read root `AGENTS.md`, `CLAUDE.md`, and the bootstrap notes.
2. Follow [performance plan, Task 1](2026-09-06-performance-plan.md#task-1-record-a-reproducible-hardware-baseline) to establish comparable evidence.
3. Follow [bus continuation plan](2026-09-06-bootstrap-continuation-plan.md).
4. Select one performance candidate at a time from the performance plan based on the baseline.
5. Consider the runtime extraction last; it is maintainability work, with no promised FPS gain.

The user requested plans for Claude to implement. This document is the handoff artifact;
no Claude session has been launched and no changes have been sent externally.

## Design requirements

- Preserve `BUS_DIMENSIONS`, collision envelopes, route profiling, suspension, passenger interiors, doors, signs, and existing fallback behavior.
- Preserve procedural placement order, stable hash seeds, quality tiers, and visible scene content when comparing performance.
- Keep the custom physics engine and TypeScript/React/Three.js stack; no new dependency is needed for the first candidates.
- Use Vitest/jsdom for logic; manually inspect rendering and feel. Do not add browser automation.
- Keep instrumentation opt-in. Never report software rendering or unit-test duration as hardware game performance.
- Run focused tests during implementation, then `pnpm test:all` and `pnpm build` for each completed change set.
- Keep changes individually reviewable. Do not combine asset correction, capture changes, and world scheduling in one commit.

## Prioritized suggestions and evidence

| Priority | Finding | Proposed action | Evidence boundary |
| --- | --- | --- | --- |
| P0 | `captureContext()` reports `runtime-debug`, `runtime`, zero durations, and unknown renderer kind | Preserve raw export and attach explicit run metadata | Existing capture is useful but does not identify a reproducible run alone |
| P1 | Bus shell explicitly leaves wheels static; procedural wheel groups are hidden | Restore authored wheel groups with measured pivots | Confirmed visual regression in bootstrap and source |
| P1 | `generateBusStops`, `mappedMailboxes`, and `generateMailboxes` run synchronously inside the surface generator | Add incremental forms if streaming captures show slice overruns | Loop structure is confirmed; hardware cost is unmeasured |
| P2 | `performanceMetrics.ts` shifts a full sample array after capacity | Replace with circular storage | Only affects active capture; not ordinary play |
| P2 | Camera follow allocates a quaternion and matrix each frame | Reuse per-runtime scratch objects if allocation profiles justify it | Expected allocation reduction, unknown FPS benefit |
| P2 | `loadBusShell()` removes interior meshes before its disposal traversal | Explicitly own and dispose all loaded resources | Current bus asset has 15 meshes, 95,820 bytes, and zero textures; do not claim a current texture leak |
| P3 | `computeVisibleBuildings()` scans and sorts candidates | Profile before considering bounded selection or existing spatial indexing | Visibility checks are already throttled; ordering affects rendering determinism |
| P3 | Main runtime combines many responsibilities | Extract camera binding first, preserving call order | Readability and testability benefit; not a performance fix by itself |

## Alternatives and limits

Prefer measured, bounded changes to broad runtime rewrites. Reducing draw distance or
resolution may help GPU-bound devices, but changes image quality and must be compared
as a separate quality experiment. Workers, new physics engines, renderer migrations,
and asset compression are not justified by this inspection. The bus GLB is already small.

Removing an object does not dispose its geometry/material, and shared resources need
explicit ownership. This informs the cleanup suggestion; it does not establish a measured
leak. See the [official Three.js disposal guide](https://threejs.org/manual/en/how-to-dispose-of-objects.html).

## Prompt to give Claude

> Read docs/plans/2026-09-06-claude-handoff.md and its linked plans. Implement the bootstrap
> follow-up and evidence-supported performance improvements task by task. Preserve all
> stated invariants, write focused regression tests, and record results in the plan
> checkboxes. If hardware capture is unavailable, complete the unit-testable work and
> explicitly leave hardware acceptance unverified. Avoid speculative rewrites and do not
> deploy. Report changed files, test results, and before/after evidence separately.
