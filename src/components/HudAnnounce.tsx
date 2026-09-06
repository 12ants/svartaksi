import type { NearbyItem } from '../svartaksi/svartaksiRuntime';
import { useTransient } from '../hooks/useTransient';

/**
 * Centred, backgroundless white text across the top: where you are, and the two nearest
 * named things. Both fade out on their own once they have been read.
 *
 * This replaces the boxed "NEARBY" panel — a bordered card listing ten scored places with
 * a heading, a location line and a close button — and the fixed game title beside it.
 * Neither needed to be permanent: the title never changed, and a ten-row list of things
 * within 500m is a lot of chrome for something you glance at.
 */
export function HudAnnounce({ area, nearby }: { area: string | null; nearby: NearbyItem[] }) {
  const shownArea = useTransient(area);
  // Only the two closest — onNearby already returns them sorted by how relevant they are
  // from here, so the head of that list is what is worth naming.
  const closest = nearby.slice(0, 2);
  const shownNearby = useTransient(
    closest.length ? closest.map((item) => item.name).join(' · ') : null,
  );

  if (!shownArea && !shownNearby) return null;
  return (
    <div className="hud-announce" aria-live="polite">
      {shownArea ? <p className="hud-announce-area">{shownArea}</p> : null}
      {shownNearby ? <p className="hud-announce-nearby">{shownNearby}</p> : null}
    </div>
  );
}
