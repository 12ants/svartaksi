import { useCallback, useRef, useState } from 'react';

export interface HudVisibility {
  status: boolean;
  actions: boolean;
  context: boolean;
  controls: boolean;
}

export type HudRegion = keyof HudVisibility;

const ALL_HIDDEN: HudVisibility = {
  status: false,
  actions: false,
  context: false,
  controls: false,
};
const ALL_VISIBLE: HudVisibility = {
  status: true,
  actions: true,
  context: true,
  controls: true,
};

/**
 * The app always boots in zen mode: every session starts with all four regions
 * hidden, regardless of what a previous session left them as. Visibility is
 * therefore session-only state — nothing here reads or writes persisted storage.
 */
export function useHudVisibility() {
  const [visibility, setVisibility] = useState<HudVisibility>({ ...ALL_HIDDEN });
  const lastCustomizedRef = useRef<HudVisibility>(ALL_VISIBLE);

  const setRegion = useCallback((region: HudRegion, visible: boolean) => {
    setVisibility((current) => {
      const next = { ...current, [region]: visible };
      if (Object.values(next).some(Boolean)) lastCustomizedRef.current = next;
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setVisibility((current) => {
      if (Object.values(current).some(Boolean)) {
        lastCustomizedRef.current = current;
        return { status: false, actions: false, context: false, controls: false };
      }
      return { ...lastCustomizedRef.current };
    });
  }, []);

  return { visibility, setRegion, toggleAll };
}
