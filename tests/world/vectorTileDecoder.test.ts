import { PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';

import { decodeVectorTile } from '../../src/world/providers/vectorTileDecoder';

function pointTile(layerName: string): ArrayBuffer {
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_layer, layer) => {
    layer.writeVarintField(15, 2);
    layer.writeStringField(1, layerName);
    layer.writeMessage(2, (_feature, feature) => {
      feature.writeVarintField(1, 7);
      feature.writePackedVarint(2, [0, 0]);
      feature.writeVarintField(3, 1);
      feature.writePackedVarint(4, [9, 50, 34]);
    }, null);
    layer.writeStringField(3, 'name');
    layer.writeMessage(4, (_value, value) => value.writeStringField(1, 'Test point'), null);
    layer.writeVarintField(5, 4096);
  }, null);
  const bytes = pbf.finish();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('decodeVectorTile', () => {
  it('preserves allowed layer, feature, and tile provenance', () => {
    const features = decodeVectorTile({ z: 14, x: 9000, y: 4818 }, pointTile('poi'));

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      layer: 'poi',
      tile: '14/9000/4818',
      id: 7,
      properties: { name: 'Test point' },
      geometry: { type: 'Point' },
    });
  });

  it('ignores layers outside the gameplay allowlist', () => {
    expect(decodeVectorTile({ z: 14, x: 1, y: 2 }, pointTile('place'))).toEqual([]);
  });
});
