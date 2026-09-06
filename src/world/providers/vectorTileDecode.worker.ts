/// <reference lib="webworker" />

import { decodeVectorTile } from './vectorTileDecoder';
import type { VectorTileDecodeRequest, VectorTileDecodeResponse } from './vectorTileDecodeProtocol';

const scope = self as DedicatedWorkerGlobalScope;

scope.onmessage = ({ data }: MessageEvent<VectorTileDecodeRequest>) => {
  let response: VectorTileDecodeResponse;
  try {
    response = { id: data.id, ok: true, features: decodeVectorTile(data.key, data.bytes) };
  } catch (error) {
    response = {
      id: data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  scope.postMessage(response);
};
