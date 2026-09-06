# Game Performance Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` if available to implement this plan task by task. Claude is the intended implementer.

**Goal:** Establish a hardware baseline and reduce demonstrated streaming or allocation costs without silently lowering quality.

**Architecture:** Reuse the opt-in performance bridge and scheduler diagnostics. Capture baseline/candidate runs with matching metadata, then change one bounded source area and preserve deterministic behavior.

**Tech Stack:** TypeScript, Three.js/R3F, Vitest, existing browser DevTools, pnpm.

**Spec:** [Claude handoff](2026-09-06-claude-handoff.md#design-requirements).

## Global constraints

No hardware FPS result was collected during planning. Candidate rankings are source-based
hypotheses. Keep capture opt-in, retain custom physics and quality settings, and add no
browser automation. Hardware evidence must come from the actual target browser/device.
Use focused unit tests, then `pnpm test:all` and `pnpm build` after each implementation.

## Task 1: Record a reproducible hardware baseline

**Files:** read `src/performance/{performanceMetrics,performanceCapture,installPerformanceBridge}.ts`,
`src/svartaksi/svartaksiRuntime.tsx` (`captureContext` and `addAfterEffect`), and
`src/world/buildScheduler.ts`. Create `docs/performance/2026-09-06-baseline.md`
and store raw JSON under `docs/performance/captures/` when actual runs exist.

- [x] Run `pnpm test -- tests/performance tests/world/buildScheduler.test.ts` and record results without treating test timings as a game benchmark.
  **Result 2026-09-06:** 4 files, 27 tests, all passing. Recorded in [the baseline](../performance/2026-09-06-baseline.md#what-was-run) as a suite result and explicitly not as a benchmark.
- [ ] **UNVERIFIED — no target browser.** Run `pnpm build`, then `pnpm exec vite preview --host 127.0.0.1 --port 7777`. Open `http://localhost:7777/?perfCapture=1` on the target device. Verify world data loads in preview; do not substitute a different build mode between runs.
  **2026-09-06:** `pnpm build` passes; the implementation worktree is headless with no chromium/chrome/firefox on `PATH`, and no automation was added. Protocol written up in the baseline document; no run performed.
- [ ] **UNVERIFIED — depends on a run.** Metadata contract written up in the baseline document. Record revision (`git rev-parse HEAD`), dirty diff, browser/GPU, verified hardware/software/unknown backend, power mode, viewport, DPR, quality options, location/heading, time of day, cache state, and camera mode. Keep cold-cache startup separate from warm steady-state runs.
- [x] Define three repeatable manual scenarios: stationary exterior view after the intro; the same bus route segment; and driving across the same world-stream boundary. Record exact starting coordinates and route landmarks from the actual run before comparison.
  **Result 2026-09-06:** `stationary-exterior`, `bus-route-segment`, `stream-boundary-drive` defined in the baseline document. Coordinates and landmarks are marked as placeholders to be pinned on the first real run — **UNVERIFIED** and deliberately not invented.
- [ ] **UNVERIFIED — depends on a run.** Wait for the runtime and initial world/intro completion, warm up for 20 seconds, then capture 10 seconds of foreground play. In DevTools use:

```js
const bridge = window.__SVARTAKSI_PERFORMANCE__;
if (!bridge) throw new Error('Open with ?perfCapture=1');
await bridge.ready; // Runtime exists; separately wait for world/intro completion.
await bridge.start();
// Return focus to the game and perform the documented 10-second scenario.
// On completion, run in DevTools:
const raw = await bridge.stop();
copy(JSON.stringify(raw, null, 2)); // DevTools clipboard helper, not application code.
```

- [x] Preserve raw JSON unchanged and store corrected run metadata in the baseline Markdown or a sidecar JSON.
  **Result 2026-09-06:** ruled as documentation, not a code change — `captureContext()` is left untouched and the placeholder fields are tabulated in the baseline. `docs/performance/captures/README.md` fixes the naming and the never-edit-an-export rule. Runtime defaults (`runtime`, `runtime-debug`, zero durations, unknown renderer kind) are not verified metadata. Inspect timestamps for focus/console pauses; reject contaminated runs rather than silently dropping their worst frames.
- [x] The sampler retains 1,800 frames, not a guaranteed time window. **Documented in the baseline** (capacity section), including that `startedAtMs` survives eviction and is therefore the tell for a truncated ring. Verify sample timestamps cover the intended duration. At unusually high refresh rates shorten the scenario or explicitly increase capacity for both baseline and candidate. Never label a truncated ring snapshot as a full 30-second run.
- [ ] **UNVERIFIED — depends on a run.** The statistic list and the latest-value/current-job caveats are written up in the baseline. Summarize p50/p95/p99 frame milliseconds using existing nearest-rank semantics, counts over 25/50 ms, render-budget scale range, renderer calls/triangles/geometries/textures, and scheduler worst slice/histogram. Renderer/build snapshots are latest values, not per-frame histories or peak counters; scheduler data is for the current/latest job only.
- [ ] **UNVERIFIED — depends on a run.** Run each scenario three times. Use a separate DevTools allocation/CPU trace to choose the next candidate; profiling overhead must not contaminate the comparative frame captures.

**Acceptance:** Three comparable runs per scenario, truthful metadata and renderer classification,
raw exports retained. If hardware is unavailable, mark this task unverified; proceed only
with structural correctness work and make no hardware performance claims.

**Status 2026-09-06: UNVERIFIED.** Zero runs captured; hardware was unavailable and the
fallback clause was taken. See [`docs/performance/2026-09-06-baseline.md`](../performance/2026-09-06-baseline.md).
No candidate in this plan has hardware evidence, and none is claimed to.

## Task 2: Slice remaining placement loops when streaming evidence warrants it

**Files:** modify `src/world/busStops.ts`, `src/world/mailboxes.ts`, and
`src/world/threeWorld.ts`; extend `tests/world/incrementalPlacement.test.ts`,
`tests/world/busStops.test.ts`, and `tests/world/mailboxes.test.ts`.
Read `tests/world/buildScheduler.test.ts` and `tests/world/streamRestream.test.ts` for lifecycle coverage.

**Interfaces:** Add `generateBusStopsJob`, `generateMailboxesJob`, and `mappedMailboxesJob`
with the same parameters as their existing eager counterparts and return types
`Generator<void, BusStopPlacement[], void>` / `Generator<void, MailboxPlacement[], void>`.
The eager APIs drain the generator and remain backward compatible.

- [ ] Add regression fixtures before conversion: intersecting roads, duplicate mapped boxes, obstacles, skipped road kinds, zero-length segments, and one very long road. Freeze expected coordinates/order from existing behavior, not merely equality between two new wrappers.
- [ ] Add incremental/eager parity and multi-yield assertions. Reuse `road` and `drain` helpers in `incrementalPlacement.test.ts`:

```ts
const roads = Array.from({ length: 900 }, (_, i) => road(`stop-${i}`, 0, i * 30, 'primary'));
const result = drain(generateBusStopsJob(roads, []));
expect(result.value).toEqual(generateBusStops(roads, []));
expect(result.yields).toBeGreaterThan(1);
```

- [ ] Run the placement suites to observe failures for missing jobs. Convert existing bodies to generators; maintain loop-local spacing, side, nearest-road winner, hash, and accumulated placement state across yields. Start with a named 256-operation cadence consistent with existing jobs, then measure.

```ts
let operations = 0;
// Increment inside long-running segment/candidate loops, including skipped work.
if (++operations % 256 === 0) yield;
```

- [ ] Yield in road-length scans, mapped-box road/segment scans, and candidate loops, not just after each road. A single clearance query may still scan many roads/buildings; document that remaining atomic cost and profile it before changing clearance semantics.
- [ ] Replace synchronous calls in `buildSurfacesInto` with `yield*`; preserve mapped-first mailbox order, avoid lists, and the existing `.slice(0, MAX_...)` positions. Do not stop generation early merely because the cap is reached without proving identical behavior.
- [ ] Keep cancellation free of scene mutations until the existing staging publication. Add cancel/restart assertions that old placements never publish after a replacement build.
- [ ] Run `pnpm test -- tests/world/incrementalPlacement.test.ts tests/world/busStops.test.ts tests/world/mailboxes.test.ts tests/world/buildScheduler.test.ts tests/world/streamRestream.test.ts tests/world/threeWorld.test.ts`.
- [ ] Repeat the matched stream-boundary captures. Compare scheduler histograms and frame p95/p99, while checking total completion time and replacement count. Shorter slices alone do not establish faster total builds.
- [ ] Run `pnpm test:all` and `pnpm build`; commit as `perf: slice remaining roadside placement work` if correctness holds and evidence supports the tradeoff.

## Task 3: Remove capture buffer shifting

**Files:** modify `src/performance/performanceMetrics.ts`; extend
`tests/performance/performanceMetrics.test.ts`; keep `PerformanceSampler` and report schemas unchanged.

**Scope:** Capture overhead only. `recordFrame` already returns immediately when capture
is inactive; do not claim an ordinary gameplay optimization.

- [ ] Add wraparound/reset/isolation tests in the existing suite using its `environment` fixture. Preserve the existing meaning of `startedAtMs` as capture start even when early samples are evicted.

```ts
const capture = createPerformanceSampler({ capacity: 2, clock: { now: () => 10 } });
[1, 2, 3, 4, 5].forEach(ms => capture.recordFrame(ms, 1));
expect(capture.snapshot(environment).samples.map(s => s.frameMs)).toEqual([4, 5]);
const snapshot = capture.snapshot(environment);
snapshot.samples[0].frameMs = 999;
expect(capture.snapshot(environment).samples[0].frameMs).toBe(4);
capture.reset();
expect(capture.snapshot(environment).samples).toEqual([]);
```

- [ ] Replace push/shift storage with a fixed-capacity array, write index, and count. Insert in O(1); allocate ordered copies only when snapshot/report is requested.

```ts
const slots = new Array<PerformanceSample>(capacity);
let writeIndex = 0;
let count = 0;
// After existing validation and timestamp calculation:
slots[writeIndex] = { timestampMs, frameMs, renderBudgetScale };
writeIndex = (writeIndex + 1) % capacity;
count = Math.min(count + 1, capacity);
// Snapshot order: (writeIndex - count + capacity + i) % capacity, i in [0, count).
```

- [ ] Reset indices, count, and start time. Read the newest timestamp through the ring index. Keep deep-enough snapshot isolation, validation, percentile semantics, and JSON schema identical.
- [ ] Existing functional tests may already pass before this optimization; use source inspection or an isolated insertion microbenchmark to establish removal of linear shifting. Do not add flaky timing thresholds to Vitest or pretend a behavior-preserving change must fail a functional test first.
- [ ] Run `pnpm test -- tests/performance`, `pnpm test:all`, and `pnpm build`; commit as `perf: use circular storage for capture samples`.

## Task 4: Conditional allocation and visibility work

Camera allocation reduction is fully scoped by Task 4 of the
[continuation plan](2026-09-06-bootstrap-continuation-plan.md#task-4-optional-camera-only-runtime-extraction).
Do it only once; reuse that closure for extraction and scratch-object ownership.

Mailbox generation also constructs `[...avoid, ...boxes]` per candidate. If allocation
traces identify it, initialize one job-local obstacle array from `avoid`, pass it to
`isPavementClear`, and append each accepted box. Keep output separately owned and preserve
obstacle order; verify caller arrays stay untouched and placements match the frozen fixtures.

Visibility selection scans and sorts inside `computeVisibleBuildings`. Before changing
it, measure candidate count and CPU cost at the already-throttled call rate. A bounded
selection or spatial index must retain the nearest cap and original-order tie behavior,
and rebuild its index on world replacement. This is a discovery suggestion, not an
approved implementation algorithm; write a separate plan if measured cost justifies it.

## Acceptance and stop rules

Choose the primary statistic before each candidate: e.g. streaming frame p95 in ms,
with a provisional target of at least 10% improvement in the median of three paired
runs. Treat that as a screening target, not statistical proof. If run-to-run variation
is comparable to the gain, repeat or report inconclusive.

Reject a candidate that breaks visuals, placement, collisions, cancellation, or resource
ownership. Investigate >5% regressions in p99 or build completion time and any increasing
memory trend over repeated route cycles. Check render-budget scale so automatic quality
reduction does not masquerade as an algorithmic improvement. Keep correctness fixes even
if timing is inconclusive, but label them accordingly. Stop after two attempts on one
candidate and document results before widening scope.

## Required implementation report

For each completed task, record the commit, changed files, exact test results, manual
checks, baseline/candidate run paths, primary and secondary metrics, and any unverified
acceptance items. No automatic deployment is part of this plan.
