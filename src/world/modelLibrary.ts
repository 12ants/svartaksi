/**
 * The catalogue of spawnable GLB models, served from the companion repository
 * `12ants/models` rather than vendored into this one.
 *
 * Two reasons it is remote. The assets are ~12MB and grow with every model added, which
 * is a lot to carry in a repo whose whole build is under 4MB; and the point of a model
 * library is that adding a `.glb` to it makes the model available, without a change to
 * this codebase and a redeploy.
 *
 * That means the catalogue is *discovered*, not declared — `listRemoteModels` reads the
 * repository's contents listing. Discovery can fail (offline, GitHub's unauthenticated
 * 60-per-hour rate limit, a blocked host), so `FALLBACK_MODELS` is what the repository
 * held when this was written and is what the picker falls back to. A stale fallback shows
 * a model that 404s on spawn, which is a far better failure than an empty picker with no
 * explanation.
 *
 * Everything here is pure and network-free except `listRemoteModels`, whose fetch is
 * injected — so the parsing, the URL rules and the fallback are all testable.
 */

export const MODEL_REPO_OWNER = '12ants';
export const MODEL_REPO_NAME = 'models';
export const MODEL_REPO_BRANCH = 'main';

/** GitHub's contents API for the repository root. Public and CORS-enabled; unauthenticated
 * callers get 60 requests an hour, which is ample for a listing fetched once per session. */
export function modelListingUrl(): string {
  return `https://api.github.com/repos/${MODEL_REPO_OWNER}/${MODEL_REPO_NAME}/contents`;
}

/**
 * Raw file URL for one model. `raw.githubusercontent.com` serves
 * `access-control-allow-origin: *`, which is what makes a browser `GLTFLoader` able to
 * fetch these at all — the ordinary github.com file view does not.
 */
export function modelFileUrl(fileName: string): string {
  return `https://raw.githubusercontent.com/${MODEL_REPO_OWNER}/${MODEL_REPO_NAME}`
    + `/${MODEL_REPO_BRANCH}/${encodeURIComponent(fileName)}`;
}

export interface RemoteModel {
  /** The file name in the repository, which is also this model's stable id. */
  fileName: string;
  /** A human-readable name for the picker: `low_poly_cars_simple.glb` -> "Low poly cars simple". */
  label: string;
  url: string;
  /** Bytes, where the listing reported it — shown so a 3MB model is a deliberate choice. */
  bytes: number | null;
}

/** `kermit_the_frog_dancing_4.glb` -> `Kermit the frog dancing 4`. Underscores, hyphens and
 * the extension are the only things this repository's names actually use. */
export function modelLabel(fileName: string): string {
  const stem = fileName.replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim();
  if (!stem) return fileName;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

export function toRemoteModel(fileName: string, bytes: number | null = null): RemoteModel {
  return { fileName, label: modelLabel(fileName), url: modelFileUrl(fileName), bytes };
}

/**
 * The models the repository held when this was written, in the order the picker shows
 * them. Only used when discovery fails — see the module comment.
 */
export const FALLBACK_MODELS: readonly RemoteModel[] = [
  '4818.glb',
  'bus_compressed.glb',
  'kermit_running.glb',
  'kermit_the_frog.glb',
  'kermit_the_frog_dancing_4.glb',
  'low-poly_man.glb',
  'low_poly_cars_simple.glb',
  'low_poly_soviet_nbc_suit.glb',
  'lowpoly_bus-optimized.glb',
  'saab901-optimized.glb',
  'simple_low_poly_character.glb',
].map((fileName) => toRemoteModel(fileName));

/**
 * Turns a GitHub contents listing into the catalogue: `.glb` files only, sorted by name so
 * the picker's order does not depend on what the API happened to return first.
 *
 * Defensive about the shape on purpose — this is third-party JSON crossing a trust
 * boundary, and an unexpected payload should yield an empty catalogue (and therefore the
 * fallback) rather than throwing inside a React render.
 */
export function parseModelListing(payload: unknown): RemoteModel[] {
  if (!Array.isArray(payload)) return [];
  const models: RemoteModel[] = [];
  for (const raw of payload) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type !== 'file') continue;
    const fileName = entry.name;
    if (typeof fileName !== 'string' || !/\.glb$/i.test(fileName)) continue;
    models.push(toRemoteModel(fileName, typeof entry.size === 'number' ? entry.size : null));
  }
  return models.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/**
 * The catalogue, discovered if possible and fallen back to if not. Never rejects: a picker
 * that throws on a rate-limited API is worse than one showing last-known-good contents,
 * and the caller has no better answer than the fallback either way.
 */
export async function listRemoteModels(
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: readonly RemoteModel[]; discovered: boolean }> {
  try {
    const response = await fetchImpl(modelListingUrl(), {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return { models: FALLBACK_MODELS, discovered: false };
    const models = parseModelListing(await response.json());
    // An empty result is a listing we did not understand, not a repository with no models
    // — falling back is the safer reading of both.
    if (!models.length) return { models: FALLBACK_MODELS, discovered: false };
    return { models, discovered: true };
  } catch {
    return { models: FALLBACK_MODELS, discovered: false };
  }
}

/**
 * How a model of unknown provenance is made to fit the world.
 *
 * A library anyone can drop a `.glb` into has no shared convention for scale, origin or
 * orientation: one export is in centimetres, the next is a 40-unit car, the next is centred
 * on its own middle rather than its feet. Spawning them raw gives a speck or a skyscraper,
 * half of them buried to the waist.
 *
 * So every spawn is normalised from its own bounding box: scaled so its **largest**
 * dimension matches `targetSize`, then translated so it is centred horizontally on the
 * spawn point with its underside resting exactly on the ground.
 *
 * Largest dimension, not height. Height was the first rule and it is wrong for anything
 * wider than it is tall: a car is about a metre and a half high and four long, so scaling
 * its *height* to 3m stretched it into a twelve-metre limousine towering over the bus
 * parked next to it. Fitting the longest axis instead guarantees the one property that
 * makes a browse-and-spawn picker usable — whatever you pick lands inside a box of known
 * size, visible and not absurd — regardless of the shape it turns out to be.
 */
export interface ModelFit {
  scale: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export function modelFitTransform(
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
  targetSize: number,
): ModelFit {
  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
  // A degenerate or non-finite box (an empty scene, a broken export) must not produce a
  // NaN transform that quietly removes the model from the scene graph's bounds.
  const usable = Number.isFinite(extent) && extent > 1e-6;
  const scale = usable ? targetSize / extent : 1;
  return {
    scale,
    offsetX: usable ? -((min.x + max.x) / 2) * scale : 0,
    offsetY: usable ? -min.y * scale : 0,
    offsetZ: usable ? -((min.z + max.z) / 2) * scale : 0,
  };
}
