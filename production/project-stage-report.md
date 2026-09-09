# Project Stage Analysis Report

**Generated**: 2026-09-09
**Stage**: Production
**Analysis Scope**: Full project

---

## Executive Summary

SVARTAKSI is a mature, healthy codebase carrying no design paper trail. The
implementation is substantial (184 source files, ~35k LOC across ten subsystems)
and its quality gate is fully green: `pnpm test:all` passes lint, typecheck, and
1476 tests across 145 test files. The engine is pinned and its version drift from
LLM training data is documented. By any code-based measure this is a project in
Production.

The tracked stage said `Concept`. That was wrong by five stages and is corrected
to `Production` by this report. The discrepancy is the single most important
finding: every skill that reads `stage.txt` to decide what is appropriate — gate
checks, sprint planning, readiness reviews — has been operating on a false premise.

The real gap is documentation, not code. `design/` contains no GDDs and
`docs/architecture/` contains no ADRs; both directories hold only unedited
template stubs whose header comments describe rules no entry has ever followed.
The code was written directly, and it was written well — the house style of
justified constants and pure, tested arithmetic modules is visible throughout —
but nothing records *why* the systems are shaped the way they are.

**Current Focus**: Performance work and game-feel variation, per `docs/plans/`.
**Blocking Issues**: None blocking code work. Documentation absence blocks any
skill that reads GDDs or ADRs as input.
**Estimated Time to Next Stage**: Not applicable — Polish is an explicit gate set
by `/gate-check`, and that gate cannot pass without design docs to check against.

---

## Completeness Overview

### Design Documentation
- **Status**: ~0% complete
- **Files Found**: 1 document in `design/` (plus one registry stub)
  - GDD sections: 0 files — `design/gdd/` does not exist
  - Narrative docs: 0 files — `design/narrative/` does not exist
  - Level designs: 0 files — `design/levels/` does not exist
  - `design/registry/entities.yaml`: 168 lines, **all header comment, zero entries**
- **Key Gaps**:
  - [ ] No GDD for any shipped system. The eight required design sections
        (Overview, Player Fantasy, Detailed Rules, Formulas, Edge Cases,
        Dependencies, Tuning Knobs, Acceptance Criteria) exist for nothing.
  - [ ] No game concept or pillars doc, so there is no written statement of what
        the game is trying to feel like — which makes "is this change on-vision?"
        unanswerable except by the author's memory.
  - [ ] Entity registry unpopulated, so `/consistency-check` has no baseline and
        cross-document contradiction detection is inert.

### Source Code
- **Status**: Substantial and healthy
- **Files Found**: 184 source files in `src/`, ~35,210 lines
- **Major Systems Identified**:
  - ✅ `src/svartaksi/` (63 files) — runtime frame loop, vehicles, characters, config
  - ✅ `src/world/` (55 files) — OSM ingestion, terrain, facades, roads, streaming
  - ✅ `src/components/` (19 files) — React HUD and overlays
  - ✅ `src/author/` (16 files) — in-browser authoring tools, separate Vite entry
  - ✅ `src/physics/` (13 files) — bespoke rigid body, raycast vehicle, character controller
  - ✅ `src/hooks/` (5 files) — React hooks around the canvas
  - ✅ `src/story/` (5 files) — flag store and declarative trigger/quest engine
  - ✅ `src/performance/` (3 files) — metrics capture
- **Key Gaps**:
  - [ ] `svartaksiRuntime.tsx` is ~4.2k lines in one file. It is coherent and the
        boundary it presents is clean, but it is the one place where a change is
        hard to review in isolation.
  - [ ] 3 TODOs referencing `docs/TODO.md` (water polygon cutting, freecam look
        speed, horse body kinematics) — all documented rather than silent.

### Architecture Documentation
- **Status**: ~0% complete
- **ADRs Found**: 0 decisions documented in `docs/architecture/`
  - `docs/architecture/tr-registry.yaml`: 56 lines, **all header comment, zero entries**
- **Coverage**:
  - ⚠️  Bespoke physics over a third-party engine — implemented, deliberate per
        CLAUDE.md, undocumented as a decision record
  - ⚠️  Single imperative runtime factory behind a setter/callback boundary —
        implemented, undocumented
  - ⚠️  Two-app split at the Vite entry points — implemented, undocumented
  - ⚠️  No browser/e2e layer, unit tests only — a deliberate and unusual choice,
        stated in CLAUDE.md but with no ADR recording the tradeoff
  - ⚠️  OSM streaming pipeline with committed offline cache — implemented, undocumented
