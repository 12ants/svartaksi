// scripts/lib/prefetchTransform.mjs

export function slugify(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Round half to even (banker's rounding): Math.round always rounds .5 up,
// which pushes exact midpoints away from zero in one direction only. That
// breaks symmetry for coordinate data centred near an origin (e.g. 0.005m
// at 1cm precision should land on 0, not 0.01). Round-half-to-even keeps
// midpoints unbiased.
function roundHalfToEven(value) {
  const floorValue = Math.floor(value);
  if (value - floorValue === 0.5) {
    return floorValue % 2 === 0 ? floorValue : floorValue + 1;
  }
  return Math.round(value);
}

function roundPoint(point, precisionMeters) {
  return {
    // The `+ 0` normalises -0 (e.g. from rounding a small negative value to
    // zero) to +0, so equality checks against a plain `0` literal hold.
    x: roundHalfToEven(point.x / precisionMeters) * precisionMeters + 0,
    z: roundHalfToEven(point.z / precisionMeters) * precisionMeters + 0,
  };
}

function roundRing(ring, precisionMeters) {
  return ring.map((point) => roundPoint(point, precisionMeters));
}

/** Rounds every LocalPoint in a WorldData to the nearest `precisionCm` centimetres. */
export function roundWorldData(data, precisionCm) {
  const precisionMeters = precisionCm / 100;
  return {
    ...data,
    roads: data.roads.map((road) => ({ ...road, points: roundRing(road.points, precisionMeters) })),
    buildings: data.buildings.map((building) => ({
      ...building,
      rings: building.rings.map((ring) => roundRing(ring, precisionMeters)),
    })),
    water: data.water.map((area) => ({ ...area, rings: area.rings.map((ring) => roundRing(ring, precisionMeters)) })),
    parks: data.parks.map((area) => ({ ...area, rings: area.rings.map((ring) => roundRing(ring, precisionMeters)) })),
    labels: data.labels.map((label) => ({ ...label, point: roundPoint(label.point, precisionMeters) })),
    objects: data.objects.map((object) => ({ ...object, point: roundPoint(object.point, precisionMeters) })),
  };
}
