// scripts/lib/prefetchOptions.mjs

const DEFAULTS = {
  areas: 'all',
  emit: 'both',
  zoom: 14,
  radiusTerrain: 1_500,
  radiusBuildings: 560,
  precisionCm: 1,
  maxTiles: 32,
  corridorMaxTiles: 48,
  concurrency: 8,
  outputDir: 'vendor/worldcache',
  origin: null,
  offline: false,
  dryRun: false,
};

export function usage() {
  return `Usage: node scripts/prefetch-world.mjs -- [options]

Options:
  --areas <slug,...|all>       Which shipped areas to build (default: all)
  --emit <tiles|world|both>    What to write (default: both)
  --zoom <n>                   Tile zoom (default: 14)
  --radius-terrain <meters>    Terrain/road fetch radius (default: 1500)
  --radius-buildings <meters>  Building clip radius (default: 560)
  --precision <cm>             WorldData coordinate rounding (default: 1)
  --max-tiles <n>              Cap on tiles per radial area (default: 32)
  --corridor-max-tiles <n>     Cap on tiles per corridor area (default: 48)
  --concurrency <n>            Simultaneous tile fetches (default: 8)
  --output-dir <path>          Output root (default: vendor/worldcache)
  --origin <lng,lat>           WorldData local-metre origin (default: START_LOCATION)
  --offline                    Fail instead of fetching an uncached tile
  --dry-run                    Report what would be fetched/written; write nothing
  --help                       Show this help`;
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parsePositiveInt(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function parseOrigin(value) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw new Error('--origin must be LNG,LAT');
  return { lng: Number(match[1]), lat: Number(match[2]) };
}

function parseEmit(value) {
  if (value !== 'tiles' && value !== 'world' && value !== 'both') {
    throw new Error('--emit must be one of tiles, world, both');
  }
  return value;
}

const VALUE_OPTIONS = new Set([
  '--areas',
  '--emit',
  '--zoom',
  '--radius-terrain',
  '--radius-buildings',
  '--precision',
  '--max-tiles',
  '--corridor-max-tiles',
  '--concurrency',
  '--output-dir',
  '--origin',
]);

export function parseOptions(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') return { help: true };
    if (option === '--offline') { options.offline = true; continue; }
    if (option === '--dry-run') { options.dryRun = true; continue; }
    if (!option.startsWith('--')) throw new Error(`Unexpected argument: ${option}`);
    if (!VALUE_OPTIONS.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = requireValue(argv, index, option);
    index += 1;
    if (option === '--areas') options.areas = value === 'all' ? 'all' : value.split(',').filter(Boolean);
    else if (option === '--emit') options.emit = parseEmit(value);
    else if (option === '--zoom') options.zoom = parsePositiveInt(value, option);
    else if (option === '--radius-terrain') options.radiusTerrain = parsePositiveInt(value, option);
    else if (option === '--radius-buildings') options.radiusBuildings = parsePositiveInt(value, option);
    else if (option === '--precision') options.precisionCm = parsePositiveInt(value, option);
    else if (option === '--max-tiles') options.maxTiles = parsePositiveInt(value, option);
    else if (option === '--corridor-max-tiles') options.corridorMaxTiles = parsePositiveInt(value, option);
    else if (option === '--concurrency') options.concurrency = parsePositiveInt(value, option);
    else if (option === '--output-dir') options.outputDir = value;
    else if (option === '--origin') options.origin = parseOrigin(value);
    else throw new Error(`Unknown option: ${option}`);
  }
  return options;
}
