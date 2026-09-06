import { useCallback, useEffect, useState } from 'react';

/** Same touch-device test the touch controls use to decide whether to render. */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * Tracks and drives the page's fullscreen state via the Fullscreen API. Reads
 * `document.fullscreenElement` rather than assuming the toggle succeeded, so a request
 * denied by the browser (or exited with Esc, outside this hook's own control) still
 * leaves `isFullscreen` correct.
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(() => document.fullscreenElement !== null);
  const supported = typeof document.documentElement.requestFullscreen === 'function';

  useEffect(() => {
    const handleChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      // Some browsers (e.g. iOS Safari) reject requestFullscreen outright; the
      // fullscreenchange listener above is the source of truth either way, so a
      // rejection here just leaves isFullscreen at its current value.
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  // The Fullscreen API only grants a request made from inside a user gesture, so the
  // game can't jump to fullscreen the instant it loads on a phone. Instead, on touch
  // devices, the first tap anywhere doubles as that gesture — browser chrome eats real
  // playfield space on a phone, more than it does on desktop, so this one-shot request
  // is worth the surprise. A tap that lands on a real control (a HUD button, a touch
  // stick) still fires it first, then does whatever that control does.
  useEffect(() => {
    if (!supported) return;
    if (typeof window.matchMedia !== 'function' || !window.matchMedia(COARSE_POINTER_QUERY).matches) return;
    if (document.fullscreenElement) return;
    const requestOnFirstTouch = () => {
      void document.documentElement.requestFullscreen().catch(() => {});
    };
    document.addEventListener('touchend', requestOnFirstTouch, { once: true });
    return () => document.removeEventListener('touchend', requestOnFirstTouch);
  }, [supported]);

  return { isFullscreen, supported, toggleFullscreen };
}
