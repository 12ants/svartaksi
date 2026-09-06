/**
 * Offline measurement of `src/models/bus1.glb`.
 *
 * The bus asset is exported one mesh per material and Draco-compressed, so nothing in it
 * is a wheel you can rotate and nothing in it can be read without a decoder. Before any
 * code splits wheels out of it, the split has to be justified by measurements taken from
 * the file itself — which is what this script produces, and why it is committed rather
 * than run once and thrown away.
 *
 * It does three things:
 *
 * 1. Decodes every primitive with the Draco decoder that ships with three, applying each
 *    node's transform so all coordinates are in the asset's own Y-up space.
 * 2. Finds connected triangle components by welding vertices on quantised position, so a
 *    "part" is defined by the mesh's own topology rather than by a guess about where a
 *    wheel ought to be.
 * 3. Reports each component's bounds, in asset space and again after `busShellScale()`,
 *    which is where the runtime actually puts them.
 *
 * Usage: `node scripts/inspect-bus-glb.mjs [path-to.glb]`
 *
 * Output is deterministic: components are reported in a fixed order (by material, then by
 * descending triangle count, then by centre), so two runs diff cleanly.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** Vertex positions are welded at this tolerance, in asset metres.
 *
 * Draco quantises positions on export, so two triangles that share a corner in the
 * authoring package come back with coordinates that agree to about the quantisation step
 * and no further. 1e-4 m is far below any real feature of a bus (a tyre sidewall is
 * ~0.02 m) and far above the quantisation noise, so it welds seams without welding a rim
 * to the arch beside it. */
const WELD_EPSILON = 1e-4;

/** `BUS_DIMENSIONS` and `BUS_ASSET_SIZE`, duplicated here on purpose.
 *
 * This script is a measuring instrument: it has to be able to report that the source of
 * truth is wrong. Importing the TypeScript modules would make it agree with them by
 * construction. Any drift shows up as a mismatch in the header it prints. */
const BUS_DIMENSIONS = { width: 2.6, height: 3.06, length: 11 };
const BUS_ASSET_SIZE = { width: 2.57, height: 3.14, length: 10.25 };

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const start = offset + 8;
    if (type === 'JSON') json = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    if (type.startsWith('BIN')) bin = buffer.subarray(start, start + length);
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

async function loadDraco() {
  const dracoPath = require.resolve('three/examples/jsm/libs/draco/draco_decoder.js');
  const source = fs.readFileSync(dracoPath, 'utf8');
  const module = { exports: {} };
  // The decoder is a UMD emscripten bundle inside an ESM-typed package, so `require` and
  // `import` both refuse it. Evaluating it with a CJS shim is the least-bad way in.
  const factory = new Function('module', 'exports', 'require', '__filename', '__dirname', source);
  factory(module, module.exports, require, dracoPath, path.dirname(dracoPath));
  return module.exports();
}

const DRACO_ATTRIBUTE = { POSITION: 'POSITION', NORMAL: 'NORMAL', TEXCOORD_0: 'TEX_COORD' };

/** Decodes one Draco-compressed primitive into flat position/normal/uv arrays plus indices. */
function decodePrimitive(draco, bytes, attributeIds) {
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  buffer.Init(bytes, bytes.length);
  const mesh = new draco.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!status.ok() || mesh.ptr === 0) throw new Error(`draco decode failed: ${status.error_msg()}`);

  const numFaces = mesh.num_faces();
  const indices = new Uint32Array(numFaces * 3);
  const faceArray = new draco.DracoInt32Array();
  for (let face = 0; face < numFaces; face += 1) {
    decoder.GetFaceFromMesh(mesh, face, faceArray);
    indices[face * 3] = faceArray.GetValue(0);
    indices[face * 3 + 1] = faceArray.GetValue(1);
    indices[face * 3 + 2] = faceArray.GetValue(2);
  }
  draco.destroy(faceArray);

  const attributes = {};
  for (const [gltfName, id] of Object.entries(attributeIds)) {
    if (!(gltfName in DRACO_ATTRIBUTE)) continue;
    const attribute = decoder.GetAttributeByUniqueId(mesh, id);
    if (!attribute) continue;
    const components = attribute.num_components();
    const count = mesh.num_points();
    const values = new draco.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attribute, values);
    const array = new Float32Array(count * components);
    for (let i = 0; i < array.length; i += 1) array[i] = values.GetValue(i);
    draco.destroy(values);
    attributes[gltfName] = { array, components };
  }

  draco.destroy(mesh);
  draco.destroy(buffer);
  draco.destroy(decoder);
  return { indices, attributes };
}