- **Key Gaps**:
  - [ ] Every one of the five decisions above is load-bearing and reversible only
        at great cost. None has a record of what was traded away. This is the
        highest-value documentation to write, because it is the knowledge most
        likely to be lost and most expensive to rediscover.
  - [ ] TR registry unpopulated, so `/create-stories` has no stable requirement
        IDs to embed and story traceability cannot function.

### Production Management
- **Status**: ~15% complete
- **Found**:
  - Sprint plans: 0 — `production/sprints/` does not exist
  - Milestones: 0 — `production/milestones/` does not exist
  - Roadmap: Partial — `docs/plans/` holds six dated planning documents
  - Session logs: `production/session-logs/session-log.md`, actively maintained
  - `production/session-state/active.md`: **missing**, though CLAUDE.md names it
    the primary file-backed state strategy
- **Key Gaps**:
  - [ ] No `active.md`, so the documented crash/compaction recovery path has
        nothing to recover from. Session logs record what *happened*; they do not
        record what is *in progress*.
  - [ ] Planning lives in `docs/plans/` rather than `production/`, so production
        skills do not find it.

### Testing
- **Status**: Strong — 145 test files against 184 source files
- **Test Files**: 145 in `tests/`, ~20,526 lines, 1476 tests, all passing
- **Coverage by System** (test files vs. source files, a structural proxy):
  - `svartaksi`: 57 / 63 — excellent
  - `world`: 47 / 55 — excellent
  - `story`: 8 / 5 — excellent
  - `physics`: 9 / 13 — good
  - `performance`: 3 / 3 — complete
  - `author`: 10 / 16 — moderate
  - `components`: 6 / 19 — thin, expected given the no-WebGL policy
  - `hooks`: 2 / 5 — thin
- **Key Gaps**:
  - [ ] `components/` and `hooks/` are the thinnest areas. This is largely by
        design — the testing policy excludes anything needing a WebGL context —
        but some HUD logic is probably pure enough to test and currently isn't.

### Prototypes
- **Active Prototypes**: 0 — `prototypes/` does not exist
- **Archived**: 0
- **Key Gaps**:
  - [ ] None. The project went straight to implementation; no undocumented
        experiments are lying around.

---

## Stage Classification Rationale

**Why Production?**

`production/stage.txt` contained `Concept`, which the skill treats as an explicit
override. That value is contradicted by every other signal in the repository and
is therefore treated as stale rather than authoritative.

**Indicators for this stage**:
- 184 source files, far past the 10-file Pre-Production threshold
- Engine configured and pinned (three.js 0.185.1, R3F 9.7.0) with a version
  reference doc and drift warnings
- A green, comprehensive automated test suite — 1476 tests
- Active iterative work on performance and game feel, the characteristic
  activity of Production
- Deployment configured (Cloudflare Pages via `pnpm deploy`)

**Why not Polish?** Polish is set only by an explicit `/gate-check` transition,
and that gate compares implementation against design documents. With zero GDDs
there is nothing to gate against.

**Next stage requirements**:
- [ ] GDDs for the core systems, so acceptance criteria exist to verify against
- [ ] ADRs for the load-bearing technical decisions
- [ ] A populated entity registry and TR registry
- [ ] A `/gate-check` Production → Polish run that returns PASS

---

## Gaps Identified (with Clarifying Questions)

### Critical Gaps (block progress)

1. **Stage tracking was wrong by five stages**
   - **Impact**: Every stage-aware skill has been reasoning from a false premise.
     A skill asking "is this appropriate at Concept?" gives useless answers to a
     project in Production.
   - **Question**: Resolved — corrected to `Production` in this pass.
   - **Suggested Action**: Done. Re-run any skill whose earlier output was
     shaped by the wrong stage.

2. **No architecture decision records for five load-bearing choices**
   - **Impact**: Bespoke physics, the runtime factory boundary, the two-app split,
     the no-e2e policy, and the OSM streaming design are all expensive to reverse
     and undocumented as decisions. CLAUDE.md states *what* they are; nothing
     states what was traded away or what would justify revisiting them.
   - **Question**: Which of these were genuine decisions with alternatives
     weighed, and which were simply how it got built? The former deserve ADRs;
     the latter deserve a shorter note.
   - **Suggested Action**: `/architecture-decision` per decision, or
     `/reverse-document architecture` to draft from the code.

