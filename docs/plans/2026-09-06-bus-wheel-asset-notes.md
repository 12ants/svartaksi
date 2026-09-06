# `bus1.glb` wheel asset notes

Measured evidence for Task 1 of the
[bootstrap continuation plan](2026-09-06-bootstrap-continuation-plan.md#task-1-establish-a-wheel-extraction-contract),
which requires the wheel split to be justified by numbers taken from the file rather than
guessed from body bounds.

Everything below is produced by `node scripts/inspect-bus-glb.mjs`, which is committed so
the measurement is repeatable and so a future asset can be re-measured the same way.

## Asset identity

| | |
| --- | --- |
| Path | `src/models/bus1.glb` |
| Bytes | 95,820 |
| SHA-256 | `95b9935dec9e9069fa37a64ef9ef0bb66f13da6537601fa7ce500ec42cdc1df7` |
| Generator | glTF-Transform v4.3.0 |
| Required extensions | `KHR_draco_mesh_compression` |
| Meshes / nodes / materials | 15 / 15 / 15 |
| Textures / images | 0 / 0 |
| Triangles | 25,816 |
| Provenance | "bus" by mamont nikita, Sketchfab, CC-BY-4.0 (from the file's `asset.extras`) |

## Coordinate convention

All fifteen nodes are flat siblings of the scene root and carry the *same* transform: a
translation of about −1 mm on each axis and a −90° rotation about X, which is the
exporter's Z-up-to-Y-up correction. There is no node hierarchy and no per-node scale, so
"asset space" below means node-local geometry with that one transform applied.

With that transform applied the asset is Y-up, sits on the ground (`min.y = 0.000`), and
its **front is +Z**: `headlght` and `nplate` components are at z ≈ +5.0, `backlght`,
`rearlght` and the second plate at z ≈ −5.1.

That agrees with the bus model's own convention (`BUS_DIMENSIONS.frontAxleZ = +3.75`), so
the shell needs no yaw correction — which is why `loadBusShell` has never applied one.

Sidedness follows from it. In three's right-handed Y-up space with forward = +Z and up =
+Y, right = forward × up = −X, so **+X is the bus's left**. That matches `busModel.ts`,
where the steer group built at `side = +1` is named `bus:front-wheel-left`.

Asset bounds, node transforms applied:

```
min [-1.577, 0.000, -5.127]  max [1.578, 3.140, 5.127]  size [3.155, 3.140, 10.253]
size after busShellScale [3.192, 3.060, 11.004]
```

The 3.155 m width is the mirrors; `BUS_ASSET_SIZE.width = 2.57` is the body without them,
which is what `busShellScale()` fits to the sheet. Height and length land exactly on
`BUS_DIMENSIONS` (3.060, 11.004 against 3.06, 11.0), confirming `BUS_ASSET_SIZE` is
correctly measured.

## Component method

Triangles are grouped into connected components by union-find, after welding vertices that
share a position to within 1e-4 m. Draco quantises positions on export, so two triangles
that share a corner in the authoring package come back agreeing only to about the
quantisation step; 1e-4 m is far below any real feature of a bus (a tyre sidewall is
~0.02 m) and far above that noise.

Assignment to a wheel is then a **cylinder test on real vertices**: a wheel is a solid of
revolution about its axle, so a component belongs to a wheel when every one of its vertices
lies within `halfWidth` of the hub along X and within `radius` of the hub axis in the YZ
plane.

Two details that the naive versions get wrong, both found by running this:

- Testing bounding-box corners instead of vertices **rejects the tyre**. A tyre is an
  annulus; the corners of its axis-aligned box sit ~40% further from the axle than any of
  its actual geometry.
- Growing a hub without a lateral reach limit **swallows both wheels of an axle**, because
  the bus is symmetric and the left and right wheels of one axle share a hub axis exactly.
  The reported "wheel" is then 2.6 m wide.

Hubs are seeded from the components of the `wheel` material — the one label in this asset
that is unambiguous — and grown to the largest component sharing the same axis, which is
the tyre.

## Physical wheel count and hub centres

**Four wheels.** The asset is a two-axle bus. The dimension sheet describes a six-wheeled
one (rear duals), so two of the sheet's six suspension entries have no visual counterpart;
see the mapping below.

Hub parameters, in asset space, full precision, straight from the script:

| Id | Position | Side | x | y | z | radius | halfWidth |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | rear right | −1 | −1.0936018526554108 | 0.4653582274913788 | −2.455503463745117 | 0.4656279328320925 | 0.203398197889328 |
| 1 | rear left | +1 | 1.093330293893814 | 0.4653582274913788 | −2.455503463745117 | 0.4656279328320925 | 0.20363447070121765 |
| 2 | front right | −1 | −1.0936018526554108 | 0.4653582274913788 | 2.7163796424865723 | 0.46564945755409926 | 0.203398197889328 |
| 3 | front left | +1 | 1.093330293893814 | 0.4653582274913788 | 2.7163796424865723 | 0.46564945755409926 | 0.20363447070121765 |

In final bus coordinates — after `busShellScale()` = (1.011673, 0.974522, 1.073171):

| Id | Position | restCenter |
| --- | --- | --- |
| 0 | rear right | (−1.106, 0.454, −2.635) |
| 1 | rear left | (1.106, 0.454, −2.635) |
| 2 | front right | (−1.106, 0.454, 2.915) |
| 3 | front left | (1.106, 0.454, 2.915) |

The asset's running gear does **not** match the sheet's, which is exactly why the plan
requires visual pivots to be kept separate from physics axle locations:

| | Asset (scaled) | `BUS_DIMENSIONS` |
| --- | --- | --- |
| Wheelbase | 5.550 m | 7.400 m |
| Track | 2.212 m | 2.040 m |
| Axle height | 0.454 m | 0.550 m |
| Tyre radius | ≈0.454 m | 0.520 m |
| Wheels | 4 | 6 |

Nothing in that table is a bug to fix. The sheet is the contract the route profiler, the
turning circle, the door placement and the collision envelope were all built against; the
asset is a skin fitted onto it. The wheels are drawn where the asset's arches are, and the
bus still steers, turns and collides on the sheet's numbers.

Note the asset is internally consistent: its axle height (0.4535 after scaling) equals its
tyre radius, and its lowest vertex is y = 0. Its tyres stand on the road.

## Component assignment

Each of the four hubs claims exactly **8 components, 1,772 triangles**, and the four are
identical — a symmetry that a mis-assignment would break:

```
contained components per hub (these are the wheel):
  [0] components 8  triangles 1772  materials {black, wheel}
  [1] components 8  triangles 1772  materials {black, wheel}
  [2] components 8  triangles 1772  materials {black, wheel}
  [3] components 8  triangles 1772  materials {black, wheel}
unassigned `wheel` material components: none
wheel triangles 7088 of 25816 in the asset
```

Per wheel that is:

| Part | Material | Components | Triangles |
| --- | --- | --- | --- |
| Rim / hubcap face | `wheel` | 1 | 970 |
| Tyre | `black` | 1 | 754 |
| Wheel nuts | `black` | 6 | 8 each, 48 |

A wheel therefore spans **two materials**, which is why the extraction emits one mesh per
(wheel, source material) rather than one mesh per wheel.

The `wheel` material mesh is 3,880 triangles and all four rims account for all of it, so
after extraction that mesh is empty and is removed from the scene. The `black` mesh keeps
748 of its 3,956 triangles (lamp housings, side rubbing strips, the front and rear aprons).

### What the split costs in draw calls

```
draw calls: 14 meshes without the interior, 1 emptied by the split, 8 added (2 materials x 4 wheels) -> 21 (+7)
```

**Seven more draw calls for the shell.** This is a cost of the wheel animation, not a
result of any optimisation work, and it is recorded here so it is never confused with one.
It is a static, countable change; its effect on frame time on the target device is
**unmeasured** — see the [performance baseline](../performance/2026-09-06-baseline.md),
which has no hardware run behind it.

### Nothing straddles a wheel

```
components that reach into a cylinder without being contained (these are NOT the wheel):
  none
```

The one component that comes close is the wheel arch, `plastic` [1]–[4], centred
(±1.013, 0.664, ∓2.45/2.71) with size (0.554, 0.744, 1.204). It wraps *outside* the tyre,
so no vertex of it is inside a cylinder. It is a body part and it stays with the body —
which is correct, since a wheel arch does not steer and does not turn.

How close is close? The script measures it, because the runtime extraction widens these
cylinders by a tolerance and the margin is the budget for that tolerance:

```
clearance from each cylinder (widened by 0.01 m) to the nearest vertex that is not part of that wheel:
  [0] radius 0.466 -> nearest foreign vertex at 0.513  (clearance 0.048 m, plastic [1])
  [1] radius 0.466 -> nearest foreign vertex at 0.513  (clearance 0.048 m, plastic [3])
  [2] radius 0.466 -> nearest foreign vertex at 0.509  (clearance 0.043 m, plastic [2])
  [3] radius 0.466 -> nearest foreign vertex at 0.509  (clearance 0.043 m, plastic [4])
```

43 mm, against the 10 mm tolerance `busShellWheels.ts` uses — a fourfold margin, and one
that fails loudly rather than quietly if a future asset closes it: an arch that reaches
inside a cylinder *straddles* it, and the extraction throws instead of steering a wheel
arch.

## Ruling: the assignment is not ambiguous

The plan's stop rule is "if ambiguous, stop the geometry change and request a named-wheel
re-export; retain the procedural fallback." It does not apply here. Four independent
things agree:

1. The asset names the rim material `wheel`. That is the author's own label, not an
   inference.
2. Exactly four hubs are found, arranged as a symmetric two-axle layout.
3. All four claim an identical component count, triangle count and material set.
4. No component anywhere in the asset partially overlaps a wheel cylinder — the split is
   clean, not a judgement call about where to cut.

The bootstrap note's account of this asset was pessimistic:

> The asset's rims and tyres are spread across meshes shared with every other white and
> black part of the body, so they cannot be split out the way the Saab's axles could

Half right. The tyres *are* in the shared `black` mesh with the lamp housings and the
rubbing strips, and the Saab's whole-geometry axis-gap split (`splitGeometryAlongAxis`)
would indeed have cut that mesh into nonsense — the plan is right to forbid it. But the
rims are in a mesh of their own, and connected components plus a measured cylinder
separate the tyres from their mesh-mates cleanly.

## Manual inspection: UNVERIFIED

The plan's second checkbox asks for the assignments to be confirmed by eye in the model
authoring tools. **This was not done.** The implementation worktree is headless: there is
no browser to open the author panel in, and `vendor/three-editor-r185` is a runtime fetch
that this project deliberately does not commit.

What replaces it is stricter than eyeballing, and is worth stating plainly so nobody reads
this as the same thing:

- The requirement "all tyre/rim parts and no body/trim triangles in a wheel" is checked
  exhaustively by the script, over every component of every mesh, rather than sampled by
  eye. The "straddles" report is the check for body triangles leaking in, and it is empty.
- The runtime extraction re-derives the same assignment from the same constants at load
  time and **throws** if the asset does not produce exactly four wheels, each with both a
  rim and a tyre, or if any component straddles a cylinder. A silently wrong split cannot
  reach the screen; it falls back to the full procedural bus.

What is genuinely not covered, and should be looked at by a human on hardware before this
is called finished:

- Whether the wheels *look* right in motion — no z-fighting against the arches, no visible
  seam where the rim meets the tyre, and the bolts turning with the wheel rather than
  strobing.
- Whether the wheels sit convincingly in the arches at full suspension travel and full
  lock, given that the visual track (2.212 m) is 0.17 m wider than the sheet's.
- The draw-call cost of the eight new meshes on the target device.

## Reproducing

```
node scripts/inspect-bus-glb.mjs                 # src/models/bus1.glb
node scripts/inspect-bus-glb.mjs path/to/other.glb
```

Output is deterministic — components are reported by material, then descending triangle
count, then centre — so two runs diff cleanly and an asset change is visible as a diff.