/** Node TRS to a row-major 4x4, applied to positions below. glTF quaternions are xyzw. */
function nodeMatrix(node) {
  if (node.matrix) {
    const m = node.matrix; // glTF stores column-major.
    return [
      [m[0], m[4], m[8], m[12]],
      [m[1], m[5], m[9], m[13]],
      [m[2], m[6], m[10], m[14]],
    ];
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    [(1 - (yy + zz)) * sx, (xy - wz) * sy, (xz + wy) * sz, tx],
    [(xy + wz) * sx, (1 - (xx + zz)) * sy, (yz - wx) * sz, ty],
    [(xz - wy) * sx, (yz + wx) * sy, (1 - (xx + yy)) * sz, tz],
  ];
}

function applyMatrix(matrix, x, y, z, translate) {
  const w = translate ? 1 : 0;
  return [
    matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3] * w,
    matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3] * w,
    matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3] * w,
  ];
}

/** Union-find over triangles that share a welded vertex. */
function connectedComponents(indices, positions) {
  const vertexCount = positions.length / 3;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  // Weld first: two corners at the same place are the same corner, whatever their index.
  const buckets = new Map();
  const key = (i) => {
    const q = (v) => Math.round(v / WELD_EPSILON);
    return `${q(positions[i * 3])},${q(positions[i * 3 + 1])},${q(positions[i * 3 + 2])}`;
  };
  for (let i = 0; i < vertexCount; i += 1) {
    const k = key(i);
    const seen = buckets.get(k);
    if (seen === undefined) buckets.set(k, i); else union(seen, i);
  }
  for (let i = 0; i < indices.length; i += 3) {
    union(indices[i], indices[i + 1]);
    union(indices[i], indices[i + 2]);
  }

  const groups = new Map();
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    const root = find(indices[triangle * 3]);
    let list = groups.get(root);
    if (!list) { list = []; groups.set(root, list); }
    list.push(triangle);
  }
  return [...groups.values()];
}

