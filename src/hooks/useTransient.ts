import { useEffect, useState } from 'react';

/**
 * Shows `value` for a while after each change, then lets it go.
 *
 * The HUD announces where you are and what you are passing rather than parking that
 * information permanently over the world — a label that never leaves stops being read
 * within a minute and costs the view for the rest of the session. Returns null once the
 * current value has had its time, so a caller can render nothing at all.
 *
 * Written as "which value has expired" rather than "what is currently shown" so the
 * displayed value stays derived from the argument: a new value is visible on the render
 * that introduces it, with no state update in between.
 */
export function useTransient<T>(value: T, holdMs = 4000): T | null {
  const [expired, setExpired] = useState<T | null>(null);

  useEffect(() => {
    if (value === null || value === undefined) return;
    const timer = window.setTimeout(() => setExpired(value), holdMs);
    return () => window.clearTimeout(timer);
  }, [value, holdMs]);

  return Object.is(expired, value) ? null : value;
}
