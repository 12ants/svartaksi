import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorldLoading } from '../../src/components/WorldLoading';
import { LOADING_VERSES } from '../../src/svartaksi/loadingPoetry';
import type { RuntimeStatus } from '../../src/svartaksi/svartaksiRuntime';

const status = (patch: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  source: 'maplibre',
  phase: 'loading',
  mode: 'initial',
  progress: 0.4,
  message: 'Assembling streets, water and rooftops',
  retryable: false,
  ...patch,
});

describe('WorldLoading', () => {
  it('shows a verse behind the progress on the first load', () => {
    render(<WorldLoading status={status()} onRetry={() => {}} />);

    const bar = screen.getByRole('status', { name: 'Loading world' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');

    const verse = document.querySelector('.loading-verse');
    expect(verse).not.toBeNull();
    const shown = LOADING_VERSES.find((candidate) => candidate.lines[0] === verse?.querySelector('span')?.textContent);
    expect(shown).toBeDefined();
    for (const line of shown!.lines) expect(verse).toHaveTextContent(line);
  });

  it('shows the current work alongside the poem and push stamp', () => {
    render(<WorldLoading status={status()} onRetry={() => {}} />);

    expect(document.querySelector('.loading-title')).toBeNull();
    expect(screen.getByText('Assembling streets, water and rooftops')).toBeVisible();

    const badge = document.querySelector('.loading-build');
    expect(badge).not.toBeNull();
    // Exact date *and* time, so it identifies one push rather than a day's worth of them.
    expect(badge).toHaveTextContent(__BUILD_TIME__);
    expect(badge?.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
    // The commit hash used to lead this line; it is deliberately gone.
    expect(badge?.textContent).not.toMatch(/^[0-9a-f]{7}\b/);
  });

  it('keeps the backdrop opaque through most of the load, then fades it near completion', () => {
    const { rerender } = render(<WorldLoading status={status({ progress: 0.4 })} onRetry={() => {}} />);
    const backdrop = () => document.querySelector<HTMLElement>('.world-curtain-backdrop');
    expect(backdrop()?.style.opacity).toBe('1');

    rerender(<WorldLoading status={status({ progress: 0.97 })} onRetry={() => {}} />);
    const fadedOpacity = Number(backdrop()?.style.opacity);
    expect(fadedOpacity).toBeGreaterThan(0);
    expect(fadedOpacity).toBeLessThan(1);

    rerender(<WorldLoading status={status({ progress: 1 })} onRetry={() => {}} />);
    expect(backdrop()?.style.opacity).toBe('0');
  });

  it('keeps the verse out of the live region, so it is never read aloud', () => {
    render(<WorldLoading status={status()} onRetry={() => {}} />);

    expect(document.querySelector('.loading-verse')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('status', { name: 'Loading world' }).querySelector('.loading-verse')).toBeNull();
  });

  it('rotates to another verse while a slow load continues', () => {
    vi.useFakeTimers();
    try {
      // Two fixed draws, so the "did it change" assertion cannot fail on a repeat.
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValue(0.99);
      render(<WorldLoading status={status()} onRetry={() => {}} />);
      expect(document.querySelector('.loading-verse')).toHaveTextContent(LOADING_VERSES[0].lines[0]);

      act(() => vi.advanceTimersByTime(9_000));
      expect(document.querySelector('.loading-verse'))
        .toHaveTextContent(LOADING_VERSES[LOADING_VERSES.length - 1].lines[0]);
      random.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops to a compact bar while streaming, with nothing covering the world', () => {
    render(<WorldLoading status={status({ mode: 'streaming', progress: 0.7 })} onRetry={() => {}} />);

    expect(screen.getByRole('status', { name: 'Streaming world' })).toHaveAttribute('aria-valuenow', '70');
    expect(document.querySelector('.world-curtain')).toBeNull();
    expect(document.querySelector('.loading-verse')).toBeNull();
  });

  it('shows detailed work while streaming', () => {
    render(<WorldLoading status={status({ mode: 'streaming', details: ['Snapshot: 120 buildings; 30 roads', 'Build: 14 work slices completed'] })} onRetry={() => {}} />);
    expect(screen.getByText('Snapshot: 120 buildings; 30 roads')).toBeVisible();
    expect(screen.getByText('Build: 14 work slices completed')).toBeVisible();
  });

  it('renders nothing once the world is ready', () => {
    const { container } = render(<WorldLoading status={status({ phase: 'ready' })} onRetry={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a retry only when the failure is retryable', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <WorldLoading status={status({ phase: 'error', message: 'Tile index failed', retryable: true })} onRetry={onRetry} />,
    );
    screen.getByRole('button', { name: 'Retry world load' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert', { name: 'World load failed' })).toHaveTextContent('Tile index failed');

    rerender(<WorldLoading status={status({ phase: 'error', message: 'Gone', retryable: false })} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: 'Retry world load' })).toBeNull();
  });
});