function bounds(triangles, indices, positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[triangle * 3 + corner];
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[vertex * 3 + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  return {
    min, max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

const f = (value) => (Math.abs(value) < 5e-5 ? '0.000' : value.toFixed(3));
const vec = (v) => `[${v.map(f).join(', ')}]`;

/**
 * Classifies every component against the four wheel cylinders.
 *
 * A wheel is a solid of revolution about its axle, so the test is exactly that: a
 * component belongs to a wheel when every one of its corners lies inside the cylinder
 * about the hub axis — within `halfWidth` along X, within `radius` of the axis in the YZ
 * plane. That rejects a wheel arch (which wraps *outside* the tyre, at a larger radius)
 * on geometry rather than on a name, which is what the plan's "all tyre/rim parts and no
 * body/trim triangles" requirement needs.
 *
 * Hubs are seeded from the `wheel` material's own components, which is the one label in
 * this asset that is not ambiguous, and grown to the tyre by scanning for the enclosing
 * component that shares the hub axis.
 */
function reportWheelAssignment(rows, scale) {
  const seedRow = rows.find((row) => row.material === 'wheel');
  console.log('## wheel assignment');
  if (!seedRow) { console.log('no `wheel` material in this asset; assignment not attempted'); console.log(''); return; }

  // Seed: the rim discs. Their YZ centre is the hub axis; their X centre is not the
  // wheel's, because a rim disc sits on the outboard face of the tyre.
  const hubs = seedRow.components.map((component) => ({
    y: component.center[1], z: component.center[2],
    seedX: [component.center[0] - component.size[0] / 2, component.center[0] + component.size[0] / 2],
    seedRadius: Math.max(component.size[1], component.size[2]) / 2,
  }));
  hubs.sort((a, b) => a.z - b.z || a.seedX[0] - b.seedX[0]);


  // Grow each hub to the largest component sharing its axis: the tyre. Its radius and
  // its X span are the wheel's, and every smaller part (rim, bolts) falls inside them.
  const AXIS_TOLERANCE = 0.02; // metres; concentricity slop between rim and tyre.
  // The bus is symmetric, so the left and right wheels of one axle share a hub axis
  // exactly. Growing has to stay on one side of the bus or it swallows both and reports a
  // 2.6m-wide wheel: a candidate must sit within this of the seed rim laterally.
  const SIDE_REACH = 0.5; // metres.
  for (const hub of hubs) {
    let radius = hub.seedRadius;
    let minX = hub.seedX[0];
    let maxX = hub.seedX[1];
    for (const row of rows) {
      if (row.material === 'interior') continue;
      for (const component of row.components) {
        if (Math.hypot(component.center[1] - hub.y, component.center[2] - hub.z) > AXIS_TOLERANCE) continue;
        const gap = Math.max(minX - (component.center[0] + component.size[0] / 2),
          (component.center[0] - component.size[0] / 2) - maxX, 0);
        if (gap > SIDE_REACH) continue;
        if (Math.max(component.size[1], component.size[2]) / 2 > radius * 2.5) continue; // An arch, not a wheel.
        // Measure the absorbed part on its vertices. A tyre's furthest vertex sits a
        // little outside half its bounding-box height (tread, and the box is axis
        // aligned while the tyre is round), and a cylinder cut to the box would clip it.
        for (const triangle of component.triangles) {
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = row.indices[triangle * 3 + corner];
            const x = row.positions[vertex * 3];
            radius = Math.max(radius, Math.hypot(row.positions[vertex * 3 + 1] - hub.y, row.positions[vertex * 3 + 2] - hub.z));
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
          }
        }
      }
    }
    hub.radius = radius;
    hub.x = (minX + maxX) / 2;
    hub.halfWidth = (maxX - minX) / 2;
  }

  console.log(`hubs: ${hubs.length}  (side +1 is the bus's left, +Z is its front)`);
  for (const [i, hub] of hubs.entries()) {
    const front = hub.z > 0;
    const side = hub.x > 0 ? 1 : -1;
    console.log(`  [${i}] ${front ? 'front' : 'rear '} ${side > 0 ? 'left ' : 'right'}  side ${side > 0 ? '+1' : '-1'}`
      + `  asset centre [${f(hub.x)}, ${f(hub.y)}, ${f(hub.z)}]  radius ${f(hub.radius)}  halfWidth ${f(hub.halfWidth)}`);
    console.log(`       scaled centre [${f(hub.x * scale[0])}, ${f(hub.y * scale[1])}, ${f(hub.z * scale[2])}]`
      + `  scaled radius y ${f(hub.radius * scale[1])} z ${f(hub.radius * scale[2])}  scaled halfWidth ${f(hub.halfWidth * scale[0])}`);
    // Full precision, because these are the numbers the extraction constants are copied
    // from and a rounded metre is not a measurement.
    console.log(`       exact asset x ${hub.x} y ${hub.y} z ${hub.z} radius ${hub.radius} halfWidth ${hub.halfWidth}`);
  }
  const front = hubs.filter((hub) => hub.z > 0);
  const rear = hubs.filter((hub) => hub.z <= 0);
  if (front.length && rear.length) {
    const wheelbase = front[0].z - rear[0].z;
    console.log(`asset wheelbase ${f(wheelbase)} -> scaled ${f(wheelbase * scale[2])}`);
    const track = front.length > 1 ? Math.abs(front[0].x - front[1].x) : 0;
    console.log(`asset track ${f(track)} -> scaled ${f(track * scale[0])}`);
  }
  console.log('');

  // Every component, against every cylinder, measured on real vertices rather than on
  // bounding-box corners: a tyre is an annulus, and the corners of its box are a good
  // 40% further from the axle than any of its actual geometry. Testing the box would
  // reject the very part this is meant to find.
  const verdicts = { inside: [], straddles: [] };
  for (const row of rows) {
    for (const [index, component] of row.components.entries()) {
      for (const [hubIndex, hub] of hubs.entries()) {
        let worstRadius = 0;
        let bestRadius = Infinity;
        let insideX = true;
        let overlapsX = false;
        for (const triangle of component.triangles) {
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = row.indices[triangle * 3 + corner];
            const x = row.positions[vertex * 3];
            const radius = Math.hypot(row.positions[vertex * 3 + 1] - hub.y, row.positions[vertex * 3 + 2] - hub.z);
            if (radius > worstRadius) worstRadius = radius;
            if (radius < bestRadius) bestRadius = radius;
            const withinX = x >= hub.x - hub.halfWidth - 1e-6 && x <= hub.x + hub.halfWidth + 1e-6;
            if (withinX) overlapsX = true; else insideX = false;
          }
        }
        if (insideX && worstRadius <= hub.radius + 1e-6) {
          verdicts.inside.push({ row, index, component, hubIndex, worstRadius });
        } else if (overlapsX && bestRadius <= hub.radius) {
          verdicts.straddles.push({ row, index, component, hubIndex, worstRadius });
        }
      }
    }
  }

  const perHub = hubs.map(() => ({ triangles: 0, components: 0, materials: new Set() }));
  for (const hit of verdicts.inside) {
    perHub[hit.hubIndex].triangles += hit.component.triangles.length;
    perHub[hit.hubIndex].components += 1;
    perHub[hit.hubIndex].materials.add(hit.row.material);
  }
  console.log('contained components per hub (these are the wheel):');
  for (const [i, hub] of perHub.entries()) {
    console.log(`  [${i}] components ${hub.components}  triangles ${hub.triangles}  materials {${[...hub.materials].sort().join(', ')}}`);
  }
  const unassigned = [];
  for (const row of rows) {
    if (row.material === 'interior') continue;
    if (row.material !== 'wheel') continue;
    for (let index = 0; index < row.components.length; index += 1) {
      const claimed = verdicts.inside.some((hit) => hit.row === row && hit.index === index);
      if (!claimed) unassigned.push(`${row.material} [${index}]`);
    }
  }
  console.log(`unassigned \`wheel\` material components: ${unassigned.length === 0 ? 'none' : unassigned.join(', ')}`);
  const total = perHub.reduce((sum, hub) => sum + hub.triangles, 0);
  const assetTriangles = rows.reduce((sum, row) => sum + row.triangleCount, 0);
  console.log(`wheel triangles ${total} of ${assetTriangles} in the asset`);
  console.log('');
  console.log('components that reach into a cylinder without being contained (these are NOT the wheel):');
  if (verdicts.straddles.length === 0) console.log('  none');
  for (const hit of verdicts.straddles) {
    console.log(`  hub [${hit.hubIndex}] <- ${hit.row.material} [${hit.index}] tris ${hit.component.triangles.length}`
      + `  centre ${vec(hit.component.center)}  size ${vec(hit.component.size)}  worst corner radius ${f(hit.worstRadius)}`);
  }
  console.log('');
}

async function main() {
  const target = process.argv[2] ?? path.join(repoRoot, 'src/models/bus1.glb');
  const bytes = fs.readFileSync(target);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const { json, bin } = parseGlb(bytes);
  const draco = await loadDraco();

  console.log(`# ${path.relative(repoRoot, target)}`);
  console.log(`bytes: ${bytes.length}`);
  console.log(`sha256: ${sha256}`);
  console.log(`generator: ${json.asset.generator}`);
  console.log(`extensionsRequired: ${JSON.stringify(json.extensionsRequired ?? [])}`);
  console.log(`meshes: ${json.meshes.length}  nodes: ${json.nodes.length}  materials: ${json.materials.length}  textures: ${(json.textures ?? []).length}  images: ${(json.images ?? []).length}`);
  console.log(`scale applied below: BUS_DIMENSIONS/BUS_ASSET_SIZE = [${f(BUS_DIMENSIONS.width / BUS_ASSET_SIZE.width)}, ${f(BUS_DIMENSIONS.height / BUS_ASSET_SIZE.height)}, ${f(BUS_DIMENSIONS.length / BUS_ASSET_SIZE.length)}]`);
  console.log('');

  const scale = [
    BUS_DIMENSIONS.width / BUS_ASSET_SIZE.width,
    BUS_DIMENSIONS.height / BUS_ASSET_SIZE.height,
    BUS_DIMENSIONS.length / BUS_ASSET_SIZE.length,
  ];

  const rows = [];
  const whole = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  for (const [nodeIndex, node] of json.nodes.entries()) {
    if (node.mesh === undefined) continue;
    const matrix = nodeMatrix(node);
    const mesh = json.meshes[node.mesh];
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      const dracoExtension = primitive.extensions?.KHR_draco_mesh_compression;
      if (!dracoExtension) throw new Error('uncompressed primitives are not handled; extend this script');
      const view = json.bufferViews[dracoExtension.bufferView];
      const start = (view.byteOffset ?? 0);
      const slice = bin.subarray(start, start + view.byteLength);
      const { indices, attributes } = decodePrimitive(draco, slice, dracoExtension.attributes);
      const source = attributes.POSITION.array;
      const positions = new Float32Array(source.length);
      for (let i = 0; i < source.length; i += 3) {
        const [x, y, z] = applyMatrix(matrix, source[i], source[i + 1], source[i + 2], true);
        positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
      }
      for (let i = 0; i < positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
          whole.min[axis] = Math.min(whole.min[axis], positions[i + axis]);
          whole.max[axis] = Math.max(whole.max[axis], positions[i + axis]);
        }
      }

      const material = json.materials[primitive.material]?.name ?? `material-${primitive.material}`;
      const components = connectedComponents(indices, positions);
      const measured = components.map((triangles) => ({ triangles, ...bounds(triangles, indices, positions) }));
      measured.sort((a, b) => b.triangles.length - a.triangles.length
        || a.center[0] - b.center[0] || a.center[1] - b.center[1] || a.center[2] - b.center[2]);
      rows.push({
        node: node.name ?? `node-${nodeIndex}`,
        nodeIndex, primitiveIndex, material, indices, positions,
        triangleCount: indices.length / 3,
        vertexCount: positions.length / 3,
        hasNormal: 'NORMAL' in attributes,
        hasUv: 'TEXCOORD_0' in attributes,
        components: measured,
      });
    }
  }
  rows.sort((a, b) => a.material.localeCompare(b.material));

  console.log('## whole asset, node transforms applied');
  const wholeSize = [0, 1, 2].map((a) => whole.max[a] - whole.min[a]);
  console.log(`min ${vec(whole.min)}  max ${vec(whole.max)}  size ${vec(wholeSize)}`);
  console.log(`size after busShellScale ${vec(wholeSize.map((v, a) => v * scale[a]))}`);
  console.log('');

  reportWheelAssignment(rows, scale);

  for (const row of rows) {
    console.log(`## ${row.material}  (node ${row.node}, mesh ${row.nodeIndex}, prim ${row.primitiveIndex})`);
    console.log(`triangles ${row.triangleCount}  vertices ${row.vertexCount}  normals ${row.hasNormal}  uvs ${row.hasUv}  components ${row.components.length}`);
    for (const [i, component] of row.components.entries()) {
      const scaled = component.center.map((v, a) => v * scale[a]);
      const scaledSize = component.size.map((v, a) => v * scale[a]);
      console.log(`  [${String(i).padStart(2)}] tris ${String(component.triangles.length).padStart(5)}`
        + `  center ${vec(component.center)}  size ${vec(component.size)}`
        + `  | scaled center ${vec(scaled)}  size ${vec(scaledSize)}`);
    }
    console.log('');
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
