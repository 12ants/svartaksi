/**
 * Full-screen MapLibre overlay for planning a bus ride. The start is where the
 * player already is — pre-marked, and what the map centers on — so the ordinary
 * flow is a single click to pick a destination. "Set start" exists for planning a
 * ride from somewhere you are not standing. A sibling of OverMap (same basemap and
 * shell) but stateful over a route rather than firing on the first click.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
// See OverMap.tsx for why this loads alongside the library instead of in main.tsx.
import 'maplibre-gl/dist/maplibre-gl.css';

import { resolveBusRoute, type BusRouteResult } from '../svartaksi/busCorridor';
import { localToLngLat } from '../world/geo';
import { START_LOCATION } from '../svartaksi/config';
import type { RouteSignalStop } from '../svartaksi/trafficLights';
import type { LngLat, LocalPoint } from '../world/types';
import { useDialogFocus } from '../hooks/useDialogFocus';

const OVERMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const ROUTE_SOURCE_ID = 'bus-route';
const ROUTE_LAYER_ID = 'bus-route-line';
const PREVIEW_SOURCE_ID = 'bus-route-preview';
const PREVIEW_LAYER_ID = 'bus-route-preview-line';
const START_COLOR = '#16a34a';
const DESTINATION_COLOR = '#f04f36';
/** Markers are drawn over a pale basemap at city zoom; at the default scale the pins
 * disappear into the street grid. */
const MARKER_SCALE = 1.25;

/** How long the pointer has to settle before a hover is worth routing. Long enough that
 * sweeping across the map does not fire a request per frame, short enough that pausing
 * anywhere feels like the route is following the cursor. */
const PREVIEW_DEBOUNCE_MS = 200;
/** Metres the cursor must move from the last previewed point to be worth re-routing.
 * The router snaps both ends to the nearest junction anyway, so anything under this
 * would resolve to the same path. */
const PREVIEW_MIN_MOVE = 70;

/** Cache key for one origin/destination pair, rounded to about a metre — finer than
 * that and the router would return the same path under a different key. */
function routeKey(start: LngLat, destination: LngLat): string {
  const round = (value: number) => value.toFixed(5);
  return `${round(start.lng)},${round(start.lat)}>${round(destination.lng)},${round(destination.lat)}`;
}

/** Rough metres between two nearby lng/lat pairs. Only ever compared against
 * PREVIEW_MIN_MOVE, so the flat-earth approximation is far more than good enough. */
function roughMeters(a: LngLat, b: LngLat): number {
  const latMeters = (a.lat - b.lat) * 111_320;
  const lngMeters = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(latMeters, lngMeters);
}

interface BusOverMapProps {
  initialLng: number;
  initialLat: number;
  onGo: (path: LocalPoint[], signalStops: RouteSignalStop[]) => void;
  onClose: () => void;
}

type Phase =
  | { kind: 'pick-start' }
  | { kind: 'pick-destination' }
  | { kind: 'routing' }
  | { kind: 'ready'; path: LocalPoint[]; lengthMeters: number; etaSeconds: number; signalStops: RouteSignalStop[] }
  | { kind: 'failed'; reason: 'fetch-failed' | 'no-route' };

