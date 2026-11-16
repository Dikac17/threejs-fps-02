// Bot AI: a small state machine over a waypoint graph.
// route -> hold -> engage -> rotate -> plant/defuse, with hearing (gunfire
// pulls bots to investigate) and smoke-blocked vision. Bots aim with a
// reaction delay and distance-scaled error, fire in bursts, strafe in
// fights, and fall back when hurt. One file, one job: bot brains.
import * as THREE from 'three';
import { createBody, eyePos, AGENT_RADIUS } from './player.js';
import { createLoadout, WEAPONS } from './weapons.js';
import { collideMove, findPath, nearestNode, segmentBlocked, pointInSite, SITES } from './map.js';
import { clamp, range, pick } from './rng.js';

const BOT_SPEED = 4.3;
const BOT_TURN = 5.5;
const VISION_RANGE = 55;
const HEAR_RANGE = 30;

export const BOT_NAMES = {
  harbor: ['MARA', 'DOCK', 'PIER', 'TIDE'],
  rust: ['SCRAP', 'RUSTY', 'BOLT', 'GRIME', 'SLAG'],
};

const ROLE_WEAPON = { rifle: 'ar', smg: 'smg', sniper: 'sniper', support: 'smg' };

// ---- rounded character models -------------------------------------------
// All bots share one set of geometries (built once, never per frame) and
// one torso texture per team. No boxes on the body: capsule torso, sphere
// helmet with glowing visor, tapered-cylinder limbs, sphere shoulder pads,
// capsule backpack, cylinder-barrel gun. The shootable parts stay the same
// two meshes (torso = 'body', head = 'head') with the same userData, so hit
// detection, headshots and bot aim need no changes.
const GEO = {
  torso: new THREE.CapsuleGeometry(0.27, 0.5, 6, 14),
  head: new THREE.SphereGeometry(0.2, 18, 14),
  visor: new THREE.SphereGeometry(0.17, 18, 12),
  shoulder: new THREE.SphereGeometry(0.15, 12, 10),
  arm: new THREE.CylinderGeometry(0.06, 0.078, 0.55, 10),
  leg: new THREE.CylinderGeometry(0.085, 0.115, 0.55, 10),
  pack: new THREE.CapsuleGeometry(0.16, 0.25, 4, 10),
  gunBody: new THREE.CapsuleGeometry(0.05, 0.45, 4, 8),
  gunBarrel: new THREE.CylinderGeometry(0.028, 0.028, 0.42, 8),
  antenna: new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6),
  antennaTip: new THREE.SphereGeometry(0.032, 8, 6),
  boot: new THREE.CapsuleGeometry(0.09, 0.16, 4, 8),
  glove: new THREE.SphereGeometry(0.075, 10, 8),
  belt: new THREE.CylinderGeometry(0.29, 0.3, 0.1, 14),
  cap: new THREE.CylinderGeometry(0.19, 0.21, 0.09, 14),
  brim: new THREE.CylinderGeometry(0.2, 0.2, 0.02, 14),
  kneepad: new THREE.SphereGeometry(0.1, 10, 8),
  scarf: new THREE.TorusGeometry(0.19, 0.05, 8, 16),
};
GEO.arm.translate(0, -0.275, 0); // pivot at the shoulder
GEO.leg.translate(0, -0.275, 0); // pivot at the hip

