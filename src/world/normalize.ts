/** Converts raw Overpass/OSM JSON elements into the shared WorldData shape (local meter coordinates). */
import { lngLatToLocal, smoothPolyline } from './geo';
import { isRenderedWay } from '../svartaksi/roadStyle';
import type { LngLat, LocalPoint, WorldArea, WorldBuilding, WorldData, WorldRoad, WorldSource } from './types';
import { normalizeBuildingAppearance } from './normalizeAppearance';
import { attachEntrancesToBuildings } from './buildingEntrances';

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lon: number; lat: number }>;
  lon?: number;
  lat?: number;
}

// Widened from OSM's nominal lane widths so driving reads comfortably at this game's
// scale — footway (not drivable) is left at its original narrow width.
const roadWidths: Record<string, number> = {
  motorway: 18,
  trunk: 16,
  primary: 14,
  secondary: 12,
  tertiary: 10,
  residential: 9,
  service: 5,
  footway: 2,
};

/** `natural=*` values that describe a patch of ground rather than a point feature.
 * Water is handled separately, above, since it renders as a different surface. */
const NATURAL_GROUND = new Set([
  'wood', 'scrub', 'heath', 'grassland', 'wetland', 'marsh', 'sand', 'beach',
  'bare_rock', 'scree',
]);

/** `amenity=*` values that are a physical thing standing on the pavement, and so worth
 * a model. Everything else tagged `amenity` (a restaurant, a school) is a place, and is
 * already covered by the label pass. */
const AMENITY_FURNITURE = new Set([
  'bench', 'waste_basket', 'post_box', 'bicycle_parking', 'fountain', 'drinking_water',
  'telephone', 'clock',
]);

/** `amenity=*` values that trade with the street after dark, and so earn a lit sign the
 * same way a shop does. See objectKind's `storefront`. */
const STOREFRONT_AMENITIES = new Set([
  'bar', 'pub', 'cafe', 'restaurant', 'fast_food', 'nightclub', 'cinema', 'theatre',
  'pharmacy', 'ice_cream',
]);

/** What kind of street furniture, if any, a node describes. Returns '' for nodes that
 * are not a physical object — the caller skips those. */
function objectKind(tags: Record<string, string>): string {
  if (tags.entrance || tags.door) return 'entrance';
  // Before the furniture checks: a shop tagged with a bench outside is still a shop.
  if (tags.shop || (tags.amenity && STOREFRONT_AMENITIES.has(tags.amenity))) return 'storefront';
  if (tags.natural === 'tree') return 'tree';
  if (tags.highway === 'street_lamp') return 'street_lamp';
  if (tags.tourism === 'artwork') return 'artwork';
  if (tags.historic === 'memorial' || tags.historic === 'monument') return 'statue';
  if (tags.amenity && AMENITY_FURNITURE.has(tags.amenity)) return tags.amenity;
  if (tags.man_made) return tags.man_made;
  return '';
}

