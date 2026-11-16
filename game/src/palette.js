// BOATHOUSE palette — warm Mediterranean dusk: peach sky, warm stone,
// pink / orange / beige / blue facades, sodium amber lights. Bright enough
// to read at a glance, still a harbour evening.
// canvas: warm dusk sky / fog   surface: warm stone   hairline: steel edges
// ink: off-white signs      muted: cool grey       accent: sodium amber
// siteA: cyan beacon        siteB: amber beacon    enemy: rust orange
import * as THREE from 'three';

export const PALETTE = {
  canvas: 0x46536e,
  surface: 0x6a6257,
  hairline: 0x8d99ab,
  ink: 0xf2efe8,
  muted: 0xc2cbd6,
  accent: 0xf5a623,
  siteA: 0x22d3ee,
  siteB: 0xf59e0b,
  enemy: 0xf07f2e,
  ally: 0x2dd4bf,
  containerA: 0x4a9ab0,
  containerB: 0xb07f45,
  containerC: 0x71869e,
  crate: 0xbd9257,
  wall: 0xe8d5b0,
  floor: 0x8a7a66,
  facadePink: 0xd98a8a,
  facadeOrange: 0xe09a5a,
  facadeBeige: 0xe8d5b0,
  facadeBlue: 0x7aa8c8,
  roof: 0xb05a3a,
  wood: 0x8a6a42,
};

const cache = new Map();

export function mat(color, opts = {}) {
  const key = color + '|' + (opts.rough ?? 0.85) + '|' + (opts.metal ?? 0.05) + '|' + (opts.emissive ?? 0);
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.85,
      metalness: opts.metal ?? 0.05,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
    });
    cache.set(key, m);
  }
  return m;
}

export function glowMat(color, intensity = 1.6) {
  const key = 'glow' + color + intensity;
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    m.userData.intensity = intensity;
    cache.set(key, m);
  }
  return m;
}