### Important Gaps (affect quality/velocity)

3. **No GDDs for any system**
   - **Impact**: No acceptance criteria, no tuning-knob inventory, no written
     player fantasy. Balance and feel changes have no reference to argue against.
   - **Question**: Is the design carried in your head deliberately — a solo
     project where GDDs would be overhead — or is this a gap you want closed?
     The answer changes whether this is worth doing at all.
   - **Suggested Action**: `/reverse-document design src/[system]`, starting with
     the systems most likely to need tuning arguments (vehicle handling, story).

4. **No `production/session-state/active.md`**
   - **Impact**: CLAUDE.md designates this the primary defence against context
     loss, and it does not exist. Session logs are a history, not a checkpoint.
   - **Question**: Has the session-log-only approach been sufficient in practice?
   - **Suggested Action**: Create `active.md` at the start of the next work session.

5. **Both registries are empty stubs**
   - **Impact**: `/consistency-check`, `/create-stories`, and `/story-readiness`
     silently do nothing useful without entries.
   - **Question**: Worth populating, or should these skills be considered unused
     on this project?
   - **Suggested Action**: Populate as a side effect of writing GDDs and ADRs.

### Nice-to-Have Gaps (polish/best practices)

6. **Planning docs live outside `production/`**
   - **Impact**: Six useful planning documents in `docs/plans/` are invisible to
     production skills.
   - **Question**: Move them, or is `docs/plans/` the intended home?
   - **Suggested Action**: Either relocate, or note the convention in CLAUDE.md.

7. **`svartaksiRuntime.tsx` is ~4.2k lines**
   - **Impact**: The boundary it exposes is clean, so this is a reviewability
     concern rather than an architectural one.
   - **Question**: Has it become painful to work in, or is it fine in practice?
   - **Suggested Action**: Extract only if it is actually hurting; splitting a
     working coherent file for its own sake is churn.

---

## Recommended Next Steps

### Immediate Priority (Do First)
1. **Correct the tracked stage** — unblocks correct behaviour in every stage-aware skill
   - Done in this pass
   - Estimated effort: S

2. **Write ADRs for the five load-bearing decisions** — this is the knowledge most
   at risk of being lost, and the most expensive to reconstruct from code alone
   - Suggested skill: `/architecture-decision` or `/reverse-document architecture`
   - Estimated effort: M

### Short-Term (This Sprint/Week)
3. **Decide whether GDDs are wanted at all** — a real decision, not a formality;
   if the design is deliberately held informally, say so in CLAUDE.md and stop
   treating it as a gap
4. **Create `production/session-state/active.md`** — cheap, and CLAUDE.md already
   depends on it

### Medium-Term (Next Milestone)
5. **Reverse-document the highest-churn systems** — vehicle handling and story
   are where tuning arguments will need a written reference
6. **Populate the registries** as GDDs and ADRs land, rather than as a separate pass

---

## Follow-Up Skills to Run

- `/architecture-decision` — for each of the five undocumented decisions
- `/reverse-document design src/svartaksi` — for the vehicle and character systems
- `/reverse-document architecture` — to draft ADRs from existing code
- `/sprint-plan` — if production planning moves into `production/`
- `/gate-check` — once GDDs exist, to test the Production → Polish transition

---

## Appendix: File Counts by Directory

```
design/
  gdd/           0 files (directory absent)
  narrative/     0 files (directory absent)
  levels/        0 files (directory absent)
  registry/      1 file  (stub, 0 entries)

src/                     184 files, ~35,210 lines
  svartaksi/     63 files
  world/         55 files
  components/    19 files
  author/        16 files
  physics/       13 files
  hooks/          5 files
  story/          5 files
  performance/    3 files
  models/         1 file
  test/           1 file

docs/
  architecture/  0 ADRs (1 stub registry, 0 entries)
  plans/         6 planning documents
  engine-reference/ 4 files

production/
  sprints/       0 plans (directory absent)
  milestones/    0 definitions (directory absent)
  session-logs/  1 file

tests/           145 test files, ~20,526 lines, 1476 tests (all passing)
prototypes/      0 directories (absent)
```

---

**End of Report**

*Generated by `/project-stage-detect` skill*
