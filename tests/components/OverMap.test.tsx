import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverMap } from '../../src/components/OverMap';
import { START_LOCATION_NAME } from '../../src/svartaksi/config';

const { handlers } = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number } }) => void>,
}));

vi.mock('maplibre-gl', () => {
  const marker = {
    setLngLat: vi.fn(function () { return marker; }),
    addTo: vi.fn(function () { return marker; }),
    remove: vi.fn(),
  };
  const map = {
    on: vi.fn((event: string, handler: (event: { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number } }) => void) => { handlers[event] = handler; }),
    load: vi.fn(),
    resize: vi.fn(),
    remove: vi.fn(),
  };
  return {
    default: {
      Map: vi.fn(function () { return map; }),
      Marker: vi.fn(function () { return marker; }),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(handlers)) delete handlers[key];
});

describe('OverMap', () => {
  it('renders the overlay panel with map container and presets', () => {
    render(
      <OverMap initialLng={18.1} initialLat={59.3} onSelect={() => {}} onClose={() => {}} />,
    );

    expect(screen.getByText('📍 Teleport within Stockholm')).toBeInTheDocument();
    // Read from the constant, not a literal: this row is the start location, and pinning
    // its name here made the test fail every time the start moved.
    expect(screen.getByText(START_LOCATION_NAME)).toBeInTheDocument();
    expect(screen.getByText('Ryssbergen South')).toBeInTheDocument();
    expect(screen.getByText('Gamla Stan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close map' })).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <OverMap initialLng={18.1} initialLat={59.3} onSelect={() => {}} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close map' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onSelect with coordinates when a preset is clicked', () => {
    const onSelect = vi.fn();
    render(
      <OverMap initialLng={18.1} initialLat={59.3} onSelect={onSelect} onClose={() => {}} />,
    );

    fireEvent.click(screen.getByText('Gamla Stan'));
    expect(onSelect).toHaveBeenCalledWith(18.0717, 59.3257);
  });

});
