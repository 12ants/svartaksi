/**
 * Runs one long build in slices small enough to fit inside a frame.
 *
 * Rebuilding the world (threeWorld's `replace`) means generating geometry for every
 * road, park, water body, building, roof and facade in range — hundreds of milliseconds
 * of straight-line main-thread work. Done in one call it stops the render loop dead,
 * which is what the whole game freezing while the world streams ahead of the camera
 * actually was.
 *
 * A build is expressed as a generator that yields at points where it is safe to stop.
 * The scheduler advances it for a millisecond budget per frame and returns, so the
 * frame still renders; the build simply lands a few frames later. Geometry construction
 * is pure CPU work with no DOM or GPU dependency in the middle, so slicing it costs
 * nothing but the bookkeeping here — this is deliberately not a worker, since the
 * result is Three.js objects that have to be built on the thread that owns the scene.
 *
 * Only one build runs at a time. Starting another cancels the one in flight, which runs
 * that generator's `finally` and lets it dispose whatever it had staged.
 */

/** A sliceable build. Yields at each point it is safe to pause. */
export type BuildJob = Generator<void, void, void>;

export interface BuildScheduler {
  /** Cancels any build in flight and makes `job` the active one. */
  start(job: BuildJob): void;
  /** Advances the active build for up to `budgetMs`. Returns true if work remains. */
  pump(budgetMs: number): boolean;
  /** Slices completed since the active build started, reset by `start`. A build's own
   * estimate of how many slices it will take turns this into a progress fraction — the
   * only honest signal available, since a generator cannot report its own length. */
  stepsRun(): number;
  /** Runs the active build straight through, blocking. For callers that need the
   * result now (the first world load, which is behind a loading screen anyway) and
   * for tests. */
  flush(): void;
  cancel(): void;
  isBusy(): boolean;
  diagnostics(): BuildSchedulerDiagnostics;
}

/**
 * Upper bound (ms) of each slice-duration bucket, tied to what a slice costs the frame
 * it lands in rather than round numbers: half and a full 60fps frame, half and a full
 * 30fps frame, then "conspicuously janky" and "the old 14s freeze this replaced". The
 * last bucket is implicitly "worse than the final bound".
 */
export const SLICE_HISTOGRAM_BOUNDS_MS = [8, 16, 33, 50, 100, 250] as const;

/** Timing and completion state for the scheduler's current (or most recent) job. */
export interface BuildSchedulerDiagnostics {
  generationId: number;
  finishedSlices: number;
  worstSliceMs: number;
  elapsedMs: number;
  complete: boolean;
  replacementCount: number;
  /** Slice counts per bucket in `SLICE_HISTOGRAM_BOUNDS_MS`, plus one trailing bucket
   * for slices slower than the last bound. Always `SLICE_HISTOGRAM_BOUNDS_MS.length + 1`
   * entries. A single worst-case number can't tell "one outlier" from "every slice is
   * slow" apart; this can. */
  sliceHistogram: number[];
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export function createBuildScheduler(now: () => number = defaultNow): BuildScheduler {
  let active: BuildJob | null = null;
  let steps = 0;
  let generationId = 0;
  let startedAtMs = 0;
  let endedAtMs = 0;
  let worstSliceMs = 0;
  let complete = true;
  let replacementCount = 0;
  let sliceHistogram = new Array<number>(SLICE_HISTOGRAM_BOUNDS_MS.length + 1).fill(0);

  const durationSince = (fromMs: number, toMs: number) =>
    Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.max(0, toMs - fromMs) : 0;
  const elapsedMs = () => durationSince(startedAtMs, complete ? endedAtMs : now());
  const bucketFor = (durationMs: number) => {
    const index = SLICE_HISTOGRAM_BOUNDS_MS.findIndex((bound) => durationMs <= bound);
    return index === -1 ? SLICE_HISTOGRAM_BOUNDS_MS.length : index;
  };
  const step = (job: BuildJob) => {
    const sliceStartedAtMs = now();
    const result = job.next();
    const sliceMs = durationSince(sliceStartedAtMs, now());
    worstSliceMs = Math.max(worstSliceMs, sliceMs);
    sliceHistogram[bucketFor(sliceMs)] += 1;
    return result;
  };

  /** Ends the active job's own bookkeeping. Reads `active` fresh rather than closing
   * over a captured job so a job that finished during a nested call can't clear a
   * newer one. */
  const finish = (job: BuildJob) => {
    if (active !== job) return;
    active = null;
    complete = true;
    endedAtMs = now();
  };

  return {
    start(job) {
      const previous = active;
      if (previous) replacementCount += 1;
      // A cancelled generator runs its finally synchronously. Finish that old work before
      // the new generation's clock starts, or cleanup time looks like new build time.
      previous?.return();
      active = job;
      steps = 0;
      generationId += 1;
      startedAtMs = now();
      endedAtMs = startedAtMs;
      worstSliceMs = 0;
      sliceHistogram = new Array<number>(SLICE_HISTOGRAM_BOUNDS_MS.length + 1).fill(0);
      complete = false;
    },

    pump(budgetMs) {
      const job = active;
      if (!job) return false;
      const deadline = now() + Math.max(0, budgetMs);
      try {
        // At least one slice per pump, whatever the budget: a zero or already-spent
        // budget must still make progress, or a slow frame stalls the build forever.
        do {
          if (step(job).done) {
            finish(job);
            return false;
          }
          steps += 1;
        } while (now() < deadline);
      } catch (error) {
        finish(job);
        throw error;
      }
      return true;
    },

    flush() {
      const job = active;
      if (!job) return;
      try {
        while (!step(job).done) steps += 1;
      } finally {
        finish(job);
      }
    },

    stepsRun() {
      return steps;
    },

    cancel() {
      const job = active;
      if (!job) return;
      active = null;
      complete = true;
      endedAtMs = now();
      job.return();
    },

    isBusy() {
      return active !== null;
    },

    diagnostics() {
      return {
        generationId,
        finishedSlices: steps,
        worstSliceMs,
        elapsedMs: elapsedMs(),
        complete,
        replacementCount,
        sliceHistogram: [...sliceHistogram],
      };
    },
  };
}
