/**
 * Frame-time-adaptive render budget: watches a rolling average frame time and, when
 * it's sustainedly slow, produces a 0..1 scale the renderer pulls its
 * building-related caps inward by (facade instance count, building draw distance,
 * street-light count — see threeWorld.ts's setRenderBudgetScale). Scales back up once
 * frame time recovers. This sits *below* the user's chosen RENDER_QUALITY tier: it
 * only ever narrows what that tier allows, never widens past it — scale 1 reproduces
 * the tier exactly.
 *
 * Deliberately asymmetric hysteresis (react to slowness in under a second, only
 * restore after several seconds of headroom) — stepping back up too eagerly would
 * flap the instance count right back into the slowdown that triggered the step down.
 */
export interface RenderBudget {
  /** Feed one frame's delta time in seconds. Returns true if the scale changed. */
  sample(dtSeconds: number): boolean;
  getScale(): number;
}

/** Rolling window size (frames) the average frame time is computed over — long enough
 * to ignore a single stall (a GC pause, a one-off geometry rebuild) but short enough
 * to react to a real sustained slowdown within about half a second at 60fps. */
const SAMPLE_WINDOW = 30;
/** Below ~45fps on average, we're meaningfully behind; above ~55fps there's clear
 * headroom to restore. The gap between the two (not one shared threshold) is what
 * stops the scale from oscillating right at the boundary. */
const STEP_DOWN_FRAME_MS = 1000 / 45;
const STEP_UP_FRAME_MS = 1000 / 55;
/** Consecutive *sampled* (not necessarily consecutive real) frames the rolling average
 * must stay past a threshold before the scale actually moves. */
const STEP_DOWN_AFTER = 45;
const STEP_UP_AFTER = 180;
const MIN_SCALE = 0.35;
const SCALE_STEP = 0.15;

export function createRenderBudget(): RenderBudget {
  const samples: number[] = [];
  let sum = 0;
  let scale = 1;
  let slowStreak = 0;
  let fastStreak = 0;

  return {
    sample(dtSeconds) {
      const ms = Math.max(0, dtSeconds) * 1000;
      samples.push(ms);
      sum += ms;
      if (samples.length > SAMPLE_WINDOW) sum -= samples.shift()!;
      const average = sum / samples.length;

      if (average > STEP_DOWN_FRAME_MS) {
        slowStreak += 1;
        fastStreak = 0;
      } else if (average < STEP_UP_FRAME_MS) {
        fastStreak += 1;
        slowStreak = 0;
      } else {
        slowStreak = 0;
        fastStreak = 0;
      }

      if (slowStreak >= STEP_DOWN_AFTER && scale > MIN_SCALE) {
        scale = Math.max(MIN_SCALE, scale - SCALE_STEP);
        slowStreak = 0;
        return true;
      }
      if (fastStreak >= STEP_UP_AFTER && scale < 1) {
        scale = Math.min(1, scale + SCALE_STEP);
        fastStreak = 0;
        return true;
      }
      return false;
    },
    getScale: () => scale,
  };
}
