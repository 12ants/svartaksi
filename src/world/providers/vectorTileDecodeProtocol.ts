import type { ChunkKey } from '../types';
import type { MapLibreFeature } from './vectorTileDecoder';

export interface VectorTileDecodeRequest {
  id: number;
  key: ChunkKey;
  bytes: ArrayBuffer;
}

export type VectorTileDecodeResponse =
  | { id: number; ok: true; features: MapLibreFeature[] }
  | { id: number; ok: false; error: string };