// Torso texture: vest panel, panel lines, team stripe + stencil mark, worn
// edges — painted on the capsule so the body is never one flat colour.
function torsoTexture(suitCss, trimCss, mark) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = suitCss;
  g.fillRect(0, 0, 256, 256);
  // Side shading (roundness cue)
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.35)');
  grad.addColorStop(0.25, 'rgba(0,0,0,0)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  // Team stripe across the chest
  g.fillStyle = trimCss;
  g.fillRect(0, 26, 256, 16);
  // Dark vest panel with panel lines
  g.fillStyle = 'rgba(12,16,24,0.72)';
  g.fillRect(52, 62, 152, 128);
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 2;
  for (let y = 86; y < 190; y += 24) {
    g.beginPath(); g.moveTo(52, y); g.lineTo(204, y); g.stroke();
  }
  g.strokeStyle = trimCss;
  g.lineWidth = 3;
  g.strokeRect(52, 62, 152, 128);
  // Stencil mark on the vest
  g.fillStyle = trimCss;
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(mark, 128, 126);
  // Hazard chevrons at the hem
  g.fillStyle = 'rgba(245,166,35,0.8)';
  for (let i = 0; i < 6; i++) {
    g.save();
    g.translate(40 + i * 30, 216);
    g.rotate(Math.PI / 4);
    g.fillRect(0, 0, 7, 22);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Two teams, four looks. WARDENS (the player's crew, teal / dark blue /
// black, military helmets and vests) vs SMUGGLERS (dark brown / orange,
// tactical jackets, caps and scarves). Two visual variants per team —
// helmet + backpack, or cap + utility belt + kneepads — so no two bots on a
// team look identical. Team colours read from a distance.
const TEAM_STYLE = {
  harbor: {
    trim: 0x2dd4bf, trimCss: '#2dd4bf', suitCss: '#1f6a7a', suit: 0x1f6a7a,
    helmet: 0x16324a, pack: '#14324a', mark: 'WD', belt: '#0f2233',
  },
  rust: {
    trim: 0xf07f2e, trimCss: '#f07f2e', suitCss: '#5a3d28', suit: 0x5a3d28,
    helmet: 0x3d2a1a, pack: '#4a3220', mark: 'SM', belt: '#2e1f12',
  },
};

const teamMats = new Map();
function materialsFor(team) {
  let m = teamMats.get(team);
  if (m) return m;
  const s = TEAM_STYLE[team];
  m = {
    torso: new THREE.MeshStandardMaterial({ map: torsoTexture(s.suitCss, s.trimCss, s.mark), roughness: 0.75 }),
    helmet: new THREE.MeshStandardMaterial({ color: s.helmet, roughness: 0.45, metalness: 0.3 }),
    trim: new THREE.MeshStandardMaterial({ color: s.trim, roughness: 0.5, emissive: s.trim, emissiveIntensity: 0.6 }),
    limb: new THREE.MeshStandardMaterial({ color: s.suit, roughness: 0.8 }),
    pack: new THREE.MeshStandardMaterial({ color: s.pack, roughness: 0.85 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.4, metalness: 0.6 }),
    boot: new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.55, metalness: 0.1 }),
    glove: new THREE.MeshStandardMaterial({ color: s.belt, roughness: 0.9 }),
    belt: new THREE.MeshStandardMaterial({ color: s.belt, roughness: 0.8 }),
  };
  teamMats.set(team, m);
  return m;
}

function buildBotMesh(scene, team, variant) {
  const g = new THREE.Group();
  const M = materialsFor(team);

  // Torso — capsule, the shootable 'body' part.
  const torso = new THREE.Mesh(GEO.torso, M.torso);
  torso.position.y = 0.95;
  torso.castShadow = true;
  g.add(torso);
  // Utility belt at the waist (variant 1 wears it wide; variant 0 a slim one).
  const belt = new THREE.Mesh(GEO.belt, M.belt);
  belt.position.y = 0.62;
  g.add(belt);
  // Shoulder pads — flattened spheres.
  for (const sx of [-1, 1]) {
    const pad = new THREE.Mesh(GEO.shoulder, M.limb);
    pad.scale.set(1.15, 0.75, 1.15);
    pad.position.set(sx * 0.32, 1.34, 0);
    pad.castShadow = true;
    g.add(pad);
  }
  // Head — sphere helmet + glowing visor. Variant 0: full helmet with
  // antenna and backpack. Variant 1: flat cap with brim, scarf, kneepads.
  const head = new THREE.Mesh(GEO.head, M.helmet);
  head.position.y = 1.58;
  head.castShadow = true;
  g.add(head);
  const visor = new THREE.Mesh(GEO.visor, M.trim);
  visor.scale.set(1.05, 0.5, 0.55);
  visor.position.set(0, 1.6, -0.13);
  g.add(visor);
  if (variant === 0) {
    const antenna = new THREE.Mesh(GEO.antenna, M.gun);
    antenna.position.set(0.1, 1.84, 0.02);
    g.add(antenna);
    const tip = new THREE.Mesh(GEO.antennaTip, M.trim);
    tip.position.set(0.1, 2.0, 0.02);
    g.add(tip);
    const pack = new THREE.Mesh(GEO.pack, M.pack);
    pack.scale.set(1, 1, 0.55);
    pack.position.set(0, 1.05, 0.26);
    pack.castShadow = true;
    g.add(pack);
  } else {
    const cap = new THREE.Mesh(GEO.cap, M.helmet);
    cap.position.y = 1.74;
    g.add(cap);
    const brim = new THREE.Mesh(GEO.brim, M.helmet);
    brim.scale.set(1, 1, 0.7);
    brim.position.set(0, 1.71, -0.18);
    g.add(brim);
    const scarf = new THREE.Mesh(GEO.scarf, M.trim);
    scarf.rotation.x = Math.PI / 2;
    scarf.position.y = 1.42;
    g.add(scarf);
  }
  // Arms — tapered cylinders angled down toward the gun, gloved hands.
  const arms = [];
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(GEO.arm, M.limb);
    arm.position.set(sx * 0.3, 1.3, 0);
    arm.rotation.x = -0.85;
    arm.castShadow = true;
    g.add(arm);
    arms.push(arm);
    const glove = new THREE.Mesh(GEO.glove, M.glove);
    glove.position.set(sx * 0.3, 1.02, -0.24);
    g.add(glove);
  }
  // Gun — capsule body + cylinder barrel, held at chest height.
  const gun = new THREE.Group();
  const gunBody = new THREE.Mesh(GEO.gunBody, M.gun);
  gunBody.rotation.x = Math.PI / 2;
  gun.add(gunBody);
  const barrel = new THREE.Mesh(GEO.gunBarrel, M.gun);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.42);
  gun.add(barrel);
  gun.position.set(0.2, 1.1, -0.38);
  g.add(gun);
  // Legs — tapered cylinders, pivot at the hip (swing animated by
  // updateBot), with boots and (variant 1) kneepads.
  const legL = new THREE.Mesh(GEO.leg, M.limb);
  legL.position.set(-0.13, 0.55, 0);
  legL.castShadow = true;
  const legR = new THREE.Mesh(GEO.leg, M.limb);
  legR.position.set(0.13, 0.55, 0);
  legR.castShadow = true;
  g.add(legL);
  g.add(legR);
  for (const sx of [-1, 1]) {
    const boot = new THREE.Mesh(GEO.boot, M.boot);
    boot.rotation.x = Math.PI / 2;
    boot.position.set(sx * 0.13, 0.09, -0.06);
    boot.castShadow = true;
    g.add(boot);
    if (variant === 1) {
      const knee = new THREE.Mesh(GEO.kneepad, M.belt);
      knee.scale.set(1, 0.7, 0.6);
      knee.position.set(sx * 0.13, 0.32, -0.1);
      g.add(knee);
    }
  }
  g.userData.legL = legL;
  g.userData.legR = legR;
  g.userData.armL = arms[0];
  g.userData.armR = arms[1];
  scene.add(g);
  return { group: g, torso, head, legL, legR };
}

