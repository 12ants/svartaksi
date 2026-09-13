# Systems Index: SVARTAKSI

> **Status**: Draft
> **Created**: 2026-09-13
> **Last Updated**: 2026-09-13

---

## Overview

SVARTAKSI is a driving game about a black taxi in a real city streamed from OpenStreetMap.
Its systems divide cleanly into three groups: the **world** (turning OSM vector tiles into
terrain, roads, facades and props, streamed as the player moves), the **simulation** (this
project's own rigid-body solver, a raycast vehicle, and a character controller), and the
**game** on top of those (the taxi, the bus rides, the story flags and the phone).

This index is being built retroactively. The codebase substantially predates any GDD, so
most systems below are implemented and undocumented; rows are added here as their design
docs are written rather than all at once. A row with `—` for its design doc is a system
that exists in `src/` and has no written design, not a system that does not exist.

---

## Systems Enumeration

| # | System Name | Category | Priority | Status | Design Doc | Depends On |
|---|-------------|----------|----------|--------|------------|------------|
| 1 | Opening Cinematic | Presentation | MVP | Implemented | [design/gdd/opening-cinematic.md](opening-cinematic.md) | World Streaming, Bus Ride, Camera, Time of Day |
| 2 | World Streaming (inferred) | Foundation | MVP | Implemented | — | — |
| 3 | Physics & Raycast Vehicle (inferred) | Foundation | MVP | Implemented | — | World Streaming |
| 4 | Camera (inferred) | Core | MVP | Implemented | — | Physics & Raycast Vehicle |
| 5 | Bus Ride (inferred) | Feature | MVP | Implemented | — | World Streaming, Physics |
| 6 | Character Controller (inferred) | Core | MVP | Implemented | — | Physics |
| 7 | Story & Phone (inferred) | Feature | MVP | Implemented | — | — |
| 8 | Time of Day & Lighting (inferred) | Presentation | MVP | Implemented | — | World Streaming |

---

## Categories

- **Foundation** — the world and the solver everything else stands on
- **Core** — what the player directly operates: camera, vehicle, character
- **Feature** — discrete gameplay: bus rides, story beats, the phone
- **Presentation** — what the player sees and hears rather than operates
- **Polish** — tuning and feel passes over any of the above

## Priority Tiers

- **MVP** — required for the game to be playable at all
- **Target** — wanted for the shipping build
- **Stretch** — desirable, cuttable

---

## Notes

Only system 1 has a design document. It was written alongside its implementation
(`docs/architecture/2026-09-13-opening-cinematic.md` is the matching ADR) rather than ahead
of it, which is the exception this project is working back from, not the pattern to copy.
