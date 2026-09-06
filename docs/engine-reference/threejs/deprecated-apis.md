# three.js / R3F — Deprecated API Quick Reference

Last verified: 2026-09-06

"Don't use X → use Y" lookup, condensed from `breaking-changes.md`. Check here before
writing new code that touches these APIs.

| Don't use | Use instead | Since |
|---|---|---|
| `PCFSoftShadowMap` (WebGLRenderer) | `PCFShadowMap` (soft by default now) | r182 |
| `Clock` | `Timer` | r183 |
| `RGBELoader` | `HDRLoader` | r180 |
| `RGBMLoader` | `EXRLoader` / `HDRLoader` / `HDRCubeTextureLoader` / `UltraHDRLoader` | r180 |
| `ParametricGeometries` (wrapper classes) | `ParametricFunctions` | r175 |
| `CapsuleGeometry.length` (property read) | `CapsuleGeometry.height` | r176 |
| `TextGeometry.height` (property read) | `TextGeometry.depth` | r163 |
| `WebGLMultipleRenderTargets` | render target `count` property | r162 |
| `Matrix3.translate() / .scale() / .rotate()` | manual matrix composition | r185 |
| `Matrix4.determinant3x3()` | `Matrix4.determinantAffine()` | r185 |
| `SVGLoader.createShapes()` | `shapePaths.toShapes()` | r185 |
| `WebGLCubeRenderTarget` (with WebGPURenderer) | `CubeRenderTarget` | r183 |
| WebGL 1 context / fallback paths | WebGL 1 is unsupported — WebGL2 or WebGPU only | r163 |
| Relying on stencil buffer without requesting it | request `stencil: true` explicitly | r163 |
| `build/three.js` UMD import | ES Modules (`import * as THREE from 'three'`) | r161 |

## React Three Fiber v8 → v9

| Don't use | Use instead |
|---|---|
| `import { Props } from '@react-three/fiber'` | `import { CanvasProps } from '@react-three/fiber'` |
| `import { MeshProps } from '@react-three/fiber'` | `ThreeElements['mesh']` |
| `Object3DNode` / `BufferGeometryNode` / `MaterialNode` / `LightNode` | `ThreeElement<typeof YourClass>` |
| `declare global { namespace JSX { interface IntrinsicElements {...} } }` for custom R3F elements | `declare module '@react-three/fiber' { interface ThreeElements {...} }` |
| `gl={(canvas) => new WebGLRenderer({ canvas })}` | `gl={(props) => new WebGLRenderer(props)}` |
| Relying on R3F's implicit texture `colorSpace = SRGBColorSpace` | Set `texture.colorSpace = THREE.SRGBColorSpace` explicitly |
| Nested `<StrictMode>` inside `<Canvas>` when an ancestor already wraps it | Remove the inner one — StrictMode now inherits from the React tree |

## Verified clean in this codebase (as of 2026-09-06)

A grep for the deprecated APIs above across `src/` found no problematic usages:

- `CapsuleGeometry` constructor calls in `bonfireModel.ts`, `dogModel.ts`,
  `personModel.ts` use only constructor arguments (radius, length, segments), not
  the deprecated `.length` property read — unaffected.
- `PCFSoftShadowMap` deprecation is already correctly documented in-code at
  `src/svartaksi/svartaksiRuntime.tsx:3980`, and the renderer is configured for
  `PCFShadowMap` instead.
- No usage found of `RGBELoader`, `ParametricGeometries`, `WebGLMultipleRenderTargets`,
  `TextGeometry`, `MeshProps`, or old-style R3F `Props` imports.
