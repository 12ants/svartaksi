# Grade separation: making it read as structure

Three changes that give the world's bridges and tunnels the geometry they were already
behaving as if they had. Each is a self-contained module with its own tests; they landed
as three commits and can be reverted independently.

The common thread: the elevation profile has for some time lifted decks and dug cuttings,
and physics has grounded vehicles on those heights. What was missing was anything to
*look* at. A deck floated, a cutting swallowed the road, and an underpass simply was not
drawn at all.

## 1. Piers and abutments (`src/world/bridgePiers.ts`)

A viaduct with no visible support reads as a decal over the city. Its own shadow gave it
away most clearly: a dark band across the park with nothing above casting it.

Supports are placed off the deck's own samples — the same extended polyline, profile
heights and lifts the carriageway and the parapets were built from, passed in rather than
recomputed, so a pier cannot end up under a deck that is somewhere else. Each stretch
genuinely in the air gets an abutment at both ends and columns evenly spaced between.

Two decisions worth recording:

- **Whole spans, not a fixed step.** The column count is the run's length rounded to whole
  26m spans, so piers sit symmetrically inside the run. Stepping from one end at a fixed
  spacing leaves a ragged offcut at the other, which is the visual tell of a generated
  structure. A run shorter than one span gets no column at all — a short overbridge is a
  single clear span in reality too.
- **Run boundaries interpolate to the lift threshold**, rather than snapping to the nearest
  sample, so an abutment stands where the deck actually leaves the ground rather than up to
  a segment early.

**Supports are kept out of the roads beneath.** The profiled-road lookup the parapets use
cannot answer this: only grade-separated roads carry a `RoadElevationProfile`, so it misses
exactly the ordinary street a viaduct is usually built over. `createRoadObstructionTest`
reads the road set directly, narrowed by bounding box.

That prefilter has a subtlety worth keeping: it compares *bounding boxes*, not "does either
road's vertices land in the other's box". A road crossing the deck at right angles has both
endpoints well outside the deck's box while the segment between them runs straight through
it — a vertex test drops precisely the underpass it exists to find. The first draft had
this bug and a test caught it.

**Correction, 2026-09-13 — the obstruction test was rejecting three supports in four.**

As first written, `createRoadObstructionTest` was a purely horizontal question: is this
point inside any other road's carriageway. It never asked how high that road was, so a
road at the deck's *own* level counted as something to keep out of.

That is the usual case rather than a corner one. A viaduct's OSM way is one of several
carrying the same structure, and the neighbouring ways run directly along the deck's line;
an abutment, by construction, stands exactly where the deck hands over to the approach
ramp, and that ramp is at deck level right there. Measured over the committed Gärdet
cache: of 184 rejected supports, 147 were rejected by a road whose surface sat 0.45m
*above* the deck underside — one deck-thickness up, which is the deck's own top face.
Genuine underpasses clustered separately around 4.5m below, with an almost empty gap
between the two groups. 168 of the 184 were abutments.

The visible result was the failure this module exists to prevent: 68 of 94 elevated roads
near the origin got no support at all, so their decks read as decals after all — the
footnote below that "nor has any of it been seen" is where that hid.

The test now takes the deck's underside height and each candidate road's own surface
height, and rejects a support only where the road genuinely passes beneath it (see
`MIN_UNDERPASS_DROP`). The horizontal test runs first and the height is looked up only for
a candidate that already fails it, so the common case costs what it did before. After the
change the same measurement gives 215 supports instead of 69, one road without support
instead of 68, and the 20 rejections that were real underpasses are preserved exactly.

**No colliders.** These are visual supports. Making them solid without first proving no bus
route threads between them could wall a road off from a routing graph that still believes
it is open.

**Known limitation.** The pier foot is embedded below the road's own at-grade baseline
rather than sampled against terrain. Over water, or where ground falls away from the road's
baseline, the foot is buried or hangs. Sampling true ground needs a terrain query per pier;
deferred until something asks for it.

## 2. Open underpasses (`src/world/surfaceVisibility.ts`)

A `ground` road on a negative layer was hidden alongside tunnels, on the reasoning that
there was no open-surface geometry to draw its carriageway into.

That reasoning does not survive contact with what the profile does. For a ground road under
something, `resolveCrossings` lifts the road *above* and leaves this one at its baseline —
only an explicit `tunnel` is dug. The underpass is therefore an ordinary at-grade ribbon
with the deck lifted clear above it, which is exactly what an at-grade ribbon already draws
correctly.

Hiding it cost a hole in the street grid under every bridge: the road stopped at the shadow
and resumed on the far side. That reads worse than the failure mode the caution guarded
against, and it misleads the eye about where you can drive. Where the thing overhead is a
building, the building's own solid geometry occludes the ribbon beneath it.

`surfaceVisibility` now reads structure alone. `layer` survives as ordering evidence the
elevation profile reads, but no longer decides whether a surface is drawn — pinned by a
test so it cannot quietly start deciding again.

Tunnels stay hidden. A tunnel is dug and has no portal or cut geometry to be seen through,
so painting its ribbon would lay a road across whatever covers it. That is the case the
caution was actually for.

## 3. Cuttings and portals (`src/world/tunnelTrench.ts`)

The mirror of the deck slab. Where `deckThicknessProfile` grows a slab downward from a
road that rises, this grows walls upward from a road that was dug, to the grade it was dug
out of.

A tunnel bore is never painted, but the approach ramps carrying the street down to it are
ordinary visible roads that the profile digs — and the ground is a solid plane at grade. So
the ribbon vanished into that plane and the car sank with it.

- **Walls stand wholly outside the paved edge.** The first draft grew the wall's thickness
  inward from the edge, so it ate 0.35m of the lane it exists to keep drivable. A test
  caught it.
- **The wall top overshoots grade slightly.** The ground plane is tessellated and has its
  own variation; a wall stopping exactly at the nominal baseline leaves a hairline of
  daylight wherever the ground sits a millimetre high.
- **A portal caps the mouth only where a cutting reaches the road's own end while still
  deep.** That is a hand-over to a tunnel nothing paints. A cutting that climbs back to
  grade mid-polyline has no tunnel to hand over to and gets no cap — there is just road
  there.

Walls follow the mitered ribbon frame, like the parapets, so they hold the road's edge
through a bend.

## What is not verified

No hardware run, per the standing constraint in
[the performance baseline](../performance/2026-09-06-baseline.md). All three changes add
geometry — three merged meshes, each culled as a unit, each built only within the building
draw distance for the shadow-map reason the parapets already followed. Whether that is a
net cost worth measuring is open; nothing here claims a frame-time effect in either
direction.

Nor has any of it been *seen*. The tests assert placement arithmetic and scene-graph
structure — that a pier spans from its foot to the underside of the slab, that walls clear
the carriageway, that a portal exists at a mouth — which is what unit tests can honestly
reach in a project with no browser layer. Whether a viaduct now looks right is a question
for a person at the actual game.

## Verification

`pnpm test:all` — 148 files, 1539 tests, all passing. `pnpm build` succeeds. 41 new tests
across the two new pure modules, plus five scene-level tests covering the wiring: that
supports and cuttings reach the scene with shadows enabled, that supports stay out of the
underpass, and that a road at grade grows no cutting.