function formatEta(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} min`;
}

export function BusOverMap({ initialLng, initialLat, onGo, onClose }: BusOverMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const startMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destinationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // App.tsx captures the player's position when the overlay opens, so these props
  // are a fixed point for the life of this component — a player who keeps driving
  // cannot make the pinned start drift out from under them.
  const [start, setStart] = useState<LngLat>({ lng: initialLng, lat: initialLat });
  const [destination, setDestination] = useState<LngLat | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'pick-destination' });
  /** Length and ETA of the route currently under the cursor. Shown alongside the phase
   * message so the cost of a destination is readable before committing to it. */
  const [previewSummary, setPreviewSummary] = useState<{ lengthMeters: number; etaSeconds: number } | null>(null);
  useDialogFocus(dialogRef, onClose);

  // Read fresh inside the mount-only map click handler, which would otherwise close
  // over the first render's values — same latest-value ref pattern svartaksiRuntime and
  // App.tsx already use for mount-once listeners. Every setState below writes its
  // ref on the same line.
  const destinationRef = useRef<LngLat | null>(null);
  const pickingStartRef = useRef(false);

  /** Every route this planner has resolved, live and previewed alike, keyed by its two
   * endpoints. A hover preview is a full corridor fetch, so clicking the point you were
   * just hovering over must not pay for it twice — that is what makes committing a
   * previewed route instant instead of a second round trip. */
  const routeCacheRef = useRef(new Map<string, BusRouteResult>());
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewTimerRef = useRef(0);
  const previewedAtRef = useRef<LngLat | null>(null);
  const startRef = useRef<LngLat>({ lng: initialLng, lat: initialLat });

  const clearRoute = useCallback(() => {
    abortRef.current?.abort();
    previewAbortRef.current?.abort();
    window.clearTimeout(previewTimerRef.current);
    previewedAtRef.current = null;
    const map = mapRef.current;
    if (!map) return;
    for (const [layerId, sourceId] of [
      [ROUTE_LAYER_ID, ROUTE_SOURCE_ID],
      [PREVIEW_LAYER_ID, PREVIEW_SOURCE_ID],
    ]) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }, []);

  /** Back to the state the planner opens in: start pinned at the player, no
   * destination. A fully blank map is no longer reachable, so Reset does not go there. */
  const reset = useCallback(() => {
    clearRoute();
    destinationMarkerRef.current?.remove();
    destinationMarkerRef.current = null;
    setStart({ lng: initialLng, lat: initialLat });
    startRef.current = { lng: initialLng, lat: initialLat };
    startMarkerRef.current?.setLngLat([initialLng, initialLat]);
    setDestination(null);
    destinationRef.current = null;
    pickingStartRef.current = false;
    setPreviewSummary(null);
    setPhase({ kind: 'pick-destination' });
  }, [clearRoute, initialLng, initialLat]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OVERMAP_STYLE_URL,
      center: [initialLng, initialLat],
      zoom: 13,
    });
    mapRef.current = map;

    startMarkerRef.current = new maplibregl.Marker({ color: START_COLOR, scale: MARKER_SCALE })
      .setLngLat([initialLng, initialLat])
      .addTo(map);

    map.on('click', (event) => {
      const picked = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      // The previous route's line is deliberately left up until the new one
      // resolves and replaces it in place — removing it here would flash the map
      // empty for the length of a corridor fetch. Only Reset takes it down.

      if (pickingStartRef.current) {
        pickingStartRef.current = false;
        setStart(picked);
        startRef.current = picked;
        // Every cached route was measured from the old start, so none of them describe
        // this one. Previews resume from the next pointer move.
        routeCacheRef.current.clear();
        previewedAtRef.current = null;
        startMarkerRef.current?.setLngLat([picked.lng, picked.lat]);
        // Only re-route if there is already something to route to; otherwise fall
        // back to asking for the destination that is still missing.
        setPhase(destinationRef.current ? { kind: 'routing' } : { kind: 'pick-destination' });
        return;
      }

      setDestination(picked);
      destinationRef.current = picked;
      // Entering "routing" here rather than in the resolve effect keeps that effect
      // free of synchronous setState; the fetch starts on this same pick.
      setPhase({ kind: 'routing' });
      if (destinationMarkerRef.current) destinationMarkerRef.current.setLngLat([picked.lng, picked.lat]);
      else {
        destinationMarkerRef.current = new maplibregl.Marker({ color: DESTINATION_COLOR, scale: MARKER_SCALE })
          .setLngLat([picked.lng, picked.lat])
          .addTo(map);
      }
    });

    map.on('load', () => map.resize());
    const resizeTimer = window.setTimeout(() => map.resize(), 100);

    return () => {
      window.clearTimeout(resizeTimer);
      window.clearTimeout(previewTimerRef.current);
      previewAbortRef.current?.abort();
      abortRef.current?.abort();
      startMarkerRef.current?.remove();
      startMarkerRef.current = null;
      destinationMarkerRef.current?.remove();
      destinationMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // Fixed for the life of the component (App.tsx snapshots them on open), so this
    // never actually re-runs — it is in the deps because the effect reads them.
  }, [initialLng, initialLat]);

  /**
   * Draws (or updates) one route line. Layers are added on first use rather than at map
   * load because a route may never be drawn at all, and the preview and committed lines
   * come up at different times.
   */
  const drawLine = useCallback((
    sourceId: string,
    layerId: string,
    path: LocalPoint[],
    paint: Record<string, unknown>,
    aborted: () => boolean,
  ) => {
    const map = mapRef.current;
    if (!map) return;
    const data: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: path.map((point) => {
          const lngLat = localToLngLat(START_LOCATION, point);
          return [lngLat.lng, lngLat.lat];
        }),
      },
    };

    const draw = () => {
      // The deferred path runs later than the resolve: bail if the component
      // unmounted or a Reset/Cancel aborted this route in the meantime.
      if (aborted() || mapRef.current !== map) return;
      const existing = map.getSource(sourceId);
      if (existing) {
        (existing as maplibregl.GeoJSONSource).setData(data);
        return;
      }
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({ id: layerId, type: 'line', source: sourceId, paint });
    };

    // A warm-cached corridor response can beat the basemap style's own CDN
    // fetch; adding a source before the style is loaded throws.
    // Defer on 'idle' rather than 'load': 'load' fires exactly once per map,
    // so a resolve landing after it while isStyleLoaded() is transiently
    // false (a pending sprite, glyph, or style diff) would never draw at all.
    // 'idle' can still fire in that window, and it only fires once the style
    // is fully loaded and nothing is pending, which is precisely the
    // condition addSource/addLayer require.
    if (map.isStyleLoaded()) draw();
    else map.once('idle', draw);
  }, []);

  const hidePreview = useCallback(() => {
    const map = mapRef.current;
    if (map?.getLayer(PREVIEW_LAYER_ID)) map.setLayoutProperty(PREVIEW_LAYER_ID, 'visibility', 'none');
  }, []);

  /** Routes to a hovered point and draws it as the dashed preview. Failures are silent:
   * hovering over a lake is not an error the player asked about, and a red banner
   * flickering as the cursor crosses unroutable ground would be worse than nothing. */
  const previewRoute = useCallback(async (hovered: LngLat) => {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const key = routeKey(startRef.current, hovered);

    const cached = routeCacheRef.current.get(key);
    const result = cached ?? await resolveBusRoute(startRef.current, hovered, controller.signal);
    if (controller.signal.aborted) return;
    routeCacheRef.current.set(key, result);
    if (!result.ok) {
      hidePreview();
      return;
    }
    setPreviewSummary({ lengthMeters: result.lengthMeters, etaSeconds: result.etaSeconds });
    drawLine(
      PREVIEW_SOURCE_ID,
      PREVIEW_LAYER_ID,
      result.path,
      {
        'line-color': '#2f7fd4',
        'line-width': 3,
        'line-opacity': 0.5,
        'line-dasharray': [2, 2],
      },
      () => controller.signal.aborted,
    );
    const map = mapRef.current;
    if (map?.getLayer(PREVIEW_LAYER_ID)) map.setLayoutProperty(PREVIEW_LAYER_ID, 'visibility', 'visible');
  }, [drawLine, hidePreview]);

  /**
   * Realtime preview: the route to wherever the pointer is resting, redrawn as it moves,
   * so the cost of a destination is visible before committing to it.
   *
   * Bound in its own effect rather than alongside the map's other handlers, because this
   * one depends on component state and so has to be rebound when that changes — while
   * the map itself must be created exactly once.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMove = (event: maplibregl.MapMouseEvent) => {
      if (pickingStartRef.current) return;
      const hovered = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = window.setTimeout(() => {
        const previous = previewedAtRef.current;
        if (previous && roughMeters(previous, hovered) < PREVIEW_MIN_MOVE) return;
        previewedAtRef.current = hovered;
        void previewRoute(hovered);
      }, PREVIEW_DEBOUNCE_MS);
    };
    const onLeave = () => window.clearTimeout(previewTimerRef.current);

    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    return () => {
      map.off('mousemove', onMove);
      map.off('mouseout', onLeave);
      window.clearTimeout(previewTimerRef.current);
    };
  }, [previewRoute]);

  useEffect(() => {
    if (!destination) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const key = routeKey(start, destination);
    // A previewed route is already the answer for this exact pair — committing it must
    // not go back to the network for a result the planner is holding.
    const cached = routeCacheRef.current.get(key);
    const pending = cached ? Promise.resolve(cached) : resolveBusRoute(start, destination, controller.signal);
    void pending.then((result: BusRouteResult) => {
      if (controller.signal.aborted) return;
      routeCacheRef.current.set(key, result);
      if (!result.ok) {
        setPhase({ kind: 'failed', reason: result.reason });
        return;
      }
      setPhase({
        kind: 'ready',
        path: result.path,
        lengthMeters: result.lengthMeters,
        etaSeconds: result.etaSeconds,
        signalStops: result.signalStops,
      });
      // The committed line replaces the preview of the same route, so the dashes would
      // only sit under the solid line adding nothing.
      hidePreview();
      drawLine(
        ROUTE_SOURCE_ID,
        ROUTE_LAYER_ID,
        result.path,
        { 'line-color': '#2f7fd4', 'line-width': 4 },
        () => controller.signal.aborted,
      );
    });
    return () => controller.abort();
  }, [start, destination, drawLine, hidePreview]);

  const beginPickStart = useCallback(() => {
    pickingStartRef.current = true;
    setPhase({ kind: 'pick-start' });
  }, []);

  return (
    <div ref={dialogRef} className="overlay-panel column" role="dialog" aria-modal="true" aria-label="Bus line planner" tabIndex={-1}>
      <div className="map-header">
        <span>BUS LINE</span>
        <button onClick={onClose} className="btn-close" aria-label="Close bus planner">✕</button>
      </div>

      <div ref={mapContainerRef} data-testid="bus-map" className="teleport-map-container" />

      <div className="bus-route-bar">
        {phase.kind === 'pick-destination' && <span>Starting where you are. Click the map to pick a destination.</span>}
        {phase.kind === 'pick-start' && <span>Click the map to move the start.</span>}
        {phase.kind === 'routing' && <span>Computing route…</span>}
        {phase.kind !== 'ready' && previewSummary && (
          <span className="bus-route-preview" data-testid="route-preview">
            Hovering: {Math.round(previewSummary.lengthMeters)} m · {formatEta(previewSummary.etaSeconds)}
          </span>
        )}
        {phase.kind === 'ready' && (
          <>
            <span>{Math.round(phase.lengthMeters)} m · {formatEta(phase.etaSeconds)}</span>
            <button className="preset-btn" onClick={() => onGo(phase.path, phase.signalStops)}>Go</button>
          </>
        )}
        {phase.kind === 'failed' && (
          <span role="alert">
            {phase.reason === 'no-route'
              ? 'No route between those points — pick again.'
              : 'Could not load road data for that corridor — try again.'}
          </span>
        )}
        {phase.kind !== 'pick-start' && (
          <button className="preset-btn" onClick={beginPickStart}>Set start</button>
        )}
        <button className="preset-btn" onClick={reset}>Reset</button>
        <button className="preset-btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
