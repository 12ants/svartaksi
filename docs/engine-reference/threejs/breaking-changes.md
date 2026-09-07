# three.js Breaking Changes: r160 → r185 (+ R3F v8 → v9)

Last verified: 2026-09-06

Sourced from the official three.js migration guide and GitHub release notes.
Chronological, newest first within each library. Only changes that could plausibly
affect this project's code (WebGLRenderer path, materials, geometry, loaders, R3F
JSX) are kept in detail; changes to unrelated subsystems (XR hand-tracking, LDraw,
MMD, VTK/USDZ loaders, etc.) are omitted since this project doesn't touch them.

## react-three/fiber v8 → v9

- **`Props` → `CanvasProps`**: the Canvas prop type was renamed.
- **`MeshProps` and friends removed**: hardcoded per-element prop types
  (`MeshProps`, `Object3DNode`, `BufferGeometryNode`, `MaterialNode`, `LightNode`)
  are gone. Use `ThreeElements['mesh']` etc., or the unified `ThreeElement<T>` for
  custom extensions.
- **Global JSX namespace declarations no longer work** (React 19 deprecated them).
  Custom element type augmentation must go through `declare module
  '@react-three/fiber' { interface ThreeElements { ... } }`, not `declare global {
  namespace JSX { ... } }`.
- **StrictMode now inherits from the surrounding React tree** instead of needing a
  separate declaration inside `<Canvas>`. This can surface previously-hidden
  double-invocation bugs in effects.
- **Texture color-space auto-sRGB removed**: R3F no longer silently sets
  `colorSpace` on textures — behavior now matches vanilla three.js. Anything
  relying on implicit sRGB conversion needs `texture.colorSpace =
  THREE.SRGBColorSpace` set explicitly.
- **`gl` prop callback signature changed**: it now receives the full constructor
  props object, not just a canvas: `gl={(props) => new WebGLRenderer(props)}`
  instead of `gl={(canvas) => new WebGLRenderer({ canvas })}`.
- **`useLoader`** now supports reusing external loader instances for pooling.

## three.js r184 → r185 (current pin)

- `Matrix3.translate()`, `.scale()`, `.rotate()` deprecated.
- `Matrix4.determinant3x3()` renamed to `determinantAffine()`.
- `WebGPURenderer` premultiplied alpha handling changed — set an opaque background
  via `Scene.background` or `renderer.setClearColor()` to avoid new blending
  artifacts (not applicable to this project's WebGLRenderer path, but relevant if a
  WebGPU migration is ever considered).
- `SVGLoader.createShapes()` deprecated → `shapePaths.toShapes()`.
- `GTAONode` now computes physically-correct (darker, wider-reaching) ambient
  occlusion — lower `radius`/`scale` to compensate if AO is in use.
- `Object3D.updateWorldMatrix()` now honors `matrixWorldNeedsUpdate` — if any code
  manually sets `.matrix` with `matrixAutoUpdate = false` and expects
  `updateWorldMatrix()` to still propagate, it must also set
  `matrixWorldNeedsUpdate = true`. This caused real breakage for other three.js
  users (see the r185 forum thread) and is worth checking if any camera-rig or
  physics-sync code manually drives object matrices.

## r183 → r184

- `FBXLoader` now auto-converts +Z-up models to +Y-up; remove any manual
  compensating rotation applied to FBX imports.
- Pixel storage now goes through `renderer.state.pixelStorei()` instead of raw
  WebGL2 context calls.
- `FileLoader.load()` / `ImageBitmapLoader.load()` no longer return a value — must
  use the `onLoad()` callback.

## r182 → r183

- `Clock` deprecated → use `Timer`.
- `PostProcessing` renamed to `RenderObjectPipeline`.
- `WebGLCubeRenderTarget` incompatible with `WebGPURenderer` → `CubeRenderTarget`.
- `Sky`/`SkyMesh` legacy gamma correction removed — visual appearance change is
  irreversible (relevant if this project uses the `Sky` addon for its city sky).

## r181 → r182

- `PCFSoftShadowMap` deprecated in `WebGLRenderer` → use `PCFShadowMap` (now soft by
  default). **Already correctly handled in this codebase** — see
  `src/svartaksi/svartaksiRuntime.tsx:3980`.

## r179 → r180

- `RGBELoader` renamed to `HDRLoader`.
- `RGBMLoader` removed entirely — migrate to `EXRLoader`, `HDRLoader`,
  `HDRCubeTextureLoader`, or `UltraHDRLoader`.

## r175 → r176

- `CapsuleGeometry.length` (the property) renamed to `.height`. Note: this is the
  instance property, not the constructor argument — `new
  THREE.CapsuleGeometry(radius, length, capSegments, radialSegments)` (as used in
  `src/svartaksi/{bonfireModel,dogModel,personModel}.ts`) is unaffected; only code
  reading `geometry.length` after construction needs `geometry.height` instead.

## r174 → r175

- `ParametricGeometries` → `ParametricFunctions` (only the parametric functions
  remain; the wrapper geometry classes were removed).

## r162 → r163

- **WebGL 1 support removed entirely from `WebGLRenderer`** — if any fallback path,
  feature-detection, or old device support code assumes WebGL1 is available, it
  will silently fail. Worth an explicit check since this project targets browsers
  broadly (mobile included, per `technical-preferences.md`).
- Stencil context attribute default flipped to `false` in both renderers — anything
  relying on stencil buffers (portal/mirror effects, outline shaders) needs it
  requested explicitly now.
- `TextGeometry.height` (the property) renamed to `.depth`.

## r161 → r162

- `WebGLMultipleRenderTargets` removed — use the `count` property on render target
  classes instead.

## r160 → r161

- UMD build files (`build/three.js`, `build/three.min.js`) removed — ES Modules
  only. Not applicable here since the project already imports `three` as an ESM
  package via Vite.
