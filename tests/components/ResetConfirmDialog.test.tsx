import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ResetConfirmDialog } from '../../src/components/ResetConfirmDialog';

describe('reset confirm dialog', () => {
  it('names what is removed and states that the game reloads', () => {
    render(<ResetConfirmDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /reset all settings/i })).toBeInTheDocument();
    expect(screen.getByText(/reloads the game/i)).toBeInTheDocument();
  });

  it('cancel changes nothing', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ResetConfirmDialog onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirm fires the reset', () => {
    const onConfirm = vi.fn();
    render(<ResetConfirmDialog onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText('Reset and restart'));
    expect(onConfirm).toHaveBeenCalled();
  });
});
