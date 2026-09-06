import * as THREE from 'three';
import { facadeWindowNoise } from '../svartaksi/buildingFacade';
import type { SvartaksiFacadeWall } from './facadeRecords';
import type { RenderOptions } from './renderOptions';

export interface WindowLightCandidate {
  position: THREE.Vector3;
  color: THREE.Color;
  noise: number;
  litRatio: number;
  glow: number;
}

/** Two low windows per accepted wall bound both build work and subsequent selection. */
export function windowLightCandidates(wall: SvartaksiFacadeWall): WindowLightCandidate[] {
  if (!wall.layout.columns || !wall.layout.rows) return [];
  const result: WindowLightCandidate[] = [];
  const columns = new Set([Math.floor((wall.layout.columns - 1) / 3), Math.floor(2 * (wall.layout.columns - 1) / 3)]);
  for (const column of columns) {
    const left = wall.layout.startX + column * wall.profile.windowSpacingX;
    const bottom = wall.layout.startY;
    const door = wall.door;
    if (door && left < door.centerX + door.width / 2 && left + wall.profile.windowWidth > door.centerX - door.width / 2
      && bottom < door.bottom + door.height && bottom + wall.profile.windowHeight > door.bottom) continue;
    const along = left + wall.profile.windowWidth / 2 - wall.width / 2;
    result.push({
      position: new THREE.Vector3(
        wall.centerX + Math.cos(wall.yaw) * along + wall.outwardX * 0.35,
        wall.centerY - wall.height / 2 + bottom + wall.profile.windowHeight / 2,
        wall.centerZ + Math.sin(wall.yaw) * along + wall.outwardZ * 0.35,
      ),
      color: new THREE.Color(wall.profile.windowColor),
      noise: facadeWindowNoise(column, 0, wall.seed),
      litRatio: wall.profile.litRatio,
      glow: wall.profile.windowGlow ?? 0.8,
    });
  }
  return result;
}

export function createWindowLights(scene: THREE.Scene) {
  const group = new THREE.Group();
  group.name = 'window-spill';
  group.visible = false;
  const lights = Array.from({ length: 4 }, (_, index) => {
    const light = new THREE.PointLight(0xffffff, 0, 18, 2);
    light.name = `window-spill:${index}`;
    group.add(light);
    return light;
  });
  scene.add(group);
  const candidateCache = new WeakMap<SvartaksiFacadeWall, WindowLightCandidate[]>();
  const warm = new THREE.Color().setRGB(1, 0.58, 0.22);
  const cool = new THREE.Color().setRGB(0.55, 0.75, 1);

  return {
    update(walls: readonly SvartaksiFacadeWall[], options: RenderOptions, night: number, x: number, z: number) {
      // Keep the light count stable while enabled: moving between windows or changing
      // time should not compile another shader variant for every material in the city.
      group.visible = options.windowCastLight && options.facades;
      for (const light of lights) light.intensity = 0;
      if (!group.visible || night <= 0 || options.windowBrightness <= 0 || options.windowOccupancy <= 0) return;
      const nearest: { candidate: WindowLightCandidate; distance: number }[] = [];
      for (const wall of walls) {
        // Most walls are hundreds of metres away. Avoid generating window positions,
        // colors or noise samples for them, or for any wall while casting is disabled.
        if ((wall.centerX - x) ** 2 + (wall.centerZ - z) ** 2 > (45 + wall.width / 2) ** 2) continue;
        let candidates = candidateCache.get(wall);
        if (!candidates) {
          candidates = windowLightCandidates(wall);
          candidateCache.set(wall, candidates);
        }
        for (const candidate of candidates) {
          if (candidate.noise >= Math.min(1, candidate.litRatio * (0.06 + 0.94 * night) * options.windowOccupancy)) continue;
          const distance = (candidate.position.x - x) ** 2 + (candidate.position.z - z) ** 2;
          if (distance > 45 ** 2) continue;
          let slot = 0;
          while (slot < nearest.length && nearest[slot].distance <= distance) slot++;
          if (slot >= lights.length) continue;
          nearest.splice(slot, 0, { candidate, distance });
          if (nearest.length > lights.length) nearest.pop();
        }
      }
      nearest.forEach(({ candidate, distance }, index) => {
        const light = lights[index];
        light.position.copy(candidate.position);
        light.color.copy(candidate.color).lerp(options.windowWarmth < 0 ? cool : warm, Math.abs(options.windowWarmth));
        light.intensity = 24 * candidate.glow * options.windowBrightness * night * Math.min(1, (45 - Math.sqrt(distance)) / 10);
      });
    },
    dispose() {
      group.removeFromParent();
      for (const light of lights) light.dispose();
    },
  };
}
