import { useCallback, useEffect, useRef, useState } from 'react';

export type ActiveOverlay = 'world' | 'map' | 'bus' | 'hud' | 'dev' | null;

export function useOverlayController(releaseInput: () => void) {
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setActiveOverlay(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    trigger?.focus();
  }, []);

  const open = useCallback((overlay: Exclude<ActiveOverlay, null>, trigger?: HTMLElement | null) => {
    releaseInput();
    triggerRef.current = trigger ?? null;
    setActiveOverlay(overlay);
  }, [releaseInput]);

  const toggle = useCallback((
    overlay: Exclude<ActiveOverlay, null>,
    trigger?: HTMLElement | null,
  ) => {
    if (activeOverlay === overlay) close();
    else open(overlay, trigger);
  }, [activeOverlay, close, open]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && activeOverlay) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [activeOverlay, close]);

  return { activeOverlay, open, close, toggle };
}
