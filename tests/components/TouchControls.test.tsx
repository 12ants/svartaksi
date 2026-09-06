import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TouchControls } from '../../src/components/TouchControls';

const baseProps = {
  mode: 'car' as const,
  cameraMode: 'chase' as const,
  inspectorEnabled: false,
  onInput: vi.fn(),
  onRelease: vi.fn(),
  onInteract: vi.fn(),
  onToggleBlobForm: vi.fn(),
  blobControlScheme: 'direct' as const,
  onToggleBlobControlScheme: vi.fn(),
  onCamera: vi.fn(),
  onBus: vi.fn(),
  onMenu: vi.fn(),
  onInspectHere: vi.fn(),
};

describe('TouchControls', () => {
  it('feeds joystick movement directly to input and releases on pointer cancel', () => {
    const onInput = vi.fn();
    render(<TouchControls {...baseProps} onInput={onInput} />);
    const joystick = screen.getByRole('slider', { name: 'Movement joystick', hidden: true });
    fireEvent.pointerDown(joystick, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(joystick, { pointerId: 1, clientX: 25, clientY: 10 });
    expect(onInput).toHaveBeenLastCalledWith(expect.objectContaining({
      forward: expect.any(Number),
      turn: expect.any(Number),
    }));
    fireEvent.pointerCancel(joystick, { pointerId: 1 });
    expect(onInput).toHaveBeenLastCalledWith({ forward: 0, turn: 0 });
  });

  it('supports simultaneous boost and movement without keyboard events', () => {
    const onInput = vi.fn();
    const keyboard = vi.fn();
    window.addEventListener('keydown', keyboard);
    render(<TouchControls {...baseProps} onInput={onInput} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Boost', hidden: true }), { pointerId: 2 });
    expect(onInput).toHaveBeenCalledWith({ boost: true });
    expect(keyboard).not.toHaveBeenCalled();
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Boost', hidden: true }), { pointerId: 2 });
    expect(onInput).toHaveBeenLastCalledWith({ boost: false });
    window.removeEventListener('keydown', keyboard);
  });

  it('renders mode-specific bus and freecam actions', () => {
    const { rerender } = render(<TouchControls {...baseProps} mode="bus" />);
    fireEvent.click(screen.getByRole('button', { name: 'Get off bus', hidden: true }));
    expect(baseProps.onBus).toHaveBeenCalled();

    rerender(<TouchControls {...baseProps} cameraMode="freecam" />);
    expect(screen.getByRole('slider', { name: 'Look joystick', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move up', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move down', hidden: true })).toBeInTheDocument();
  });

  it('offers the blob control scheme as a labelled toggle, which touch has no key for', () => {
    // V swaps the scheme on a keyboard. Without this button the choice was unreachable on
    // a touch device — which is the one place blobby's drag-to-move is the only way to
    // move at all, since there are no WASD keys behind it.
    const onToggleBlobControlScheme = vi.fn();
    const { rerender } = render(
      <TouchControls {...baseProps} mode="blob" onToggleBlobControlScheme={onToggleBlobControlScheme} />,
    );
    const button = screen.getByRole('button', { name: 'Blob controls, currently direct', hidden: true });
    expect(button).toHaveTextContent('DIRECT');
    fireEvent.click(button);
    expect(onToggleBlobControlScheme).toHaveBeenCalled();

    rerender(<TouchControls {...baseProps} mode="blob" blobControlScheme="blobby" />);
    expect(screen.getByRole('button', { name: 'Blob controls, currently blobby', hidden: true }))
      .toHaveTextContent('BLOBBY');
  });

  it('releases touch input on visibility loss and unmount', () => {
    const onRelease = vi.fn();
    const view = render(<TouchControls {...baseProps} onRelease={onRelease} />);
    fireEvent(document, new Event('visibilitychange'));
    expect(onRelease).toHaveBeenCalled();
    view.unmount();
    expect(onRelease).toHaveBeenCalledTimes(2);
  });
});
