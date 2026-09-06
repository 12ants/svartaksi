import { useEffect, useState } from 'react';
import type { RuntimeStatus } from '../svartaksi/svartaksiRuntime';
import { pickLoadingVerse } from '../svartaksi/loadingPoetry';

/** How long one verse stays up. Long enough to read four lines twice, short enough
 * that a slow load is not the same four lines the whole way through. */
const VERSE_ROTATION_MS = 9_000;

/** Progress fraction (of the initial-load curtain) past which the backdrop starts
 * fading to transparent, so the reveal is a late flourish rather than something
 * visible through most of the load. */
const CURTAIN_FADE_START = 0.85;

function LoadingVerse() {
  const [seed, setSeed] = useState(() => Math.random());
  useEffect(() => {
    const timer = window.setInterval(() => setSeed(Math.random()), VERSE_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, []);
  const verse = pickLoadingVerse(seed);
  return (
    // Keyed by title so React replaces the block outright and the fade-in animation
    // restarts, rather than diffing four lines of text in place with no transition.
    <blockquote key={verse.title} className="loading-verse" aria-hidden="true">
      {verse.lines.map((line) => <span key={line}>{line}</span>)}
    </blockquote>
  );
}

export function WorldLoading({
  status,
  onRetry,
}: {
  status: RuntimeStatus;
  onRetry: () => void;
}) {
  if (status.phase === 'ready') return null;
  const fraction = Math.min(1, Math.max(0, status.progress));
  const percent = Math.round(fraction * 100);

  if (status.phase === 'error') {
    return (
      <div className="world-curtain">
        <div className="world-curtain-backdrop" aria-hidden="true" />
        <section className="world-load-error" role="alert" aria-label="World load failed">
          <strong>WORLD LOAD FAILED</strong>
          <span>{status.message}</span>
          {status.retryable && (
            <button type="button" aria-label="Retry world load" onClick={onRetry}>Retry</button>
          )}
        </section>
      </div>
    );
  }

  if (status.mode !== 'initial') {
    return (
      <section
        className="world-stream-progress"
        role="status"
        aria-label="Streaming world"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <strong>{status.message}</strong>
        {status.details?.map(detail => <span key={detail}>{detail}</span>)}
        <progress value={percent} max={100}>{percent}%</progress>
      </section>
    );
  }

  // Only the last slice of progress fades the backdrop, so the reveal reads as the
  // curtain finishing rather than as translucent the whole way through.
  const fadeFraction = Math.max(0, (fraction - CURTAIN_FADE_START) / (1 - CURTAIN_FADE_START));
  const backdropOpacity = 1 - fadeFraction;

  return (
    <div className="world-curtain">
      <div className="world-curtain-backdrop" style={{ opacity: backdropOpacity }} aria-hidden="true" />
      <LoadingVerse />
      <section
        className="world-loading-progress"
        role="status"
        aria-label="Loading world"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <strong>{status.message}</strong>
        {status.details?.map(detail => <span key={detail}>{detail}</span>)}
        <progress value={percent} max={100}>{percent}%</progress>
      </section>
      <span className="loading-build" aria-hidden="true">{__BUILD_TIME__}</span>
    </div>
  );
}
