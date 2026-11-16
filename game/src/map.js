// BOATHOUSE — an original Mediterranean harbour-town map. Three lanes
// (west containers, mid crane alley, east warehouse dock), two bomb sites,
// one mid plaza. Warm pink / orange / beige / blue facades, wooden docks,
// boats beyond the north quay. x: east-west (-32..32), z: north-south
// (-22..22). Attackers spawn south (z +18), defenders north (z -18). All
// geometry is boxes sharing a few materials; every solid is also an AABB
// collider used by movement, LOS and shooting. No names, art or layout from
// any commercial game.
import * as THREE from 'three';
import { PALETTE, mat, glowMat } from './palette.js';

// Collider: {x0,z0,x1,z1,h, kind} — kind picks the material.
const COLLIDERS = [
  // Outer walls
  { x0: -32, z0: -22, x1: 32, z1: -21, h: 4, kind: 'wall' },
  { x0: -32, z0: 21, x1: 32, z1: 22, h: 4, kind: 'wall' },
  { x0: -32, z0: -22, x1: -31, z1: 22, h: 4, kind: 'wall' },
  { x0: 31, z0: -22, x1: 32, z1: 22, h: 4, kind: 'wall' },
  // Mid divider (z 1.5..2.5) with three chokes: west -22..-18, mid -2..2, east 18..22
  { x0: -32, z0: 1.5, x1: -22, z1: 2.5, h: 3.2, kind: 'wall' },
  { x0: -18, z0: 1.5, x1: -2, z1: 2.5, h: 3.2, kind: 'wall' },
  { x0: 2, z0: 1.5, x1: 18, z1: 2.5, h: 3.2, kind: 'wall' },
  { x0: 22, z0: 1.5, x1: 32, z1: 2.5, h: 3.2, kind: 'wall' },
  // Site A — container yard (west)
  { x0: -28, z0: -12, x1: -22, z1: -9, h: 2.6, kind: 'contA' },
  { x0: -28, z0: -4, x1: -25, z1: -1, h: 2.6, kind: 'contB' },
  { x0: -16, z0: -14, x1: -13, z1: -11, h: 1.2, kind: 'crate' },
  { x0: -26, z0: -2, x1: -24, z1: 0, h: 1.2, kind: 'crate' },
  { x0: -30, z0: -8, x1: -28, z1: -6, h: 2.4, kind: 'contC' },
  // Site B — warehouse dock (east)
  { x0: 22, z0: -12, x1: 28, z1: -9, h: 2.6, kind: 'contB' },
  { x0: 25, z0: -4, x1: 28, z1: -1, h: 2.6, kind: 'contA' },
  { x0: 13, z0: -14, x1: 16, z1: -11, h: 1.2, kind: 'crate' },
  { x0: 24, z0: -2, x1: 26, z1: 0, h: 1.2, kind: 'crate' },
  { x0: 28, z0: -8, x1: 30, z1: -6, h: 2.4, kind: 'contC' },
  // Mid crane legs (flank the mid choke, overhead beam is visual only)
  { x0: -4, z0: -1, x1: -3, z1: 1, h: 5, kind: 'wall' },
  { x0: 3, z0: -1, x1: 4, z1: 1, h: 5, kind: 'wall' },
  // Mid crates (kept off the mid lane's centre line so bots can walk it)
  { x0: -5, z0: 6, x1: -3, z1: 8, h: 1.2, kind: 'crate' },
  { x0: 1, z0: -6, x1: 3, z1: -4, h: 1.2, kind: 'crate' },
  // Lane crates
  { x0: -14, z0: 10, x1: -12, z1: 12, h: 1.2, kind: 'crate' },
  { x0: -20, z0: 8, x1: -18, z1: 10, h: 1.2, kind: 'crate' },
  { x0: 12, z0: 10, x1: 14, z1: 12, h: 1.2, kind: 'crate' },
  { x0: 18, z0: 8, x1: 20, z1: 10, h: 1.2, kind: 'crate' },
  { x0: -4, z0: 13, x1: -2, z1: 15, h: 1.2, kind: 'crate' },
  // North connector crates (kept off the hold-to-mid lines)
  { x0: -8, z0: -16, x1: -6, z1: -14, h: 1.2, kind: 'crate' },
  { x0: 6, z0: -16, x1: 8, z1: -14, h: 1.2, kind: 'crate' },
];

