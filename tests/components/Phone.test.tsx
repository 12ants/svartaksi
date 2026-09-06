import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Phone, PhoneToast } from '../../src/components/Phone';
import type { PhoneMessage } from '../../src/svartaksi/phone';
import type { QuestLogEntry } from '../../src/story/storyEngine';

const message = (id: string, from: string, body: string, read = false): PhoneMessage => ({
  id, from, body, at: 0, read,
});

const INBOX = [
  message('a', 'VINN-NU', 'GRATTIS! Du har vunnit en resa.'),
  message('b', '72500', 'RINGSIGNALER 10kr/st.', true),
];

function renderPhone(overrides: Partial<Parameters<typeof Phone>[0]> = {}) {
  const props = {
    open: true,
    inbox: INBOX,
    notes: [] as QuestLogEntry[],
    flashlight: false,
    timeOfDay: 21.5,
    position: { x: 0, z: 0 },
    onClose: vi.fn(),
    onToggleFlashlight: vi.fn(),
    onRead: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<Phone {...props} />) };
}

describe('phone', () => {
  it('draws nothing at all while it is shut', () => {
    const { container } = render(
      <Phone
        open={false}
        inbox={INBOX}
        notes={[]}
        flashlight={false}
        timeOfDay={12}
        position={{ x: 0, z: 0 }}
        onClose={vi.fn()}
        onToggleFlashlight={vi.fn()}
        onRead={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the inbox, the world clock and the signal meter', () => {
    renderPhone();
    expect(screen.getByRole('dialog', { name: /phone/i })).toBeInTheDocument();
    expect(screen.getByText('VINN-NU')).toBeInTheDocument();
    expect(screen.getByText('72500')).toBeInTheDocument();
    // The clock reads the world's time of day, not the machine's.
    expect(screen.getByText('21:30')).toBeInTheDocument();
    expect(screen.getByLabelText(/signal \d of 4/i)).toBeInTheDocument();
    // One unread of two.
    expect(screen.getByText(/INKORG \(1\/2\)/)).toBeInTheDocument();
  });

  it('opens a message and reports it read', () => {
    const { props } = renderPhone();
    fireEvent.click(screen.getByText('VINN-NU'));

    expect(screen.getByText('GRATTIS! Du har vunnit en resa.')).toBeInTheDocument();
    expect(screen.getByText('FRAN: VINN-NU')).toBeInTheDocument();
    expect(props.onRead).toHaveBeenCalledWith('a');
  });

  it('walks the inbox and opens with the keypad, the way the thing it imitates does', () => {
    const { props } = renderPhone();
    const screenEl = screen.getByRole('dialog').querySelector('.phone-screen')!;

    fireEvent.keyDown(screenEl, { key: 'ArrowDown' });
    fireEvent.keyDown(screenEl, { key: 'Enter' });
    expect(props.onRead).toHaveBeenCalledWith('b');
    expect(screen.getByText('RINGSIGNALER 10kr/st.')).toBeInTheDocument();

    // Back out of the message, then out of the phone.
    fireEvent.keyDown(screenEl, { key: 'Backspace' });
    expect(screen.getByText(/INKORG/)).toBeInTheDocument();
    fireEvent.keyDown(screenEl, { key: 'Backspace' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('keeps its own keys away from the controls underneath', () => {
    // Arrow keys reach the driving controls through a window listener; an open phone
    // must swallow them, or reading a message also steers.
    renderPhone();
    const screenEl = screen.getByRole('dialog').querySelector('.phone-screen')!;
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    act(() => { screenEl.dispatchEvent(event); });
    window.removeEventListener('keydown', onWindow);
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('works the torch from the handset', () => {
    const { props } = renderPhone();
    fireEvent.click(screen.getByTitle(/flashlight/i));
    expect(props.onToggleFlashlight).toHaveBeenCalled();
  });

  it('lights its own backlight when the torch is on', () => {
    const { container } = renderPhone({ flashlight: true });
    expect(container.querySelector('.phone-screen-torch')).not.toBeNull();
    expect(screen.getByText('LAMPA PA')).toBeInTheDocument();
  });

  it('says so rather than showing an empty list before anything has arrived', () => {
    renderPhone({ inbox: [] });
    expect(screen.getByText(/Inga meddelanden/i)).toBeInTheDocument();
  });

  it('sends a preset phrase from the composer', () => {
    const { props } = renderPhone();
    fireEvent.click(screen.getByText('WRITE'));
    expect(screen.getByText('SKRIV MEDDELANDE')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Pa vag.'));
    expect(props.onSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'on-my-way', body: 'Pa vag.' }));
    // Composer closes and returns to the inbox after sending.
    expect(screen.getByText(/INKORG/)).toBeInTheDocument();
  });

  it('walks the composer and sends with the keypad', () => {
    const { props } = renderPhone();
    const screenEl = screen.getByRole('dialog').querySelector('.phone-screen')!;
    fireEvent.click(screen.getByText('WRITE'));

    fireEvent.keyDown(screenEl, { key: 'ArrowDown' });
    fireEvent.keyDown(screenEl, { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'running-late' }));
  });

  it('cancels the composer without sending', () => {
    const { props } = renderPhone();
    fireEvent.click(screen.getByText('WRITE'));
    fireEvent.click(screen.getByText('CANCEL'));
    expect(screen.queryByText('SKRIV MEDDELANDE')).not.toBeInTheDocument();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('forgets what was being read once it is closed and reopened', () => {
    const { rerender, props } = renderPhone();
    fireEvent.click(screen.getByText('VINN-NU'));
    expect(screen.getByText('FRAN: VINN-NU')).toBeInTheDocument();

    rerender(<Phone {...props} open={false} />);
    rerender(<Phone {...props} open />);
    expect(screen.queryByText('FRAN: VINN-NU')).not.toBeInTheDocument();
    expect(screen.getByText(/INKORG/)).toBeInTheDocument();
  });
});

describe('phone notes (backlog item 11 quest log)', () => {
  const QUEST_LOG: QuestLogEntry[] = [
    { projectId: 'svartaksi-opening', beatId: 'forest-rave-invite', title: 'Forest rave', description: 'Go to the fire.', at: 42 },
  ];

  it('says so when the quest log is empty', () => {
    renderPhone();
    fireEvent.click(screen.getByText(/^NOTES/));
    expect(screen.getByText('Inga anteckningar')).toBeInTheDocument();
  });

  it('shows a badge count and lists unlocked quest log entries', () => {
    renderPhone({ notes: QUEST_LOG });
    expect(screen.getByText('NOTES (1)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('NOTES (1)'));
    expect(screen.getByText('ANTECKNINGAR (1)')).toBeInTheDocument();
    expect(screen.getByText('Forest rave')).toBeInTheDocument();
    expect(screen.getByText('Go to the fire.')).toBeInTheDocument();
  });

  it('returns to the inbox from notes', () => {
    renderPhone({ notes: QUEST_LOG });
    fireEvent.click(screen.getByText('NOTES (1)'));
    fireEvent.click(screen.getByText('INBOX'));
    expect(screen.getByText(/INKORG/)).toBeInTheDocument();
  });
});

describe('phone toast', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('shows just the text, then takes it away on its own', () => {
    const arrival = message('a', 'VINN-NU', 'GRATTIS! Du har vunnit en resa.');
    const { rerender } = render(<PhoneToast message={arrival} />);
    expect(screen.getByText('GRATTIS! Du har vunnit en resa.')).toBeInTheDocument();
    expect(screen.getByText('VINN-NU')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(6_500); });
    rerender(<PhoneToast message={arrival} />);
    expect(screen.queryByText('GRATTIS! Du har vunnit en resa.')).not.toBeInTheDocument();
  });

  it('draws nothing when nothing has arrived', () => {
    const { container } = render(<PhoneToast message={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
