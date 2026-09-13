# Analysis: state of the game, and what to improve next

Date: 2026-09-13

Status: analysis + one proposed implementation slice. Findings are verified against the
tree at `cfe4666`; the slice itself needs its own acceptance notes.

## Method

Read-only pass over `src/` (187 files, ~36k lines), the dated plans in `docs/plans/`, the
performance notes, and one full `pnpm test:all` run. No behavioural claims here come from
playing the game — this project has no browser-automation layer by design, so everything
below is either static reading or unit-test evidence.

## Baseline health: green

`pnpm test:all` passes end to end — ESLint clean, `tsc --noEmit` clean, 148 test files /
1550 tests passing in 383s. There is no failing gate to fix and no lint debt to pay down.
That matters for what follows: the useful work here is *additive feel work*, not repair.

The codebase is in better shape than its own session-start hook suggests. The hook warns
about "0 design docs" and "no production planning", but that is a path assumption — the
studio scaffolding looks for `design/gdd/` and a populated `production/`, while this
project actually documents itself in `docs/plans/`, `docs/architecture/` and unusually
thorough module headers. The gap is filing, not knowledge.

## Findings, in priority order

### 1. The game-feel roadmap's first bullet is already done (stale doc)

`docs/plans/2026-09-06-game-feel-variation-roadmap.md`'s P1 slice opens with "ease steering
sensitivity with speed while preserving direct low-speed manoeuvring". That exists:
`applyCarControls` (`src/svartaksi/carPhysics.ts:145`) computes

```
steerLimit = CAR_MAX_STEER * (0.34 + 0.66 / (1 + absSpeed / 15))
```

and the file header documents it as the one deliberate departure from realism. Anyone
picking that roadmap up cold would re-implement it. The roadmap should be marked.

### 2. Camera look-ahead into turns is the real un-done half of that slice — **recommended**

The same P1 bullet asks for "a small configurable camera look-ahead into turns ... with
reduced-motion disabling". Nothing in `cameraRig.ts` reads steering or yaw rate: every
follow mode is a pure function of body position and instantaneous heading, so the shot
points exactly where the car points and never into the corner it is entering.

This is the highest-value slice available for its size:

- it is pure geometry, and `cameraRig.ts` is already a pure module with a test file, which
  is exactly what this project's "pure first, the runtime binds it" rule asks for;
- the existing `CameraSettings` dial architecture (`cameraSettings.ts` +
  `CAMERA_SETTING_BOUNDS` + the HUD sliders in `App.tsx`) already has a slot shape for one
  more configurable value, so "configurable" and "reduced-motion disabling" are the same
  one control rather than a new accessibility subsystem;
- it changes how the game reads at every speed in every follow mode, for well under a
  hundred lines.

### 3. Input buffering for discrete actions — not implemented, deferred

The roadmap also asks for input buffering on enter/exit, phone, doors and camera mode.
`playerInput.ts` is a pure axis merger with no time dimension at all, so a press that lands
during a vehicle-entry sequence is simply dropped. Worth doing, but it touches the entry
state machine in `svartaksiRuntime.tsx` rather than a pure module, so it is a larger and
riskier slice than #2. Deferred deliberately, not overlooked.

### 4. `docs/TODO.md` is referenced by three code comments and has never existed

`src/svartaksi/horseBody.ts:7`, `src/svartaksi/svartaksiRuntime.tsx:3542` and
`src/world/terrain.ts:457` each cite `docs/TODO.md` for a known limitation (the horse's
kinematic body, the freecam look-rate discrepancy, water polygons not cut over their bank).
`git log --all -- docs/TODO.md` returns nothing: the file was never committed, so three
real caveats point at a document a reader cannot open. Either the file should be restored
from whatever it was, or each comment should carry its own caveat inline. A report line,
not a work item — the comments are still individually informative.

### 5. Test-suite wall time is friction, but it is not a game improvement

383s for 1550 unit tests, of which 692s is cumulative jsdom *environment* setup across
workers — the environment costs roughly twice what the assertions do. Most of these suites
test pure arithmetic and need no DOM. Moving the pure suites to the `node` environment
would cut the loop substantially. Listed for completeness and explicitly not proposed:
the ask was to improve the game.

### 6. `svartaksiRuntime.tsx` is 4210 lines

Known, and load-bearing rather than accidental — it is the single `useFrame` loop the whole
architecture is organised around, and the project has been steadily extracting pure modules
out of it (`cameraRig`, `alightPath`, `glbParts`, `busGeometry`, `runtimeCamera`). The
extraction habit is the right one and is already working. No action proposed; the roadmap's
own note that camera extraction stays "maintainability work unless allocations show it
matters" is the correct call.

## Proposed slice: camera look-ahead into turns

See `docs/architecture/2026-09-13-camera-corner-lead.md` for the design and its rationale.

