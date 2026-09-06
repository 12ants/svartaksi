/** Full-screen MapLibre overlay for picking a teleport destination by click or preset. */
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
// MapLibre positions its canvas, controls and markers entirely from this stylesheet.
// Without it `.maplibregl-marker` never gets `position: absolute`, so a marker is laid
// out in normal flow underneath the canvas and its transform positions it relative to
// there. Imported alongside the library rather than in main.tsx so it only loads with
// the map overlays that need it, not on every game boot.
import 'maplibre-gl/dist/maplibre-gl.css';

import { TELEPORT_LOCATIONS } from '../svartaksi/config';
import { useDialogFocus } from '../hooks/useDialogFocus';

/** OpenFreeMap's minimal (Positron-derived) style — light, low-detail basemap
 * good enough for "click to teleport", no token required. */
const OVERMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

interface OverMapProps {
  initialLng: number;
  initialLat: number;
  onSelect: (lng: number, lat: number) => void;
  onClose: () => void;
}

export function OverMap({
  initialLng, initialLat, onSelect, onClose,
}: OverMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const startPosition = useRef({ lng: initialLng, lat: initialLat });
  useDialogFocus(dialogRef, onClose);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OVERMAP_STYLE_URL,
      center: [startPosition.current.lng, startPosition.current.lat],
      zoom: 13,
    });

    const currentMarker = new maplibregl.Marker({ color: '#ffffff' })
      .setLngLat([startPosition.current.lng, startPosition.current.lat])
      .addTo(map);

    map.on('click', (event) => {
      onSelectRef.current(event.lngLat.lng, event.lngLat.lat);
    });

    map.on('load', () => map.resize());
    const resizeTimer = window.setTimeout(() => map.resize(), 100);

    return () => {
      window.clearTimeout(resizeTimer);
      currentMarker.remove();
      map.remove();
    };
  }, []);

  return (
    <div ref={dialogRef} className="overlay-panel column" role="dialog" aria-modal="true" aria-label="Teleport within Stockholm" tabIndex={-1}>
      <div className="map-header">
        <span>📍 Teleport within Stockholm</span>
        <button onClick={onClose} className="btn-close" aria-label="Close map">✕</button>
      </div>

      <div ref={mapContainerRef} className="teleport-map-container" />
      <div className="teleport-presets">
        {TELEPORT_LOCATIONS.map((location) => (
          <button
            key={location.label}
            onClick={() => onSelect(location.lng, location.lat)}
            className="preset-btn"
          >
            {location.label}
          </button>
        ))}
      </div>
    </div>
  );
}
