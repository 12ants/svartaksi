/**
 * The GLTF/Draco loaders, shared for the process.
 *
 * `DRACOLoader` is expensive to spin up (it fetches and instantiates a WASM decoder), and
 * the loader docs recommend one per application rather than one per load. That was already
 * true when the blob model was the only Draco asset; it matters more now that the model
 * library can spawn any number of GLBs, several of which are Draco-compressed.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

let sharedDracoLoader: DRACOLoader | null = null;

export function dracoLoader(): DRACOLoader {
  if (!sharedDracoLoader) sharedDracoLoader = new DRACOLoader();
  return sharedDracoLoader;
}

/** A GLTFLoader wired to the shared Draco decoder. A loader itself is cheap; the decoder
 * behind it is the part worth sharing. */
export function gltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader());
  return loader;
}
