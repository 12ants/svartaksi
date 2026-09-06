import { describe, expect, it } from 'vitest';

import { createBuildScheduler, SLICE_HISTOGRAM_BOUNDS_MS } from '../../src/world/buildScheduler';

/** A build that records how far it got and whether it was cleaned up. */
function countingJob(steps: number, log: { done: number; cleaned: boolean }) {
  return (function* job() {
    try {
      for (let index = 0; index < steps; index += 1) {
        log.done += 1;
        yield;
      }
    } finally {
      log.cleaned = true;
    }
  })();
}

describe('build scheduler', () => {
  it('spreads a build over several pumps instead of running it all at once', () => {
    let clock = 0;
    const scheduler = createBuildScheduler(() => clock);
    let done = 0;
    // Every slice costs 1ms of the fake clock, so a 3ms budget buys three of them.
    scheduler.start((function* job() {
      for (let index = 0; index < 9; index += 1) {
        done += 1;
        clock += 1;
        yield;
      }
    })());

    expect(scheduler.pump(3)).toBe(true);
    expect(done).toBe(3);
    expect(scheduler.pump(3)).toBe(true);
    expect(done).toBe(6);
    expect(scheduler.pump(3)).toBe(true);
    expect(done).toBe(9);
    // The last slice is done but the generator has not returned yet, so it takes one
    // more pump to observe the build as finished.
    expect(scheduler.pump(3)).toBe(false);
  });

  it('always makes progress even with no budget left', () => {
    const scheduler = createBuildScheduler(() => 0);
    const log = { done: 0, cleaned: false };
    scheduler.start(countingJob(3, log));

    scheduler.pump(0);

    // A zero budget is already spent the moment it is granted. Refusing to step would
    // stall the build forever on a frame that ran long.
    expect(log.done).toBe(1);
  });

  it('reports idle and stops stepping once the build finishes', () => {
    const scheduler = createBuildScheduler(() => 0);
    const log = { done: 0, cleaned: false };
    scheduler.start(countingJob(2, log));

    expect(scheduler.pump(0)).toBe(true);
    expect(scheduler.pump(0)).toBe(true);
    expect(scheduler.pump(0)).toBe(false);
    expect(scheduler.isBusy()).toBe(false);
    expect(log.done).toBe(2);
    expect(log.cleaned).toBe(true);
  });

  it('runs a build straight through on flush', () => {
    const scheduler = createBuildScheduler(() => 0);
    const log = { done: 0, cleaned: false };
    scheduler.start(countingJob(500, log));

    scheduler.flush();

    expect(log.done).toBe(500);
    expect(scheduler.isBusy()).toBe(false);
  });

  it('cleans up the build it cancels when a new one starts', () => {
    const scheduler = createBuildScheduler(() => 0);
    const first = { done: 0, cleaned: false };
    const second = { done: 0, cleaned: false };
    scheduler.start(countingJob(100, first));
    scheduler.pump(0);

    scheduler.start(countingJob(1, second));

    // The abandoned build's finally is what disposes whatever it had staged — leaking
    // that would leak Three.js geometry on every superseded world stream.
    expect(first.cleaned).toBe(true);
    expect(second.cleaned).toBe(false);

    scheduler.flush();
    expect(second.cleaned).toBe(true);
  });

  it('starts replacement diagnostics after the superseded job finishes cleanup', () => {
    let clock = 10;
    const scheduler = createBuildScheduler(() => clock);
    scheduler.start((function* job() {
      try {
        yield;
      } finally {
        clock += 50;
      }
    })());
    scheduler.pump(0);

    scheduler.start((function* job() { yield; })());

    expect(scheduler.diagnostics()).toMatchObject({
      generationId: 2,
      finishedSlices: 0,
      elapsedMs: 0,
      worstSliceMs: 0,
      complete: false,
      replacementCount: 1,
    });
  });

  it('buckets each slice duration into the histogram, including a trailing overflow bucket', () => {
    // One slice per named bucket in order, then one deliberately past the last bound.
    const durations = [...SLICE_HISTOGRAM_BOUNDS_MS, SLICE_HISTOGRAM_BOUNDS_MS.at(-1)! + 1000];
    let clock = 0;
    const scheduler = createBuildScheduler(() => clock);
    scheduler.start((function* job() {
      for (const durationMs of durations) {
        clock += durationMs;
        yield;
      }
    })());
    scheduler.flush();

    // flush()/pump() both call one extra, ~0ms step to observe generator completion
    // after the last real yield — that lands in the first (fastest) bucket too.
    const expected = new Array(SLICE_HISTOGRAM_BOUNDS_MS.length + 1).fill(1);
    expected[0] += 1;
    expect(scheduler.diagnostics().sliceHistogram).toEqual(expected);
  });

  it('resets the histogram when a new build starts', () => {
    let clock = 0;
    const scheduler = createBuildScheduler(() => clock);
    scheduler.start((function* job() {
      clock += 1000;
      yield;
    })());
    scheduler.flush();
    expect(scheduler.diagnostics().sliceHistogram.some((count) => count > 0)).toBe(true);

    scheduler.start((function* job() { yield; })());

    expect(scheduler.diagnostics().sliceHistogram).toEqual(
      new Array(SLICE_HISTOGRAM_BOUNDS_MS.length + 1).fill(0),
    );
  });

  it('cleans up and goes idle on cancel', () => {
    const scheduler = createBuildScheduler(() => 0);
    const log = { done: 0, cleaned: false };
    scheduler.start(countingJob(100, log));
    scheduler.pump(0);

    scheduler.cancel();

    expect(log.cleaned).toBe(true);
    expect(scheduler.isBusy()).toBe(false);
    expect(scheduler.pump(0)).toBe(false);
  });

  it('goes idle rather than wedging when a build throws', () => {
    const scheduler = createBuildScheduler(() => 0);
    scheduler.start((function* job() {
      yield;
      throw new Error('build failed');
    })());

    scheduler.pump(0);
    expect(() => scheduler.pump(0)).toThrow('build failed');
    expect(scheduler.isBusy()).toBe(false);
  });
});

describe('build scheduler progress', () => {
  it('counts completed slices and resets the count on the next build', () => {
    // A clock that always reads past any deadline, so one pump buys exactly one slice.
    const scheduler = createBuildScheduler(() => Number.POSITIVE_INFINITY);
    const log = { done: 0, cleaned: false };

    expect(scheduler.stepsRun()).toBe(0);
    scheduler.start(countingJob(9, log));
    // Each slice advances the fake clock past a 0ms budget, so one pump buys one slice.
    scheduler.pump(0);
    expect(scheduler.stepsRun()).toBe(1);
    scheduler.pump(0);
    expect(scheduler.stepsRun()).toBe(2);

    scheduler.start(countingJob(3, { done: 0, cleaned: false }));
    expect(scheduler.stepsRun()).toBe(0);
  });

  it('counts the slices a flushed build ran, not just pumped ones', () => {
    const scheduler = createBuildScheduler(() => 0);
    scheduler.start(countingJob(5, { done: 0, cleaned: false }));
    scheduler.flush();

    expect(scheduler.stepsRun()).toBe(5);
    expect(scheduler.isBusy()).toBe(false);
  });
});
