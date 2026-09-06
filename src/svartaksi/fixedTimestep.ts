/**
 * Decouples simulation rate from render rate: how many fixed-size physics ticks a
 * variable-length real frame is owed, given how much simulated time is still banked
 * from previous frames.
 *
 * Catch-up is bounded rather than exhaustive — a multi-second stall (a backgrounded
 * tab, a GC pause) would otherwise demand hundreds of ticks in one frame, each one
 * pushing the next frame later still. Past `maxSteps` the remainder is dropped instead
 * of carried forward, so a stall costs the world some simulated time rather than
 * cascading into a worse and worse backlog ("spiral of death").
 */
export function accumulateFixedSteps(
  rawDelta: number,
  previousAccumulator: number,
  fixedDt: number,
  maxSteps: number,
): { steps: number; accumulator: number } {
  let accumulator = previousAccumulator + Math.max(0, rawDelta);
  let steps = 0;
  while (accumulator >= fixedDt && steps < maxSteps) {
    accumulator -= fixedDt;
    steps += 1;
  }
  if (steps >= maxSteps) accumulator = 0;
  return { steps, accumulator };
}