export function normalizeOsmElements(elements: OsmElement[], origin: LngLat): Omit<WorldData, 'source'> {
  const roads: WorldRoad[] = [];
  const buildings: WorldBuilding[] = [];
  const water: WorldArea[] = [];
  const parks: WorldArea[] = [];
  const labels: WorldData['labels'] = [];
  const objects: WorldData['objects'] = [];

  for (const element of elements) {
    const tags = element.tags ?? {};
    const points = element.geometry?.map((point) => lngLatToLocal(origin, { lng: point.lon, lat: point.lat })) ?? [];
    if (tags.highway && points.length > 1 && isRenderedWay(tags.highway, tags)) {
      roads.push({ id: `osm:road:${element.id}`, kind: tags.highway, width: roadWidths[tags.highway] ?? 6, points: smoothPolyline(points) });
      if (tags.name) labels.push({ id: `osm:label:${element.id}`, text: tags.name, category: 'Road', detail: tags.highway, point: points[Math.floor(points.length / 2)] });
    } else if (tags.building && points.length > 2) {
      const explicit = Number.parseFloat(tags.height);
      const levels = Number.parseFloat(tags['building:levels']);
      const classification = String(
        tags['building:use'] ?? tags.office ?? tags.shop ?? tags.amenity ?? tags.tourism ?? tags.building,
      ).toLowerCase();
      buildings.push({
        id: `osm:building:${element.id}`,
        height: Number.isFinite(explicit) ? explicit : Number.isFinite(levels) ? levels * 3 : 12,
        rings: [points],
        properties: { ...tags, type: classification, class: classification },
        appearance: normalizeBuildingAppearance(tags),
      });
      const details = [classification, tags['building:material'], tags['building:levels'] ? `${tags['building:levels']} levels` : '']
        .filter(Boolean).join(' · ');
      labels.push({
        id: `osm:building-info:${element.id}`,
        text: tags.name ?? `${classification.replaceAll('_', ' ')} building`,
        category: 'Building', detail: details,
        point: points[Math.floor(points.length / 2)],
      });
    } else if (tags.natural === 'water' && points.length > 2) {
      water.push({ id: `osm:water:${element.id}`, kind: 'water', rings: [points] });
    } else if ((tags.leisure || tags.landuse || (tags.natural && NATURAL_GROUND.has(tags.natural))) && points.length > 2) {
      // `natural` is where woods, scrub, heath, wetland and beaches live — the ground
      // cover OSM does not consider a land *use*. Without it every forest in Nacka was
      // invisible unless someone had also tagged it landuse=forest.
      parks.push({
        id: `osm:landuse:${element.id}`,
        kind: tags.leisure ?? tags.landuse ?? tags.natural,
        rings: [points],
      });
    }
    const labelPoint = element.lon != null && element.lat != null
      ? lngLatToLocal(origin, { lng: element.lon, lat: element.lat })
      : points[Math.floor(points.length / 2)];
    if (tags.name && labelPoint && !tags.highway && !tags.building) {
      const category = tags.amenity ? 'Amenity' : tags.tourism ? 'POI' : tags.shop ? 'Shop'
        : tags.historic ? 'Historic' : tags.place ? 'Area' : tags.highway ? 'Road' : 'Place';
      const detail = [tags.amenity, tags.tourism, tags.shop, tags.historic, tags.place]
        .filter(Boolean).join(' · ');
      labels.push({ id: `osm:poi:${element.type}:${element.id}`, text: tags.name, point: labelPoint, category, detail });
    }
    if (element.type === 'node' && labelPoint) {
      const kind = objectKind(tags);
      if (kind) {
        objects.push({ id: `osm:object:${element.id}`, kind, point: labelPoint, properties: { ...tags } });
        if (!tags.name) labels.push({
          id: `osm:object-label:${element.id}`,
          text: kind.replaceAll('_', ' '), category: 'Street', detail: tags.material ?? tags.artwork_type,
          point: labelPoint,
        });
      }
    }
  }

  return { roads, buildings, water, parks, labels: labels.slice(0, 1200), objects: objects.slice(0, 6000) };
}

function rect(id: string, x: number, z: number, width: number, depth: number, kind: string): WorldArea {
  return {
    id,
    kind,
    rings: [[
      { x: x - width / 2, z: z - depth / 2 },
      { x: x + width / 2, z: z - depth / 2 },
      { x: x + width / 2, z: z + depth / 2 },
      { x: x - width / 2, z: z + depth / 2 },
    ]],
  };
}

export function createPreviewWorld(source: WorldSource): WorldData {
  const roads: WorldRoad[] = [];
  const buildings: WorldBuilding[] = [];
  const labels: WorldData['labels'] = [];
  const tint = 0;

  for (let line = -4; line <= 4; line += 1) {
    const offset = line * 72;
    roads.push({ id: `${source}:road:x:${line}`, kind: line === 0 ? 'primary' : 'residential', width: line === 0 ? 12 : 7, points: [{ x: -520, z: offset }, { x: 520, z: offset }] });
    roads.push({ id: `${source}:road:z:${line}`, kind: line === 0 ? 'primary' : 'residential', width: line === 0 ? 12 : 7, points: [{ x: offset, z: -520 }, { x: offset, z: 520 }] });
  }

  for (let gx = -4; gx < 4; gx += 1) {
    for (let gz = -4; gz < 4; gz += 1) {
      if (gx === -4 && gz > 0) continue;
      const x = gx * 72 + 36;
      const z = gz * 72 + 36;
      const margin = 12 + ((gx * 7 + gz * 11 + tint) & 3);
      const footprint = rect(`${source}:building:${gx}:${gz}`, x, z, 72 - margin * 2, 72 - margin * 2, 'building');
      buildings.push({
        ...footprint,
        height: 14 + Math.abs((gx * 17 + gz * 23 + tint) % 42),
        properties: { type: 'apartments', class: 'residential' },
      });
    }
  }

  // Deliberately not the real start-location name: this grid is the "no usable data"
  // fallback, and labelling it as the actual city would hide that from the player.
  labels.push({ id: `${source}:center`, text: 'Preview grid', point: { x: 22, z: -22 }, category: 'Area' });
  return {
    source,
    roads,
    buildings,
    water: [rect(`${source}:water`, -310, 300, 170, 460, 'water')],
    parks: [rect(`${source}:park`, 250, -185, 120, 120, 'park')],
    labels,
    objects: [],
  };
}

export function mergeWithPreview(source: WorldSource, data: Omit<WorldData, 'source'>): WorldData {
  const count = data.roads.length + data.buildings.length;
  return count > 8 ? attachEntrancesToBuildings({ source, ...data }) : createPreviewWorld(source);
}

export function ensureClosed(points: LocalPoint[]): LocalPoint[] {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  return first.x === last.x && first.z === last.z ? points : [...points, first];
}
