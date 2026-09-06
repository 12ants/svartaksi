import { useTransient } from '../hooks/useTransient';

/**
 * One line somebody said, low and centred, held long enough to read and then gone.
 *
 * Carries an `id` rather than being a bare string because a speaker's lines wrap: saying
 * the same sentence twice in a row is a real event, and `useTransient` compares by
 * identity, so an unchanged string would be treated as the one that already had its
 * time on screen and never appear.
 */
export interface SpeechLine {
  text: string;
  id: number;
}

/** Longer than the area/nearby announcements: those name a place you can look at, this
 * is a sentence with a turn in it. */
const SPEECH_HOLD_MS = 7000;

export function HudSpeech({ speech }: { speech: SpeechLine | null }) {
  const shown = useTransient(speech, SPEECH_HOLD_MS);
  if (!shown) return null;
  return (
    <p className="hud-speech" aria-live="polite">{shown.text}</p>
  );
}