export function createBot(scene, opts) {
  const { name, team, role, x, z, yaw, variant = 0 } = opts;
  const body = createBody(x, z, yaw);
  const loadout = createLoadout();
  const weaponKey = ROLE_WEAPON[role] || 'ar';
  loadout.owned = { pistol: true, [weaponKey]: true };
  loadout.current = weaponKey;
  loadout.ammo[weaponKey] = { mag: WEAPONS[weaponKey].mag, reserve: 999 };
  if (role === 'support') loadout.grenades.smoke = 1;
  const mesh = buildBotMesh(scene, team, variant);
  mesh.torso.userData.agentRef = null; // filled by main.js after agent exists
  mesh.head.userData.agentRef = null;
  const agent = {
    id: name, name, team, role, isPlayer: false,
    body, loadout, mesh,
    money: 0, kills: 0, deaths: 0,
    ai: {
      state: 'hold', path: [], pathI: 0, dest: null,
      site: null, holdYaw: yaw, holdNode: null,
      target: null, lastSeen: null, reactT: 0,
      burstLeft: 0, burstT: 0, pauseT: 0,
      strafeDir: 0, strafeT: 0, thinkT: Math.random() * 0.1,
      plantT: 0, defuseT: 0, investigate: false,
      crouchHold: false, aimT: 0,
    },
  };
  mesh.torso.userData.agentRef = agent;
  mesh.head.userData.agentRef = agent;
  mesh.torso.userData.part = 'body';
  mesh.head.userData.part = 'head';
  return agent;
}

