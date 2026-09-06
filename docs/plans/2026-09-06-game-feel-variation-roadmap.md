# Game Feel, Variation, and UI Cohesion Roadmap

Date: 2026-09-06

Status: recommendations; each implementation slice needs its own acceptance notes.

## North star

Svartaksi is strongest when it feels like a slightly uncanny Swedish journey rather than a
technical city viewer. The streamed OSM city, Saab, bus route, phone, dog, horse, blob,
forest rave, and changing light already supply the raw material. The next work should make
those systems notice one another, respond with consistent feedback, and reveal themselves
only when useful.

The intended play rhythm is: **understand the immediate situation, enjoy the act of moving,
notice something unexpected, make a small choice, and see that choice echoed later.**

## P0 — Establish a feel and frame-pacing gate

Before adding content, perform one target-device pass using the documented performance
capture protocol and a controller/keyboard/touch feel sheet. Record three repeatable runs:
quiet exterior, a fixed bus segment, and one world-stream boundary. Also score steering,
braking, camera comfort, prompt legibility, and overlay interruption on a simple 1–5 scale.

Use that evidence to set budgets, not blanket quality cuts:

- world publication must not introduce a visible hitch above the agreed frame-time budget;
- an overlay should respond on the input frame and never leave driving input stuck;
- entering/exiting a vehicle must preserve a predictable camera and control state;
- automatic render scaling must be reported beside frame time so lower resolution cannot
  masquerade as an engine improvement.

Do not start the planned roadside-loop conversion until a stream-boundary trace identifies
that work. Keep the optional camera extraction as maintainability work unless allocations
show it matters.

## P1 — Make every vehicle input feel answered

Create a single `DrivingFeedbackState` derived from existing physics values: speed, engine
load, longitudinal/lateral slip, braking, surface kind, suspension compression, and recent
impact. Let camera, sound, particles, controller vibration, and HUD consume it; none of
those presentation systems should invent separate vehicle physics.

First thin slice:

- ease steering sensitivity with speed while preserving direct low-speed manoeuvring;
- add a small configurable camera look-ahead into turns and a separately configurable
  impact impulse, with reduced-motion disabling both;
- acknowledge traction loss, hard braking, indicators, doors, and surface changes with
  restrained sound and visual feedback;
- add input buffering only to discrete actions such as enter/exit, phone, doors, and camera
  mode—never to continuous steering or braking;
- make the authored bus wheels the reference for a manual straight/turn/bump/brake check.

The goal is clarity, not spectacle: one physical event should produce one coordinated,
short response across systems.

## P1 — Give the city a deterministic variation director

Add a seeded `CityMood` chosen per session or trip. It should select compatible values from
existing systems instead of spawning arbitrary randomness: time-of-day band, cloud/light
character, traffic and pedestrian temperament, occupied-window pattern, prop palette, and
the likelihood of small events. The same seed plus location must reproduce the same result
for tests and debugging.

Start with four sharply readable moods—quiet dawn, ordinary afternoon, wet evening, and
strange midnight—and keep every mood playable. Variation should change texture and
decision pressure, not basic controls or collision rules.

Add location-seeded micro-events with cooldowns and a recent-history bag so repeats cannot
cluster: a missed passenger waving at a bus, roadworks narrowing one lane, an animal near a
forest edge, a stalled car, a late-night pickup, or a cryptic phone lead. Each event needs a
clean expiry path when its world chunk unloads.

## P1 — Turn existing oddities into connected journeys

Use the phone and notes as a lightweight journey composer. Offer two or three leads, not a
quest log full of markers. A lead can combine destination, time window, vehicle preference,
and a tone such as helpful, curious, or risky. Reuse the dog, horse, blob, rave, camp, bus,
and Saab in different combinations rather than multiplying isolated minigames.

The clever payoff is delayed recognition: helping someone changes a later text, a bus
destination display, a passenger line, or a prop at a familiar location. Store only small,
stable facts in the story engine so consequences survive without making the world brittle.
Always include quiet trips with no twist; surprise needs negative space.

## P2 — Replace the control shelf with a context ribbon

The current action row exposes world, map, bus, inspect, phone, random place, vehicle, and
fullscreen controls together. Replace its player-facing form with a priority-based context
ribbon that shows at most three actions:

1. the action available here and now (`Enter Saab`, `Board bus`, `Talk`, `Inspect`);
2. one persistent navigation action (`Phone` or `Map`);
3. a compact overflow for settings and low-frequency actions.

Developer actions stay behind the existing development mode. Prompts should use the
player's current input glyphs, disappear while irrelevant, and briefly explain a newly
available action once. Keep keyboard shortcuts working even when their buttons are hidden.

Give every overlay the same grammar: common title/back/close placement, focus restoration,
escape behavior, pause/input-capture policy, spacing scale, and transition duration. The
phone may keep its 1997 character, but it should still obey that grammar. Map, bus map,
settings, notes, and phone should feel like members of one deliberately designed family.

## P2 — Build a quiet but complete audio language

If the current audio audit confirms no reusable foundation, introduce one small mixer with
master, vehicle, world, voice, and UI buses plus mute-on-background behavior. Build variation
from layers rather than many bespoke tracks:

- engine pitch/load, tyre surface, wind, suspension, indicator, transmission, and bus doors;
- neighbourhood beds driven by density, time, weather, and distance from roads/forest;
- short UI sounds sharing one material palette, with no sound for routine hover noise;
- sparse musical stems reserved for discoveries and story transitions.

Cap simultaneous emitters, pool positional sources, and make audio settings accessible
before shipping content. Audio should be validated with headphones and laptop speakers.

## P2 — Spend performance work where the captures point

Use this order after the hardware baseline:

1. If scheduler slices dominate stream-boundary spikes, implement the already-planned
   incremental roadside placement with frozen ordering and cancellation tests.
2. If renderer calls dominate, inspect repeated props/building materials for instancing or
   batching without changing stable placement or selection behavior.
3. If CPU visibility selection dominates, design a bounded spatial query that preserves the
   nearest cap and original-order ties.
4. If allocation traces identify camera or mailbox churn, apply the scoped scratch-object
   or job-local obstacle changes already described in the performance plan.
5. Treat bundle chunk warnings as startup/network work, not frame-time evidence; split the
   authoring tools and infrequent overlays only after checking the loading waterfall.

Never combine a quality reduction with an algorithmic candidate in the same comparison.

## Suggested delivery slices

1. **Feel baseline:** target-device captures plus the manual vehicle/UI scorecard.
2. **Feedback spine:** `DrivingFeedbackState`, surface/indicator/door audio, reduced-motion
   camera response, and a manual bus-wheel inspection.
3. **Context ribbon:** player actions capped at three, unified overlay lifecycle, input-glyph
   hints, and developer controls removed from ordinary play.
4. **Four city moods:** deterministic presets, recent-history variation bag, one micro-event
   type, and unload cleanup tests.
5. **Connected journey pilot:** three reusable leads with at least one delayed consequence
   and one deliberately uneventful route.
6. **Measured performance candidate:** exactly one bottleneck from a real capture, shipped
   only with paired results and unchanged visual/correctness checks.

## Definition of “well put together”

A slice is done when a first-time player can tell what to do without seeing developer
controls; every accepted input receives timely and consistent feedback; overlays never
fight vehicle controls; repeated trips differ without feeling random; accessibility options
cover motion, audio, text, and input; stable seeds still reproduce bugs; and target-device
captures show that new polish stays inside the chosen frame and memory budgets.
