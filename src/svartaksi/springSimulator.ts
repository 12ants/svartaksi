/**
 * A fixed-step spring, ported from Sketchbook's `SpringSimulator`/`SimulatorBase`.
 *
 * Why not a plain lerp: everything the character does around a vehicle — swinging the
 * door open, dropping into the seat, standing back out — is a body accelerating and
 * settling, and a linear interpolation of the same duration reads as a slide. A spring
 * gives the motion an overshoot-free ease-out that starts *slow*, which is what makes a
 * one-second animation look like weight rather than a cut.
 *
 * Why fixed-step: the spring's integrator is the unconditionally-stable-only-at-one-rate
 * kind (velocity += (target - position) / mass, then damped). Feeding it a variable frame
 * time changes the stiffness with the frame rate, so the simulation is stepped at its own
 * fixed rate and the leftover time is carried as an offset, with the reported value
 * interpolated between the last two frames. This is the same reason the rest of the game
 * runs its physics on `fixedTimestep.ts`.
 */

export interface SpringFrame {
  position: number;
  velocity: number;
}

/** One step of the integrator. Pure: the frame in, the next frame out. */
export function springStep(
  frame: SpringFrame,
  target: number,
  mass: number,
  damping: number,
): SpringFrame {
  let velocity = frame.velocity + (target - frame.position) / mass;
  velocity *= damping;
  return { position: frame.position + velocity, velocity };
}

export interface SpringSimulator {
  /** Where the spring is now, interpolated between the last two fixed frames. */
  readonly position: number;
  readonly velocity: number;
  target: number;
  simulate(dt: number): void;
}

/**
 * `fps` is the rate the spring integrates at, and with `mass`/`damping` fixes its feel;
 * the defaults (60, 10, 0.5) are the values Sketchbook uses for every vehicle entry
 * transition, kept so the motion matches the source this was ported from.
 */
export function createSpringSimulator(
  fps = 60,
  mass = 10,
  damping = 0.5,
  startPosition = 0,
  startVelocity = 0,
): SpringSimulator {
  const frameTime = 1 / fps;
  let offset = 0;
  let previous: SpringFrame = { position: startPosition, velocity: startVelocity };
  let latest: SpringFrame = { position: startPosition, velocity: startVelocity };

  const simulator = {
    position: startPosition,
    velocity: startVelocity,
    target: 0,
    simulate(dt: number): void {
      const total = offset + dt;
      const frames = Math.floor(total / frameTime);
      offset = total % frameTime;

      for (let i = 0; i < frames; i += 1) {
        previous = latest;
        latest = springStep(latest, simulator.target, mass, damping);
      }

      const blend = offset / frameTime;
      simulator.position = previous.position + (latest.position - previous.position) * blend;
      simulator.velocity = previous.velocity + (latest.velocity - previous.velocity) * blend;
    },
  };

  return simulator;
}

/** Sketchbook's easing for the body's travel along the entry path. */
export function easeInOutSine(x: number): number {
  return -(Math.cos(Math.PI * x) - 1) / 2;
}