// ---- perception ------------------------------------------------------------
const _eyeA = new THREE.Vector3();
const _eyeB = new THREE.Vector3();

function canSee(world, bot, other) {
  const dx = other.body.pos.x - bot.body.pos.x;
  const dz = other.body.pos.z - bot.body.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > VISION_RANGE) return null;
  eyePos(bot.body, _eyeA);
  eyePos(other.body, _eyeB);
  if (segmentBlocked(_eyeA.x, _eyeA.y, _eyeA.z, _eyeB.x, _eyeB.y, _eyeB.z)) return null;
  // Smoke blocks sight: any sample point of the segment inside a cloud.
  for (const s of world.fx.smokeActive()) {
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      const px = _eyeA.x + (_eyeB.x - _eyeA.x) * t;
      const pz = _eyeA.z + (_eyeB.z - _eyeA.z) * t;
      const py = _eyeA.y + (_eyeB.y - _eyeA.y) * t;
      if (py < 3 && (px - s.x) ** 2 + (pz - s.z) ** 2 < s.r * s.r) return null;
    }
  }
  // Field of view (wide when the target is close or just shot at us).
  const facing = Math.atan2(-Math.sin(bot.body.yaw), -Math.cos(bot.body.yaw));
  const toTarget = Math.atan2(dx, dz);
  let diff = Math.abs(((toTarget - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const fov = dist < 8 ? Math.PI : 1.9;
  if (diff > fov) return null;
  return dist;
}

function nearestVisibleEnemy(world, bot) {
  let best = null;
  let bestD = Infinity;
  for (const other of world.agents) {
    if (other.team === bot.team || !other.body.alive) continue;
    const d = canSee(world, bot, other);
    if (d !== null && d < bestD) { bestD = d; best = other; }
  }
  return best ? { agent: best, dist: bestD } : null;
}

function hearShots(world, bot) {
  for (const ev of world.shotEvents) {
    if (world.state.time - ev.t > 1.2) continue;
    if (ev.team === bot.team) continue;
    const d = Math.hypot(ev.x - bot.body.pos.x, ev.z - bot.body.pos.z);
    if (d < HEAR_RANGE) return ev;
  }
  return null;
}

// ---- movement ---------------------------------------------------------------
function moveToward(bot, tx, tz, dt, speed) {
  const dx = tx - bot.body.pos.x;
  const dz = tz - bot.body.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) return true;
  const want = Math.atan2(-dx, -dz);
  let diff = ((want - bot.body.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  bot.body.yaw += clamp(diff, -BOT_TURN * dt, BOT_TURN * dt);
  const step = Math.min(d, speed * dt);
  collideMove(bot.body.pos, AGENT_RADIUS, 1.75, 0,
    -Math.sin(bot.body.yaw) * step, -Math.cos(bot.body.yaw) * step);
  return d < 0.7;
}

function setPath(bot, world, toId) {
  const from = nearestNode(world.waypoints, bot.body.pos.x, bot.body.pos.z);
  bot.ai.path = findPath(world.waypoints, from, toId);
  bot.ai.pathI = 0;
  bot.ai.dest = toId;
}

function pathStep(bot, world, dt, speed) {
  if (!bot.ai.path.length) return true;
  const node = world.waypoints.get(bot.ai.path[bot.ai.pathI]);
  if (!node) return true;
  if (moveToward(bot, node.x, node.z, dt, speed)) {
    bot.ai.pathI++;
    if (bot.ai.pathI >= bot.ai.path.length) { bot.ai.path = []; return true; }
  }
  return false;
}

// ---- the brain ---------------------------------------------------------------
export function updateBot(bot, world, dt) {
  const ai = bot.ai;
  const st = world.state;
  if (!bot.body.alive) return;
  if (st.phase === 'end' || st.phase === 'matchend') return;

  ai.thinkT -= dt;
  if (ai.thinkT <= 0) {
    ai.thinkT = 0.1;
    const seen = nearestVisibleEnemy(world, bot);
    if (seen) {
      // Reaction delay only on a fresh acquisition — switching between two
      // visible targets must not restart the delay forever.
      const fresh = !ai.target;
      if (ai.target !== seen.agent) ai.target = seen.agent;
      if (fresh) {
        ai.reactT = range(world.rng, 0.35, 0.8);
        ai.aimT = 0;
        ai.burstLeft = 0;
      }
      ai.lastSeen = { x: seen.agent.body.pos.x, z: seen.agent.body.pos.z, t: st.time };
      ai.state = 'engage';
    } else if (ai.target) {
      const lostFor = st.time - (ai.lastSeen ? ai.lastSeen.t : 0);
      if (lostFor > 1.4) {
        ai.target = null;
        ai.state = ai.investigate ? 'route' : 'hold';
      }
    }
    // Hearing pulls HOLDING bots toward gunfire — only when idle, and at
    // most once per 3 s, so a firefight cannot re-route a bot forever.
    if (!ai.target && ai.state === 'hold') {
      const heard = hearShots(world, bot);
      if (heard && st.time - (ai.lastHeardT || -99) > 3) {
        ai.lastHeardT = st.time;
        const node = nearestNode(world.waypoints, heard.x, heard.z);
        if (node !== ai.dest) { setPath(bot, world, node); ai.investigate = true; ai.state = 'route'; }
      }
    }
    // Low HP: fall back to the nearest hold node.
    if (bot.body.hp < 35 && ai.state === 'engage' && world.rng() < 0.3) {
      const hold = bot.team === 'harbor' ? (ai.site === 'A' ? 'aHold1' : 'bHold1') : (ai.site === 'A' ? 'aHold1' : 'bHold1');
      setPath(bot, world, hold);
      ai.state = 'route';
      ai.target = null;
    }
  }

  const attacking = st.attackTeam === bot.team;

  switch (ai.state) {
    case 'route': {
      if (pathStep(bot, world, dt, BOT_SPEED)) {
        ai.investigate = false;
        if (attacking && ai.dest === (ai.site === 'A' ? 'wSite' : 'eSite')) {
          ai.state = 'hold';
          ai.holdYaw = bot.body.yaw;
        } else {
          ai.state = 'hold';
          ai.holdYaw = bot.body.yaw;
        }
      }
      break;
    }
    case 'hold': {
      // Slow scan around the hold angle.
      const sweep = Math.sin(st.time * 0.5 + bot.body.pos.x) * 0.7;
      bot.body.yaw += (ai.holdYaw + sweep - bot.body.yaw) * Math.min(1, dt * 2);
      // Attackers holding their site: the carrier plants when the site looks clear.
      if (attacking && st.bomb.state === 'carried' && st.bomb.carrier === bot
        && pointInSite(bot.body.pos.x, bot.body.pos.z, SITES[ai.site])) {
        ai.state = 'plant';
        ai.plantT = 3.0;
        world.audio.plantStart();
      }
      // Defenders holding a planted site defuse when the bomb is there.
      if (!attacking && st.bomb.state === 'planted' && st.bomb.site === ai.site
        && pointInSite(bot.body.pos.x, bot.body.pos.z, SITES[ai.site])) {
        ai.state = 'defuse';
        ai.defuseT = 5.0;
        world.audio.defuseStart();
      }
      break;
    }
    case 'engage': {
      const t = ai.target;
      if (!t || !t.body.alive) { ai.target = null; ai.state = 'hold'; break; }
      const dx = t.body.pos.x - bot.body.pos.x;
      const dz = t.body.pos.z - bot.body.pos.z;
      const dist = Math.hypot(dx, dz);
      const want = Math.atan2(-dx, -dz);
      let diff = ((want - bot.body.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      bot.body.yaw += clamp(diff, -BOT_TURN * 1.6 * dt, BOT_TURN * 1.6 * dt);
      // Strafe in fights; close the gap if far, hold ground if near.
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) {
        ai.strafeT = range(world.rng, 0.7, 1.4);
        ai.strafeDir = pick(world.rng, [-1, 0, 1]);
      }
      if (dist > 14) {
        moveToward(bot, t.body.pos.x, t.body.pos.z, dt, BOT_SPEED * 0.8);
      } else if (ai.strafeDir !== 0) {
        const px = -Math.cos(bot.body.yaw) * ai.strafeDir;
        const pz = Math.sin(bot.body.yaw) * ai.strafeDir;
        collideMove(bot.body.pos, AGENT_RADIUS, 1.75, 0, px * BOT_SPEED * 0.5 * dt, pz * BOT_SPEED * 0.5 * dt);
      }
      // Burst fire after the reaction delay.
      ai.aimT += dt;
      if (ai.reactT > 0) { ai.reactT -= dt; break; }
      if (ai.burstLeft > 0) {
        ai.burstT -= dt;
        if (ai.burstT <= 0) {
          ai.burstT = WEAPONS[bot.loadout.current].fireInterval;
          ai.burstLeft--;
          botShoot(world, bot, t, dist);
        }
      } else {
        ai.pauseT -= dt;
        if (ai.pauseT <= 0) {
          ai.burstLeft = 2 + Math.floor(world.rng() * 3);
          ai.pauseT = range(world.rng, 0.8, 1.6);
        }
      }
      break;
    }
    case 'plant': {
      ai.plantT -= dt;
      if (ai.plantT <= 0) {
        world.onPlant(bot);
        ai.state = 'hold';
        ai.holdYaw = bot.body.yaw;
      }
      break;
    }
    case 'defuse': {
      ai.defuseT -= dt;
      if (ai.defuseT <= 0) {
        world.onDefuse(bot);
        ai.state = 'hold';
      }
      break;
    }
  }

  // Animate legs + arms + idle sway, keep the mesh glued to the body.
  const speed = Math.hypot(bot.body.vel.x, bot.body.vel.z);
  const swing = Math.sin(st.time * 11) * (speed > 0.5 ? 0.55 : 0);
  bot.mesh.legL.rotation.x = swing;
  bot.mesh.legR.rotation.x = -swing;
  const u = bot.mesh.group.userData;
  if (u.armL && u.armR) {
    // Arms swing opposite the legs while walking; idle sway when still.
    const idle = Math.sin(st.time * 1.8 + bot.body.pos.x) * 0.05;
    u.armL.rotation.x = -0.85 - swing * 0.6 + idle;
    u.armR.rotation.x = -0.85 + swing * 0.6 + idle;
  }
  bot.mesh.group.position.copy(bot.body.pos);
  bot.mesh.group.rotation.y = bot.body.yaw;
  bot.mesh.group.scale.y = bot.body.crouch ? 0.72 : 1;

  // Stuck recovery: if a bot meant to move but barely did for 0.7 s (a box
  // or a wall edge is in the way), sidestep perpendicular for 0.8 s.
  const moved = Math.hypot(bot.body.pos.x - (ai.lastX ?? bot.body.pos.x), bot.body.pos.z - (ai.lastZ ?? bot.body.pos.z));
  if (ai.state === 'route' || (ai.state === 'engage' && ai.target)) {
    if (moved < 0.02) {
      ai.stuckT = (ai.stuckT ?? 0) + dt;
      if (ai.stuckT > 0.7) {
        ai.detourT = 0.8;
        ai.detourDir = world.rng() < 0.5 ? -1 : 1;
        ai.stuckT = 0;
      }
    } else ai.stuckT = 0;
  }
  ai.lastX = bot.body.pos.x;
  ai.lastZ = bot.body.pos.z;
  if (ai.detourT > 0) {
    ai.detourT -= dt;
    const px = -Math.cos(bot.body.yaw) * ai.detourDir;
    const pz = Math.sin(bot.body.yaw) * ai.detourDir;
    collideMove(bot.body.pos, AGENT_RADIUS, 1.75, 0, px * BOT_SPEED * dt, pz * BOT_SPEED * dt);
  }
}

function botShoot(world, bot, target, dist) {
  const def = WEAPONS[bot.loadout.current];
  const res = world.takeRound(bot);
  if (res !== 'ok') {
    if (res === 'empty') world.reloadBot(bot);
    return;
  }
  eyePos(bot.body, _eyeA);
  eyePos(target.body, _eyeB);
  // Aim at the chest (torso centre, ~0.97 m) with an error that grows with
  // distance and target speed.
  const tSpeed = Math.hypot(target.body.vel.x, target.body.vel.z);
  const err = 0.032 + dist * 0.001 + tSpeed * 0.003 + (bot.body.crouch ? -0.006 : 0);
  const dir = new THREE.Vector3(
    _eyeB.x - _eyeA.x + (world.rng() - 0.5) * 2 * err * dist,
    (_eyeB.y - 0.65) - _eyeA.y + (world.rng() - 0.5) * 2 * err * dist,
    _eyeB.z - _eyeA.z + (world.rng() - 0.5) * 2 * err * dist,
  ).normalize();
  world.fireHitscan(bot, _eyeA, dir, def);
  world.audio.distantShot();
}

// Assign opening orders for a round: attackers pick a site, defenders hold.
export function assignRoundOrders(world) {
  const st = world.state;
  const attacking = st.attackTeam;
  const sites = ['A', 'A', 'B', 'B', 'B'];
  let atkIdx = 0;
  let defIdx = 0;
  const holdNodes = { A: ['aHold1', 'aHold2'], B: ['bHold1', 'bHold2'] };
  for (const bot of world.agents) {
    if (bot.isPlayer || !bot.body.alive) continue;
    const ai = bot.ai;
    ai.target = null;
    ai.state = 'route';
    ai.investigate = false;
    if (bot.team === attacking) {
      ai.site = sites[atkIdx % sites.length];
      atkIdx++;
      setPathToSite(bot, world, ai.site);
    } else {
      ai.site = defIdx % 2 === 0 ? 'A' : 'B';
      const nodes = holdNodes[ai.site];
      const node = nodes[Math.floor(defIdx / 2) % nodes.length] || nodes[0];
      defIdx++;
      // One defender holds mid instead of a site.
      if (defIdx === 5) { ai.site = null; setPath(bot, world, 'midHold'); }
      else setPath(bot, world, node);
      ai.holdNode = node;
    }
  }
}

function setPathToSite(bot, world, site) {
  setPath(bot, world, site === 'A' ? 'wSite' : 'eSite');
}

// When the bomb is planted, defenders rotate to that site; attackers hold it.
export function onBombPlantedOrders(world, site) {
  for (const bot of world.agents) {
    if (bot.isPlayer || !bot.body.alive) continue;
    const ai = bot.ai;
    if (bot.team !== world.state.attackTeam) {
      ai.site = site;
      ai.target = null;
      setPath(bot, world, site === 'A' ? 'wSite' : 'eSite');
      ai.state = 'route';
      ai.investigate = false;
    } else {
      ai.target = null;
      ai.state = 'hold';
      ai.holdYaw = bot.body.yaw;
    }
  }
}
