/**
 * Sky dome: a gradient (horizon → zenith) backdrop with a fading procedural star field
 * and a moon, replacing what used to be a single flat clear color. One large inside-out
 * sphere, recentered on the car every frame like the ground/water fallback planes so it
 * always surrounds the viewer regardless of how far the world has streamed from the origin.
 */
import * as THREE from 'three';

/** Comfortably inside the camera's far plane (2500, see svartaksiRuntime.ts) so the dome
 * never gets clipped, but far enough out that nothing in the world reads as "inside" it. */
const SKY_RADIUS = 2_400;

export const SKY_VERTEX_SHADER = `
  varying vec3 vDir;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    // The dome is a plain, unrotated sphere centered on the viewer — object-space
    // position already points in the right direction, no need for a world matrix.
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    #include <logdepthbuf_vertex>
  }
`;

export const SKY_FRAGMENT_SHADER = `
  uniform vec3 uHorizonColor;
  uniform vec3 uZenithColor;
  uniform vec3 uMoonDirection;
  uniform float uStarVisibility;

  varying vec3 vDir;

  #include <logdepthbuf_pars_fragment>

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 dir = normalize(vDir);

    // Vertical gradient: horizon color at eye level, zenith color straight up. Eased
    // (pow < 1) so the color shifts faster near the horizon, matching how a real sky
    // reads — the band right above the horizon changes more than the deep zenith does.
    float height = clamp(dir.y, 0.0, 1.0);
    vec3 color = mix(uHorizonColor, uZenithColor, pow(height, 0.55));

    // Procedural star field — a sparse hashed point per grid cell on the sphere
    // direction, no texture needed. Only above the horizon, and only once
    // uStarVisibility (driven by how far the sun has set) fades them in.
    float starHash = hash(floor(dir * 400.0));
    float star = step(0.9975, starHash) * smoothstep(0.0, 0.12, dir.y);
    color += vec3(star) * uStarVisibility;

    // Moon: a bright disc with a soft surrounding glow, aimed along uMoonDirection —
    // fades in/out with the same uStarVisibility factor as the stars.
    float moonDot = dot(dir, normalize(uMoonDirection));
    float moonDisc = smoothstep(0.9993, 0.9998, moonDot);
    float moonGlow = smoothstep(0.985, 0.9993, moonDot) * 0.3;
    vec3 moonColor = vec3(0.93, 0.95, 0.92);
    color = mix(color, moonColor, moonDisc * uStarVisibility);
    color += moonColor * moonGlow * uStarVisibility;

    gl_FragColor = vec4(color, 1.0);

    #include <logdepthbuf_fragment>
    // The renderer tone-maps and sRGB-encodes every built-in material in the frame;
    // without these the dome is graded differently from the world in front of it and
    // the horizon reads as a seam rather than a continuation of the fog.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface SkyDomeState {
  horizonColor: THREE.Color;
  zenithColor: THREE.Color;
  starVisibility: number;
  moonDirection: THREE.Vector3;
}

export interface SkyDome {
  object: THREE.Object3D;
  update(state: SkyDomeState): void;
  setAnchor(x: number, z: number): void;
  dispose(): void;
}

export function createSkyDome(): SkyDome {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 20);
  const material = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    uniforms: {
      uHorizonColor: { value: new THREE.Color(0x91aeb7) },
      uZenithColor: { value: new THREE.Color(0x2f7fb8) },
      uMoonDirection: { value: new THREE.Vector3(0, 1, 0) },
      uStarVisibility: { value: 0 },
    },
    side: THREE.BackSide,
    // Never test or write depth — a skybox has to win against nothing and lose against
    // everything, unconditionally, which depthTest can't express by itself (Three's
    // opaque-bucket sort doesn't guarantee draw order by scene position, only by
    // renderOrder). depthTest:false plus a very low renderOrder below forces the dome
    // to always draw first, so every other opaque surface (drawn after, with its own
    // normal depth test) correctly paints over it.
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'world:sky-dome';
  mesh.renderOrder = -1_000;
  // A per-instance bounding sphere check would nearly always cull this incorrectly (the
  // camera sits at its center), so skip it — the mesh is cheap enough to always submit.
  mesh.frustumCulled = false;

  return {
    object: mesh,
    update({ horizonColor, zenithColor, starVisibility, moonDirection }) {
      (material.uniforms.uHorizonColor.value as THREE.Color).copy(horizonColor);
      (material.uniforms.uZenithColor.value as THREE.Color).copy(zenithColor);
      material.uniforms.uStarVisibility.value = starVisibility;
      (material.uniforms.uMoonDirection.value as THREE.Vector3).copy(moonDirection);
    },
    setAnchor(x, z) {
      mesh.position.set(x, 0, z);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
