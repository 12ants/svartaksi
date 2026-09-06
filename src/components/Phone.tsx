import { useEffect, useRef, useState } from 'react';

import { useTransient } from '../hooks/useTransient';

import { PHONE_PRESETS, phoneClock, signalBars, unreadCount, type PhoneMessage, type PhonePreset } from '../svartaksi/phone';
import type { QuestLogEntry } from '../story/storyEngine';

interface PhoneProps {
  open: boolean;
  inbox: PhoneMessage[];
  /** Item 11's quest log — beats the story engine has unlocked, newest last. Rendered on
   * a NOTES screen the same way the inbox has its own screen. */
  notes: QuestLogEntry[];
  flashlight: boolean;
  /** World clock, in hours, so the phone's own clock agrees with the sky. */
  timeOfDay: number;
  /** Where the player is, which is all the signal meter is derived from. */
  position: { x: number; z: number };
  onClose(): void;
  onToggleFlashlight(): void;
  onRead(id: string): void;
  onSend(preset: PhonePreset): void;
}

/**
 * A 1997 candybar phone, drawn in the corner of the screen.
 *
 * Deliberately built out of divs and CSS rather than an image: the whole point of the
 * thing is the screen, which has to render live text (the inbox, the clock, the signal
 * meter), and a sprite with live text on top of it is two problems instead of one.
 *
 * Navigation is the period's, not the web's: there is no pointer on a 1997 phone, so the
 * up/down keys walk a highlight, the centre key opens, and the right soft key goes back.
 * The buttons are real buttons underneath so the whole thing still works by tab and click.
 */
export function Phone({ open, ...rest }: PhoneProps) {
  // The open handset is its own component so that closing it unmounts the selection and
  // the message being read. Opening the phone then always lands on the top of the inbox
  // — it is a list of a dozen items, and resuming a position nobody remembers setting is
  // worse than not — without an effect that resets state on a prop change.
  if (!open) return null;
  return <OpenPhone {...rest} />;
}