export const SITES = {
  A: { id: 'A', x: -24, z: -7, r: 5.5, color: PALETTE.siteA, name: 'SITE A — FISH MARKET' },
  B: { id: 'B', x: 24, z: -7, r: 5.5, color: PALETTE.siteB, name: 'SITE B — BOATHOUSE' },
};

export const SPAWNS = {
  attack: [{ x: -4, z: 18 }, { x: -1.5, z: 19 }, { x: 1.5, z: 19 }, { x: 4, z: 18 }, { x: 0, z: 16.5 }],
  defend: [{ x: -4, z: -18 }, { x: -1.5, z: -19 }, { x: 1.5, z: -19 }, { x: 4, z: -18 }, { x: 0, z: -16.5 }],
};

// Waypoint graph for bot navigation. Nodes sit in open space; edges are
// straight walkable lines (checked against colliders at build time).
const NODES = [
  ['attSpawn', 0, 18], ['defSpawn', 0, -18],
  ['wLane1', -14, 14], ['wLane2', -22, 14], ['wGap', -20, 2], ['wSite', -24, -7],
  ['eLane1', 14, 14], ['eLane2', 22, 14], ['eGap', 20, 2], ['eSite', 24, -7],
  ['mid1', 0, 10], ['mid2', 0, 2], ['midPlaza', 0, -8],
  ['plazaA', -12, -8], ['plazaB', 12, -8],
  ['aHold1', -18, -12], ['aHold2', -28, -13], ['bHold1', 18, -12], ['bHold2', 28, -13],
  ['midHold', 0, -14], ['wLaneMid', -8, 14], ['eLaneMid', 8, 14],
];
const EDGES = [
  ['attSpawn', 'wLaneMid'], ['attSpawn', 'mid1'], ['attSpawn', 'eLaneMid'],
  ['wLaneMid', 'wLane1'], ['eLaneMid', 'eLane1'],
  ['wLane1', 'wLane2'], ['wLane2', 'wGap'], ['wGap', 'wSite'],
  ['eLane1', 'eLane2'], ['eLane2', 'eGap'], ['eGap', 'eSite'],
  ['mid1', 'mid2'], ['mid2', 'midPlaza'],
  ['midPlaza', 'plazaA'], ['midPlaza', 'plazaB'], ['midPlaza', 'midHold'],
  ['plazaA', 'wSite'], ['plazaB', 'eSite'],
  ['wSite', 'aHold1'], ['aHold1', 'aHold2'], ['eSite', 'bHold1'], ['bHold1', 'bHold2'],
  ['defSpawn', 'aHold1'], ['defSpawn', 'midHold'], ['defSpawn', 'bHold1'],
];

export function buildWaypoints() {
  const byId = new Map();
  for (const [id, x, z] of NODES) byId.set(id, { id, x, z, edges: [] });
  for (const [a, b] of EDGES) {
    byId.get(a).edges.push(b);
    byId.get(b).edges.push(a);
  }
  return byId;
}

// BFS path between waypoint ids (returns node ids, start included).
export function findPath(waypoints, fromId, toId) {
  if (fromId === toId) return [fromId];
  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of waypoints.get(cur).edges) {
      if (!prev.has(nb)) {
        prev.set(nb, cur);
        if (nb === toId) {
          const path = [toId];
          let p = cur;
          while (p) { path.unshift(p); p = prev.get(p); }
          return path;
        }
        queue.push(nb);
      }
    }
  }
  return [fromId, toId];
}