## Addendum: bridges render without supports

Investigated after the analysis above, on a report that bridges looked wrong.

### How it was investigated

This project has no browser layer, so the evidence is not a screenshot. The committed
`vendor/worldcache` tiles were decoded with `decodeVectorTile`, normalised with
`normalizeMapLibreFeatures`, and run through the real elevation-profile and pier-placement
code headlessly — the whole pipeline up to the point where it would hand geometry to
three.js. That turns "bridges look wrong" into counts.

It is worth noting the technique. A world built from real data can be measured without
being rendered, and doing so caught a defect that 1550 passing unit tests did not, because
every one of those tests uses a hand-built fixture that happens to avoid the case.

### What was found

Within 700m of the origin, 94 roads are elevated enough to want supports. **68 of them —
72% — got no support at all.** Their decks are exactly the "decal floating over the city"
the pier module was written to prevent.

The cause was `createRoadObstructionTest`. It asks whether a support stands inside another
road's carriageway, and it asked that purely horizontally: it never consulted how high the
other road was. A road at the deck's own level therefore counted as something to keep out
of — and that is the common case, not a corner one, because a viaduct's OSM way is one of
several carrying the same structure and an abutment by construction stands where the deck
meets its approach ramp.

Of 184 rejected supports, 147 were rejected by a road sitting 0.45m *above* the deck
underside — one deck-thickness, i.e. the deck's own top face. 168 of the 184 were
abutments. Genuine underpasses formed a separate cluster around 4.5m below, with an almost
empty gap between the two groups, which is what made the fix's threshold a measurement
rather than a guess.

Fixed by giving the test the deck underside and each candidate's own surface height, and
rejecting only a road that genuinely passes beneath. Same measurement afterwards: 215
supports instead of 69, one unsupported road instead of 68, and all 20 rejections that were
real underpasses preserved.

### What was reported but did not reproduce

**Piers floating over water or buried in rising ground.** This is a real documented
limitation — `PIER_FOOT_EMBED` sinks a foot 0.6m below the road's *baseline*, never a
terrain sample — but it does not currently manifest. Across the whole cached city every
pier foot sits between 0.42m and 1.55m below the terrain under it: always embedded, never
hanging, and not one standing inside a water polygon. The limitation is latent, and the
0.6m nominal embed is what most of that spread is. Worth fixing when a bridge over open
water is actually reachable; not the cause of anything visible now.

**Road vanishing at a bridge, and z-fighting.** Both were investigated over 831 roads
within 900m of the origin. Neither reproduces *in the specific mechanisms checked below* —
which is narrower than "neither exists", and the difference is stated rather than glossed.

*Vanishing road.* `surfaceVisibility` hides exactly one thing: a `tunnel`. 50 roads in the
sample are hidden, all 50 of them tunnel-tagged, and only 4 of those lie within 25m of any
bridge. So the visibility gate is not removing roads at bridges: the negative-`layer` underpass
case that used to do it was already fixed on 2026-09-09.

That clears `surfaceVisibility` specifically, not every way a road can fail to appear. Two
other drop paths were *not* examined. `threeWorld.ts` discards any road whose ribbon comes
out with an empty index (`if (!geometry.index || geometry.index.count === 0)`) before it
reaches a draw bucket, and nothing counts how often that fires. `isRenderedWay`
(`svartaksi/roadStyle.ts`) is a separate inclusion gate that this module's own header notes
it "no longer shares a decision with". Either could drop a road without a bridge being
involved at all; neither has been measured.

*Z-fighting.* What was measured is one pair specifically: **road carriageway against road
carriageway, at grade-separated crossings**. The reported symptom also named railings and
the road beneath a deck, so note what this does not cover — railing against deck, and deck
slab against the terrain plane, were both left unmeasured and remain open.

Of 268 crossings carrying grade-separation evidence, 58 involve two visible roads. 30 of those 58 resolve to within 5cm of each other, which sounds alarming and is
not: **all 30 are crossings of two roads of the same class**, which is precisely the case
`roadRenderOrder` already resolves by pinning each road to its own draw slot, making the
winner camera-independent. Two different classes are separated by `ROAD_CLASS_STEP` by
construction and none appeared within 5cm.

26 of the 30 are a bridge's own touchdown — a footbridge ramping back to grade to join the
path network, where being at the same height is the correct answer rather than a defect.
The remaining 4 are flat crossings in the *middle* of a bridge span, which is a genuine
modelling oddity but still same-class and so still not a depth fight. Left alone: fixing 4
mid-span path crossings is not worth changing a resolution rule that is right 264 times.

A false lead worth recording: bridges of kind `path` looked like they might be failing to
lift at all. They are not — measured lift for the 17 path bridges is 1.42m minimum, 4.97m
median, 9.10m maximum. The apparent flatness was entirely the touchdown effect above.