function OpenPhone({
  inbox,
  notes,
  flashlight,
  timeOfDay,
  position,
  onClose,
  onToggleFlashlight,
  onRead,
  onSend,
}: Omit<PhoneProps, 'open'>) {
  const [selected, setSelected] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [viewingNotes, setViewingNotes] = useState(false);
  const [presetIndex, setPresetIndex] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Focused on mount so the phone's own keys (the highlight, the centre key) work
  // without a click, and so they stop at the handset instead of reaching the controls.
  useEffect(() => { bodyRef.current?.focus(); }, []);

  const message = reading ? inbox.find((entry) => entry.id === reading) ?? null : null;

  const openSelected = () => {
    const entry = inbox[selected];
    if (!entry) return;
    setReading(entry.id);
    onRead(entry.id);
  };

  const sendSelectedPreset = (index: number = presetIndex) => {
    const preset = PHONE_PRESETS[index];
    if (!preset) return;
    setPresetIndex(index);
    onSend(preset);
    setComposing(false);
    setSelected(0);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // The phone's own keys, swallowed here so they never reach the driving controls
    // underneath — ArrowUp on an open phone must not also pull away from a bus stop.
    const handled = ['ArrowUp', 'ArrowDown', 'Enter', 'Backspace', 'Escape'];
    if (!handled.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { onClose(); return; }
    if (viewingNotes) {
      if (event.key === 'Backspace' || event.key === 'Enter') setViewingNotes(false);
      return;
    }
    if (composing) {
      if (event.key === 'ArrowUp') setPresetIndex((index) => Math.max(0, index - 1));
      if (event.key === 'ArrowDown') setPresetIndex((index) => Math.min(PHONE_PRESETS.length - 1, index + 1));
      if (event.key === 'Enter') sendSelectedPreset();
      if (event.key === 'Backspace') setComposing(false);
      return;
    }
    if (message) {
      if (event.key === 'Backspace' || event.key === 'Enter') setReading(null);
      return;
    }
    if (event.key === 'ArrowUp') setSelected((index) => Math.max(0, index - 1));
    if (event.key === 'ArrowDown') setSelected((index) => Math.min(inbox.length - 1, index + 1));
    if (event.key === 'Enter') openSelected();
    if (event.key === 'Backspace') onClose();
  };

  const bars = signalBars(position.x, position.z);
  const unread = unreadCount(inbox);

  return (
    <div className="phone" role="dialog" aria-label="Mobile phone">
      <div className="phone-shell">
        <div className="phone-antenna" aria-hidden="true" />
        <div className="phone-earpiece" aria-hidden="true" />
        <div
          className={`phone-screen${flashlight ? ' phone-screen-torch' : ''}`}
          ref={bodyRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <div className="phone-status">
            <span className="phone-signal" aria-label={`Signal ${bars} of 4`}>
              {[1, 2, 3, 4].map((bar) => (
                <i key={bar} className={bar <= bars ? 'on' : ''} style={{ height: `${3 + bar * 2}px` }} />
              ))}
            </span>
            <span className="phone-carrier">SVARTAKSI</span>
            <span className="phone-clock">{phoneClock(timeOfDay)}</span>
          </div>

          {viewingNotes ? (
            <div className="phone-body" aria-live="polite">
              <p className="phone-title">ANTECKNINGAR {notes.length ? `(${notes.length})` : ''}</p>
              {notes.length === 0 ? (
                <p className="phone-empty">Inga anteckningar</p>
              ) : (
                <ul className="phone-list phone-notes">
                  {notes.map((entry) => (
                    <li key={`${entry.projectId}:${entry.beatId}`}>
                      <p className="phone-note-title">{entry.title}</p>
                      {entry.description ? <p className="phone-note-body">{entry.description}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : composing ? (
            <div className="phone-body">
              <p className="phone-title">SKRIV MEDDELANDE</p>
              <ul className="phone-list">
                {PHONE_PRESETS.map((preset, index) => (
                  <li key={preset.id}>
                    <button
                      type="button"
                      className={index === presetIndex ? 'selected' : ''}
                      aria-current={index === presetIndex}
                      onClick={() => sendSelectedPreset(index)}
                    >
                      {preset.body}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : message ? (
            <div className="phone-body" aria-live="polite">
              <p className="phone-from">FRAN: {message.from}</p>
              <p className="phone-text">{message.body}</p>
            </div>
          ) : (
            <div className="phone-body">
              <p className="phone-title">INKORG {inbox.length ? `(${unread}/${inbox.length})` : ''}</p>
              {inbox.length === 0 ? (
                <p className="phone-empty">Inga meddelanden</p>
              ) : (
                <ul className="phone-list">
                  {inbox.map((entry, index) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={index === selected ? 'selected' : ''}
                        aria-current={index === selected}
                        onClick={() => { setSelected(index); setReading(entry.id); onRead(entry.id); }}
                      >
                        <span className="phone-envelope" aria-hidden="true">{entry.read ? '□' : '■'}</span>
                        {entry.from}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="phone-soft">
            <span>{viewingNotes ? 'TILLBAKA' : composing ? 'SKICKA' : message ? 'TILLBAKA' : 'VALJ'}</span>
            <span>{flashlight ? 'LAMPA PA' : 'LAMPA'}</span>
          </div>
        </div>

        <div className="phone-keys">
          <button
            type="button"
            className="phone-key phone-key-soft"
            onClick={() => (viewingNotes ? setViewingNotes(false) : composing ? sendSelectedPreset() : message ? setReading(null) : openSelected())}
          >
            {viewingNotes ? 'BACK' : composing ? 'SEND' : message ? 'BACK' : 'OK'}
          </button>
          <button
            type="button"
            className="phone-key phone-key-write"
            aria-pressed={composing}
            onClick={() => setComposing((value) => !value)}
          >
            {composing ? 'CANCEL' : 'WRITE'}
          </button>
          <button
            type="button"
            className="phone-key phone-key-notes"
            aria-pressed={viewingNotes}
            onClick={() => setViewingNotes((value) => !value)}
          >
            {viewingNotes ? 'INBOX' : `NOTES${notes.length ? ` (${notes.length})` : ''}`}
          </button>
          <button
            type="button"
            className={`phone-key phone-key-torch${flashlight ? ' on' : ''}`}
            aria-pressed={flashlight}
            aria-keyshortcuts="F"
            title="Flashlight (F)"
            onClick={onToggleFlashlight}
          >
            ☀
          </button>
          <button type="button" className="phone-key phone-key-end" onClick={onClose} aria-label="Close phone">
            ✕
          </button>
          {/* The keypad is scenery — it is what makes the object read as a phone from
              1997 rather than as a panel with a list in it. */}
          <div className="phone-pad" aria-hidden="true">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((key) => (
              <span key={key}>{key}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The arrival: just the text, briefly, in the middle of the screen. No phone, no chrome,
 * nothing to dismiss — you read it and it goes, exactly like glancing at a handset on the
 * passenger seat.
 */
export function PhoneToast({ message }: { message: PhoneMessage | null }) {
  const shown = useTransient(message, TOAST_HOLD_MS);
  if (!shown) return null;
  return (
    <div className="phone-toast" aria-live="polite">
      <p className="phone-toast-from">{shown.from}</p>
      <p className="phone-toast-text">{shown.body}</p>
    </div>
  );
}

/** Long enough to read two lines of junk at a glance, short enough that it is gone
 * before you have decided whether you cared. */
const TOAST_HOLD_MS = 6_000;
