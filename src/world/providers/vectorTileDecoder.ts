import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import type { ChunkKey } from '../types';

type Position = [number, number];

export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

export interface MapLibreFeature {
  layer: string;
  id?: string | number;
  /** Feature ids are only unique within a tile, so provenance is part of identity. */
  tile?: string;
  properties: Record<string, unknown>;
  geometry: Geometry;
}

export const TILE_LAYERS = [
  'transportation',
  'building',
  'water',
  'landuse',
  'landcover',
  'park',
  'poi',
] as const;

export function decodeVectorTile(key: ChunkKey, bytes: ArrayBuffer): MapLibreFeature[] {
  const tile = new VectorTile(new PbfReader(new Uint8Array(bytes)));
  const features: MapLibreFeature[] = [];
  const tileId = `${key.z}/${key.x}/${key.y}`;
  for (const layerName of TILE_LAYERS) {
    const layer = tile.layers[layerName];
    if (!layer) continue;
    for (let index = 0; index < layer.length; index += 1) {
      // vector-tile-js emits only Point/Line/Polygon geometry for these layers.
      const geojson = layer.feature(index).toGeoJSON(key.x, key.y, key.z) as unknown as {
        id?: string | number;
        properties: Record<string, unknown>;
        geometry: Geometry;
      };
      features.push({ layer: layerName, tile: tileId, ...geojson });
    }
  }
  return features;
}