export function nearestNode(waypoints, x, z) {
  let best = null;
  let bestD = Infinity;
  for (const n of waypoints.values()) {
    const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

// 2D slab test: does the segment (x0,z0)->(x1,z1) at heights y0->y1 cross a box?
function segmentHitsBox(x0, z0, y0, x1, z1, y1, b) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dy = y1 - y0;
  let tmin = 0;
  let tmax = 1;
  const axes = [
    [dx, x0, b.x0, b.x1],
    [dz, z0, b.z0, b.z1],
  ];
  for (const [d, o, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  // Height at the crossing point must be below the box top.
  const yAt = y0 + dy * Math.max(0, tmin);
  return yAt < b.h;
}

export function segmentBlocked(ax, ay, az, bx, by, bz) {
  for (const c of COLLIDERS) {
    if (segmentHitsBox(ax, az, ay, bx, bz, by, c)) return true;
  }
  return false;
}

// Move a circle (radius r, height h, feet at y) by (dx,dz), axis by axis,
// sliding along walls. Returns nothing; mutates pos {x,z}.
export function collideMove(pos, r, h, y, dx, dz) {
  const nx = pos.x + dx;
  if (!hitsAny(nx, pos.z, r, h, y)) pos.x = nx;
  const nz = pos.z + dz;
  if (!hitsAny(pos.x, nz, r, h, y)) pos.z = nz;
}

function hitsAny(x, z, r, h, y) {
  for (const c of COLLIDERS) {
    if (y >= c.h) continue; // feet above the box: walk over low crates? no — see below
    if (x + r > c.x0 && x - r < c.x1 && z + r > c.z0 && z - r < c.z1) return true;
  }
  return false;
}

export function pointInSite(x, z, site) {
  const dx = x - site.x;
  const dz = z - site.z;
  return dx * dx + dz * dz < site.r * site.r;
}

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 352;
  const g = c.getContext('2d');
  g.fillStyle = '#8a7a66';
  g.fillRect(0, 0, 512, 352);
  // Warm stone noise (bright enough to read)
  for (let i = 0; i < 2600; i++) {
    const v = 118 + Math.floor(Math.random() * 34);
    g.fillStyle = `rgb(${v},${v - 8},${v - 26})`;
    g.fillRect(Math.random() * 512, Math.random() * 352, 2, 2);
  }
  // Faint expansion joints
  g.strokeStyle = 'rgba(70,58,44,0.5)';
  g.lineWidth = 2;
  for (let x = 64; x < 512; x += 128) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 352); g.stroke();
  }
  for (let y = 44; y < 352; y += 88) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke();
  }
  // Wooden dock planks along the south walkway
  g.fillStyle = '#8a6a42';
  g.fillRect(0, 300, 512, 52);
  g.strokeStyle = 'rgba(60,40,16,0.6)';
  g.lineWidth = 2;
  for (let x = 0; x < 512; x += 32) {
    g.beginPath(); g.moveTo(x, 300); g.lineTo(x, 352); g.stroke();
  }
  g.beginPath(); g.moveTo(0, 326); g.lineTo(512, 326); g.stroke();
  // Lane guide strips (painted, worn)
  g.fillStyle = 'rgba(245,166,35,0.6)';
  g.fillRect(120, 20, 6, 280);
  g.fillRect(386, 20, 6, 280);
  g.fillStyle = 'rgba(45,212,191,0.55)';
  g.fillRect(253, 20, 6, 280);
  // Hazard stripes at site entries
  g.fillStyle = 'rgba(245,166,35,0.75)';
  for (let i = 0; i < 6; i++) {
    g.save();
    g.translate(40 + i * 14, 60);
    g.rotate(Math.PI / 4);
    g.fillRect(0, 0, 6, 26);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Corrugated container texture: vertical ribs, top/bottom rails, stencil
// label and a hazard corner — so containers read as painted steel, not flat
// colour. base/accent are css colours, label is a short stencil code.
function containerTexture(base, accent, label) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 128);
  for (let x = 0; x < 256; x += 16) {
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(x, 0, 4, 128);
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.fillRect(x + 8, 0, 5, 128);
  }
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(0, 0, 256, 10);
  g.fillRect(0, 118, 256, 10);
  g.fillStyle = accent;
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(label, 18, 64);
  g.fillStyle = 'rgba(245,166,35,0.85)';
  for (let i = 0; i < 4; i++) {
    g.save();
    g.translate(214 + i * 10, 96);
    g.rotate(Math.PI / 4);
    g.fillRect(0, 0, 5, 18);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Wooden crate texture: planks, frame border, stencil mark.
function crateTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#bd9257';
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 32) {
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(0, y, 128, 3);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, y + 3, 128, 2);
  }
  g.strokeStyle = 'rgba(60,40,16,0.55)';
  g.lineWidth = 8;
  g.strokeRect(4, 4, 120, 120);
  g.strokeStyle = 'rgba(60,40,16,0.35)';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(8, 8); g.lineTo(120, 120); g.stroke();
  g.beginPath(); g.moveTo(120, 8); g.lineTo(8, 120); g.stroke();
  g.fillStyle = 'rgba(30,22,10,0.8)';
  g.font = 'bold 22px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('NH', 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function letterTexture(letter, color) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,14,22,0.9)';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.strokeRect(6, 6, 116, 116);
  g.fillStyle = color;
  g.font = 'bold 84px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildMap(scene) {
  const wallMeshes = [];
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const kindMat = {
    wall: mat(PALETTE.wall, { rough: 0.9 }),
    contA: new THREE.MeshStandardMaterial({ map: containerTexture('#4a9ab0', '#eaf6f8', 'NH-07'), roughness: 0.7, metalness: 0.35 }),
    contB: new THREE.MeshStandardMaterial({ map: containerTexture('#b07f45', '#fdf3e0', 'NH-12'), roughness: 0.7, metalness: 0.35 }),
    contC: new THREE.MeshStandardMaterial({ map: containerTexture('#71869e', '#eef2f6', 'NH-03'), roughness: 0.7, metalness: 0.35 }),
    crate: new THREE.MeshStandardMaterial({ map: crateTexture(), roughness: 0.95 }),
  };
  for (const c of COLLIDERS) {
    // Facades: outer + divider walls wear Mediterranean plaster — pink,
    // orange, beige or blue, picked deterministically from the position so
    // the map reads as a colourful harbour town, not one flat colour.
    let material = kindMat[c.kind];
    if (c.kind === 'wall') {
      const cx = (c.x0 + c.x1) / 2;
      const cz = (c.z0 + c.z1) / 2;
      const pick = ((Math.abs(Math.round(cx * 7 + cz * 13)) % 4) + 4) % 4;
      const facade = [PALETTE.facadePink, PALETTE.facadeOrange, PALETTE.facadeBeige, PALETTE.facadeBlue][pick];
      material = mat(facade, { rough: 0.9 });
    }
    const m = new THREE.Mesh(boxGeo, material);
    m.scale.set(c.x1 - c.x0, c.h, c.z1 - c.z0);
    m.position.set((c.x0 + c.x1) / 2, c.h / 2, (c.z0 + c.z1) / 2);
    m.castShadow = c.h > 1.5;
    m.receiveShadow = true;
    scene.add(m);
    wallMeshes.push(m);
  }

  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 44),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.92, metalness: 0.08 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Site beacons: glowing ring + letter sign + light
  for (const site of Object.values(SITES)) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.r - 0.35, site.r, 40),
      new THREE.MeshBasicMaterial({ color: site.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.06, site.z);
    scene.add(ring);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 2.4),
      new THREE.MeshBasicMaterial({ map: letterTexture(site.id, '#' + site.color.toString(16).padStart(6, '0')), transparent: true, side: THREE.DoubleSide }),
    );
    sign.position.set(site.x, 3.4, site.z - site.r - 1.2);
    scene.add(sign);
    const lamp = new THREE.PointLight(site.color, 32, 26, 1.6);
    lamp.position.set(site.x, 4.5, site.z);
    scene.add(lamp);
  }

  // Crane beam across mid (visual, above head height)
  const beam = new THREE.Mesh(boxGeo, mat(PALETTE.hairline, { rough: 0.6, metal: 0.5 }));
  beam.scale.set(9, 0.7, 0.9);
  beam.position.set(0, 5.4, 0);
  beam.castShadow = true;
  scene.add(beam);
  const hook = new THREE.Mesh(boxGeo, mat(PALETTE.accent, { rough: 0.5, metal: 0.4 }));
  hook.scale.set(0.5, 1.6, 0.5);
  hook.position.set(2.2, 4.4, 0);
  scene.add(hook);

  // Neon strips along the divider wall (accent lighting, no light cost)
  for (const x of [-27, -10, 10, 27]) {
    const strip = new THREE.Mesh(boxGeo, glowMat(PALETTE.accent, 1.4));
    strip.scale.set(6, 0.12, 0.12);
    strip.position.set(x, 3.0, 2.5);
    scene.add(strip);
  }
  const midLight = new THREE.PointLight(0xcfe0ff, 26, 30, 1.7);
  midLight.position.set(0, 5, 6);
  scene.add(midLight);

  // Dock floodlights: tall poles with warm heads that actually light the
  // lanes (the dark mid-lane and north connectors were unreadable before).
  // Visual only — placed in open space, clear of colliders and waypoints.
  const poleMat = mat(0x3d4756, { rough: 0.6, metal: 0.5 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xffe2b0 });
  for (const [fx, fz] of [[-10, 8], [10, 8], [-10, -14], [10, -14]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 5.6, 8), poleMat);
    pole.position.set(fx, 2.8, fz);
    pole.castShadow = true;
    scene.add(pole);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), headMat);
    head.position.set(fx, 5.7, fz);
    scene.add(head);
    const flood = new THREE.PointLight(0xffd9a0, 16, 19, 1.7);
    flood.position.set(fx, 5.4, fz);
    scene.add(flood);
  }

  // Stars + moon
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(240 * 3);
  for (let i = 0; i < 240; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = 0.25 + Math.random() * 1.1;
    const r = 160;
    starPos[i * 3] = Math.cos(a) * Math.cos(e) * r;
    starPos[i * 3 + 1] = Math.sin(e) * r;
    starPos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfe4ff, size: 0.7, sizeAttenuation: false })));
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(5, 24),
    new THREE.MeshBasicMaterial({ color: 0xe8eef7, fog: false }),
  );
  moon.position.set(-70, 55, -120);
  moon.lookAt(0, 0, 0);
  scene.add(moon);

  // ---- BOATHOUSE decor (visual only — no colliders, no gameplay change) --
  // Pyramid terracotta roofs on the outer walls.
  const roofGeo = new THREE.ConeGeometry(2.4, 1.5, 4);
  const roofMat = mat(PALETTE.roof, { rough: 0.85 });
  for (const rx of [-28, -20, -12, -4, 4, 12, 20, 28]) {
    for (const rz of [-21.5, 21.5]) {
      const roof = new THREE.Mesh(roofGeo, roofMat);
      roof.rotation.y = Math.PI / 4;
      roof.position.set(rx, 4.75, rz);
      roof.castShadow = true;
      scene.add(roof);
    }
  }
  // Warm lit windows + shutters on the inner faces of the outer walls.
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  const shutterMat = mat(0x2e5f6b, { rough: 0.8 });
  const winGeo = new THREE.PlaneGeometry(1.1, 1.5);
  const shutGeo = new THREE.PlaneGeometry(0.4, 1.5);
  for (const wx of [-24, -16, -8, 0, 8, 16, 24]) {
    for (const [wz, ry] of [[-20.9, 0], [20.9, Math.PI]]) {
      const win = new THREE.Mesh(winGeo, winMat);
      win.position.set(wx, 2.3, wz);
      win.rotation.y = ry;
      scene.add(win);
      for (const sx of [-0.85, 0.85]) {
        const shut = new THREE.Mesh(shutGeo, shutterMat);
        shut.position.set(wx + sx, 2.3, wz + (ry === 0 ? 0.01 : -0.01));
        shut.rotation.y = ry;
        scene.add(shut);
      }
    }
  }
  // The harbour itself: water + moored boats beyond the north quay,
  // visible over the wall by their tall masts and sails.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 70),
    new THREE.MeshStandardMaterial({ color: 0x3a6a8a, roughness: 0.25, metalness: 0.5 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -0.15, -58);
  scene.add(water);
  const hullMat = mat(0x7a4a28, { rough: 0.8 });
  const sailMat = new THREE.MeshBasicMaterial({ color: 0xfdf3e0, side: THREE.DoubleSide });
  const sailMat2 = new THREE.MeshBasicMaterial({ color: 0xf5a623, side: THREE.DoubleSide });
  const sailShape = new THREE.Shape();
  sailShape.moveTo(0, 0); sailShape.lineTo(0, 5.4); sailShape.lineTo(2.6, 0); sailShape.closePath();
  const sailGeo = new THREE.ShapeGeometry(sailShape);
  for (const [bx, bz, sc] of [[-18, -30, 1], [4, -37, 1.25], [22, -31, 0.9]]) {
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), hullMat);
    hull.scale.set(2.4 * sc, 0.8 * sc, 1.0 * sc);
    hull.position.set(bx, 0.1, bz);
    scene.add(hull);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 7 * sc, 6), mat(0x5a4028, { rough: 0.9 }));
    mast.position.set(bx, 3.4 * sc, bz);
    scene.add(mast);
    const sail = new THREE.Mesh(sailGeo, sc % 1 === 0 ? sailMat : sailMat2);
    sail.scale.setScalar(sc);
    sail.position.set(bx + 0.1, 1.1, bz);
    scene.add(sail);
  }
  // Barrels: on crates and tight against the south wall.
  const barrelGeo = new THREE.CylinderGeometry(0.45, 0.45, 1.0, 12);
  const barrelMat = mat(PALETTE.wood, { rough: 0.9 });
  for (const [bx, by, bz] of [[-14.5, 1.7, 11], [13, 1.7, 11], [-25, 1.7, -1], [25, 1.7, -1], [-8, 0.5, 21.2], [-7, 0.5, 21.2], [7, 0.5, 21.2]]) {
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.position.set(bx, by, bz);
    barrel.castShadow = true;
    scene.add(barrel);
  }
  // Bunting strings of warm bulbs between the floodlight poles.
  const bulbGeo = new THREE.SphereGeometry(0.09, 8, 6);
  const bulbMats = [new THREE.MeshBasicMaterial({ color: 0xffd9a0 }), new THREE.MeshBasicMaterial({ color: 0xff9a5a }), new THREE.MeshBasicMaterial({ color: 0x7ee2d8 })];
  for (const [ax, az, bx, bz] of [[-10, 8, 10, 8], [-10, -14, 10, -14]]) {
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      const bulb = new THREE.Mesh(bulbGeo, bulbMats[i % 3]);
      bulb.position.set(ax + (bx - ax) * t, 5.6 - Math.sin(t * Math.PI) * 0.9, az + (bz - az) * t);
      scene.add(bulb);
    }
  }

  return { colliders: COLLIDERS, sites: SITES, spawns: SPAWNS, wallMeshes };
}
