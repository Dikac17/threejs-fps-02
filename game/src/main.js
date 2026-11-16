// NEON HARBOR — main. Boots the renderer, owns the one game state, runs a
// fixed 60 Hz simulation apart from rendering, and wires input, shooting,
// grenades, the bomb, rounds and the HUD together. Screenshots are taken in
// deterministic ?shot= modes (see setupShot below).
import * as THREE from 'three';
import { mulberry32, clamp, range } from './rng.js';
import { PALETTE } from './palette.js';
import { buildMap, buildWaypoints, SITES, SPAWNS, pointInSite, segmentBlocked } from './map.js';
import { createAudio } from './audio.js';
import { createFx } from './fx.js';
import { createHud } from './hud.js';
import { createTouch } from './touch.js';
import {
  WEAPONS, createLoadout, takeRound, startReload, tickWeapon, switchWeapon,
  currentWeapon, computeSpread, refillAmmo,
} from './weapons.js';
import { START_MONEY, tryBuy, buyCatalog, KILL_REWARD, PLANT_REWARD, DEFUSE_REWARD } from './economy.js';
import {
  createBody, eyePos, movePlayer, applyRecoil, syncCamera, applyDamage,
} from './player.js';
import { createBot, updateBot, assignRoundOrders, onBombPlantedOrders, BOT_NAMES } from './bots.js';
import {
  createMatch, startRound, tickMatch, endRound, plantBomb, dropBomb,
  PLANT_TIME, DEFUSE_TIME, BOMB_TIME,
} from './rounds.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const rng = mulberry32(seed);

// ---- renderer / scene -------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 30, 95);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 200);
scene.add(camera);

scene.add(new THREE.AmbientLight(0xc4d6ec, 1.15));
const moonLight = new THREE.DirectionalLight(0xeef3ff, 1.6);
moonLight.position.set(-30, 40, 20);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(1024, 1024);
moonLight.shadow.camera.left = -40;
moonLight.shadow.camera.right = 40;
moonLight.shadow.camera.top = 40;
moonLight.shadow.camera.bottom = -40;
moonLight.shadow.camera.far = 120;
scene.add(moonLight);

// ---- world ------------------------------------------------------------------
const map = buildMap(scene);
const waypoints = buildWaypoints();
const audio = createAudio();
const fx = createFx(scene);
const match = createMatch();
const raycaster = new THREE.Raycaster();
const wallMeshes = map.wallMeshes;

const player = {
  id: 'YOU', name: 'YOU', team: 'harbor', isPlayer: true,
  body: createBody(0, 18, 0),
  loadout: createLoadout(),
  money: START_MONEY,
  kills: 0, deaths: 0,
};
const agents = [player];
const bots = [];
{
  const roles = ['rifle', 'smg', 'rifle', 'sniper'];
  for (let i = 0; i < 4; i++) {
    bots.push(createBot(scene, {
      name: BOT_NAMES.harbor[i], team: 'harbor', role: roles[i], variant: i % 2,
      x: SPAWNS.attack[i].x, z: SPAWNS.attack[i].z, yaw: 0,
    }));
  }
  const enemyRoles = ['rifle', 'smg', 'rifle', 'sniper', 'support'];
  for (let i = 0; i < 5; i++) {
    bots.push(createBot(scene, {
      name: BOT_NAMES.rust[i], team: 'rust', role: enemyRoles[i], variant: i % 2,
      x: SPAWNS.defend[i].x, z: SPAWNS.defend[i].z, yaw: Math.PI,
    }));
  }
  agents.push(...bots);
}
const shootables = [...wallMeshes];
for (const b of bots) shootables.push(b.mesh.torso, b.mesh.head);

const state = {
  time: 0, tick: 0,
  firing: false, firingSemi: false,
  ads: false, trauma: 0,
  plantT: 0, defuseT: 0,
  spectateIdx: 0,
  frozen: false, started: false,
  grenades: [], // {pos, vel, kind, t}
  shotEvents: [], // {x, z, team, t} — bot hearing
};

// Bomb mesh: rounded charge body (capsule) + blinking light, shown when
// dropped / planted, hidden while carried.
const bombMesh = new THREE.Group();
{
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.14, 0.28, 4, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.4, metalness: 0.6 }),
  );
  body.rotation.z = Math.PI / 2;
  body.castShadow = true;
  bombMesh.add(body);
  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff2222 }),
  );
  light.position.set(0.18, 0.18, 0);
  light.name = 'bomb-light';
  bombMesh.add(light);
  bombMesh.visible = false;
  scene.add(bombMesh);
}

// First-person viewmodels: one per weapon, each with gloved hands, sleeves
// and a detailed gun — built once, toggled visible on weapon switch. All
// rounded geometry (capsules, cylinders, spheres); no boxes.
const vmMats = {
  gun: new THREE.MeshStandardMaterial({ color: 0x2e3542, roughness: 0.45, metalness: 0.55 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xf5a623, roughness: 0.5, metalness: 0.3, emissive: 0xf5a623, emissiveIntensity: 0.5 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.8 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9aa4b0, roughness: 0.3, metalness: 0.85 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.9 }),
  sleeve: new THREE.MeshStandardMaterial({ color: 0x1f6a7a, roughness: 0.85 }),
};
function vmPart(geo, mat, x, y, z, rx = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (rx) m.rotation.x = rx;
  if (rz) m.rotation.z = rz;
  return m;
}
function buildViewmodel(key) {
  const g = new THREE.Group();
  const grip = (x, y, z) => g.add(vmPart(new THREE.CapsuleGeometry(0.035, 0.09, 4, 8), vmMats.gun, x, y, z, 0.35));
  const hand = (x, y, z) => g.add(vmPart(new THREE.SphereGeometry(0.045, 10, 8), vmMats.glove, x, y, z));
  const sleeve = (x, y, z, rz) => g.add(vmPart(new THREE.CylinderGeometry(0.055, 0.065, 0.3, 10), vmMats.sleeve, x, y, z, 0.5, rz));
  if (key === 'pistol') {
    g.add(vmPart(new THREE.CapsuleGeometry(0.045, 0.14, 4, 10), vmMats.gun, 0, 0.02, -0.18, Math.PI / 2));
    g.add(vmPart(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 8), vmMats.steel, 0, 0.04, -0.32, Math.PI / 2));
    grip(0, -0.1, -0.02);
    hand(0, -0.1, -0.02);
    sleeve(0.03, -0.22, 0.08, 0.4);
  } else if (key === 'ar') {
    g.add(vmPart(new THREE.CapsuleGeometry(0.055, 0.32, 4, 10), vmMats.gun, 0, 0.02, -0.2, Math.PI / 2));
    g.add(vmPart(new THREE.CylinderGeometry(0.026, 0.026, 0.34, 10), vmMats.steel, 0, 0.05, -0.5, Math.PI / 2));
    g.add(vmPart(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 10), vmMats.wood, 0, 0.0, -0.42, Math.PI / 2));
    g.add(vmPart(new THREE.CapsuleGeometry(0.04, 0.1, 4, 8), vmMats.gun, 0, -0.09, -0.12, 0.3));
    g.add(vmPart(new THREE.SphereGeometry(0.026, 10, 8), vmMats.accent, 0, 0.1, -0.22));
    grip(0, -0.11, -0.05);
    hand(0, -0.11, -0.05);
    hand(0, -0.03, -0.42);
    sleeve(0.04, -0.24, 0.06, 0.4);
    sleeve(-0.03, -0.2, -0.3, -0.2);
  } else if (key === 'shotgun') {
    g.add(vmPart(new THREE.CapsuleGeometry(0.065, 0.3, 4, 10), vmMats.wood, 0, 0.02, -0.18, Math.PI / 2));
    g.add(vmPart(new THREE.CylinderGeometry(0.035, 0.035, 0.4, 10), vmMats.steel, 0, 0.05, -0.5, Math.PI / 2));
    g.add(vmPart(new THREE.CapsuleGeometry(0.05, 0.12, 4, 8), vmMats.wood, 0, -0.02, -0.36, Math.PI / 2));
    g.add(vmPart(new THREE.CapsuleGeometry(0.045, 0.1, 4, 8), vmMats.wood, 0, -0.05, 0.08, 0.5));
    grip(0, -0.11, -0.02);
    hand(0, -0.11, -0.02);
    hand(0, -0.04, -0.36);
    sleeve(0.04, -0.24, 0.06, 0.4);
    sleeve(-0.03, -0.2, -0.26, -0.2);
  } else { // blade
    g.add(vmPart(new THREE.ConeGeometry(0.05, 0.34, 4), vmMats.steel, 0, 0.06, -0.3, -Math.PI / 2.4));
    g.add(vmPart(new THREE.CapsuleGeometry(0.035, 0.1, 4, 8), vmMats.gun, 0, -0.08, -0.08, 0.3));
    hand(0, -0.09, -0.08);
    sleeve(0.04, -0.24, 0.04, 0.4);
  }
  g.position.set(0.26, -0.24, -0.5);
  g.visible = false;
  camera.add(g);
  return g;
}
const viewmodels = {
  pistol: buildViewmodel('pistol'),
  ar: buildViewmodel('ar'),
  shotgun: buildViewmodel('shotgun'),
  blade: buildViewmodel('blade'),
};
let viewKick = 0;
let swingT = 0;
let swayX = 0;
function showViewmodel() {
  const cur = player.loadout.current;
  for (const [k, g] of Object.entries(viewmodels)) g.visible = (k === cur);
}

// ---- HUD --------------------------------------------------------------------
const hud = createHud({
  onBuy: (id) => {
    const res = tryBuy(player, id);
    if (res === 'ok') { audio.buy(); hud.refreshBuyMoney(player.money); hud.setMoney(player.money); updateWeaponLabel(); }
    else if (res === 'poor') { audio.denied(); hud.toast('Not enough money'); }
    else if (res === 'owned') { hud.toast('Already owned'); }
    else if (res === 'full') { hud.toast('Already at max'); }
  },
  onMute: () => {
    audio.setMuted(!audio.isMuted());
    hud.setMuted(audio.isMuted());
  },
});
hud.onPlay(() => {
  audio.unlock();
  audio.ambientStart();
  if (shot) return;
  if (match.phase === 'matchend') { window.location.reload(); return; }
  if (!player.body.alive && match.phase === 'live') { requestLock(); return; }
  requestLock();
});
const rematchBtn = document.getElementById('rematch');
if (rematchBtn) rematchBtn.addEventListener('click', () => window.location.reload());

function requestLock() {
  try { renderer.domElement.requestPointerLock(); } catch { /* headless */ }
}

function buyByIndex(i) {
  const item = buyCatalog()[i];
  if (!item) return;
  const res = tryBuy(player, item.id);
  if (res === 'ok') { audio.buy(); hud.refreshBuyMoney(player.money); hud.setMoney(player.money); updateWeaponLabel(); }
  else if (res === 'poor') { audio.denied(); hud.toast('Not enough money'); }
  else if (res === 'owned') { hud.toast('Already owned'); }
  else if (res === 'full') { hud.toast('Already at max'); }
}

function updateWeaponLabel() {
  const w = currentWeapon(player.loadout);
  const g = player.loadout.grenades;
  const owned = Object.keys(player.loadout.owned).filter((k) => player.loadout.owned[k]);
  const slots = ['pistol', 'ar', 'shotgun', 'blade'].map((k, i) =>
    owned.includes(k) ? `[${i + 1}]` : `·`).join(' ');
  const el = document.getElementById('weapon-name');
  if (el) el.innerHTML = `<b>${w.name}</b> ${slots} · [G] frag ${g.frag} / smoke ${g.smoke} / flash ${g.flash}`;
}

// ---- input ------------------------------------------------------------------
const keys = {};
let mouseDX = 0;
let mouseDY = 0;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'Tab') {
    e.preventDefault();
    if (e.repeat) return;
    hud.showScoreboard(agents.map((a) => ({
      name: a.name, team: a.team, kills: a.kills || 0, deaths: a.deaths || 0,
      money: a.isPlayer ? a.money : null,
    })));
    return;
  }
  keys[e.code] = true;
  if (e.repeat) return;
  if (e.code === 'KeyR') { if (startReload(player.loadout)) audio.reload(); }
  if (e.code === 'Digit1') { if (hud.isBuyOpen()) buyByIndex(0); else if (switchWeapon(player.loadout, 'pistol')) showViewmodel(); }
  if (e.code === 'Digit2') { if (hud.isBuyOpen()) buyByIndex(1); else if (switchWeapon(player.loadout, 'ar')) showViewmodel(); }
  if (e.code === 'Digit3') { if (hud.isBuyOpen()) buyByIndex(2); else if (switchWeapon(player.loadout, 'shotgun')) showViewmodel(); }
  if (e.code === 'Digit4') { if (hud.isBuyOpen()) buyByIndex(3); else if (switchWeapon(player.loadout, 'blade')) showViewmodel(); }
  if (e.code === 'Digit5') { if (hud.isBuyOpen()) buyByIndex(4); }
  if (e.code === 'Digit6') { if (hud.isBuyOpen()) buyByIndex(5); }
  if (e.code === 'Digit7') { if (hud.isBuyOpen()) buyByIndex(6); }
  if (e.code === 'KeyB') {
    if (match.phase === 'buy') {
      if (hud.isBuyOpen()) { hud.hideBuy(); requestLock(); }
      else { hud.showBuy(player.money); document.exitPointerLock?.(); }
    }
  }
  if (e.code === 'KeyM') { audio.setMuted(!audio.isMuted()); hud.setMuted(audio.isMuted()); }
  if (e.code === 'KeyG') throwGrenade();
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Tab') hud.hideScoreboard();
});
window.addEventListener('blur', () => { for (const k of Object.keys(keys)) keys[k] = false; state.firing = false; hud.hideScoreboard(); });
renderer.domElement.addEventListener('mousedown', (e) => {
  // Touch taps also fire compatibility mousedowns — the touch module owns them.
  if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
  audio.unlock();
  if (shot) return;
  if (document.pointerLockElement !== renderer.domElement) { requestLock(); return; }
  if (e.button === 0) {
    state.firing = true;
    if (!currentWeapon(player.loadout).auto) state.firingSemi = true;
  }
  if (e.button === 2) state.ads = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { state.firing = false; state.firingSemi = false; }
  if (e.button === 2) state.ads = false;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  mouseDX += e.movementX;
  mouseDY += e.movementY;
});
document.addEventListener('pointerlockchange', () => {
  if (shot) return;
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked) {
    state.started = true;
    hud.hideOverlay();
  } else if (match.phase !== 'matchend' && !hud.isBuyOpen()) {
    hud.showOverlay(player.body.alive ? (state.started ? 'paused' : 'start') : 'dead');
  }
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- touch controls (Android) ----------------------------------------------
const touch = createTouch({
  canvas: renderer.domElement,
  onLook(dx, dy) { mouseDX += dx; mouseDY += dy; },
  onFire(down) {
    state.firing = down;
    if (down && !currentWeapon(player.loadout).auto) state.firingSemi = true;
    if (!down) state.firingSemi = false;
  },
  onReload() { if (startReload(player.loadout)) audio.reload(); },
  onJump() { keys['Space'] = true; setTimeout(() => { keys['Space'] = false; }, 200); },
  onCrouch() { keys['ControlLeft'] = !keys['ControlLeft']; },
  onCycleWeapon() {
    const order = ['pistol', 'ar', 'shotgun', 'blade'];
    const i = order.indexOf(player.loadout.current);
    for (let k = 1; k <= order.length; k++) {
      const next = order[(i + k) % order.length];
      if (player.loadout.owned[next]) { switchWeapon(player.loadout, next); showViewmodel(); updateWeaponLabel(); break; }
    }
  },
  onGrenade() { throwGrenade(); },
});

// ---- shooting ---------------------------------------------------------------
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _eyeA = new THREE.Vector3();
const _eyeB = new THREE.Vector3();

function muzzlePos(agent, out) {
  eyePos(agent.body, out);
  out.x += -Math.sin(agent.body.yaw) * 0.4;
  out.y -= 0.12;
  out.z += -Math.cos(agent.body.yaw) * 0.4;
  return out;
}

// One hitscan shot: raycast walls + agents, nearest hit wins. Dead bodies
// never block a shot — the ray passes through them to the next hit.
function resolveShot(shooter, origin, dir, def) {
  raycaster.set(origin, dir);
  raycaster.far = def.range;
  const hits = raycaster.intersectObjects(shootables, false);
  for (const hit of hits) {
    _hitPoint.copy(hit.point);
    const ref = hit.object.userData.agentRef;
    if (!ref) { // a wall: blocks the shot
      fx.sparksAt(_hitPoint, 6, 2.5);
      if (shooter.isPlayer) audio.impact();
      return { kind: 'wall', point: _hitPoint.clone() };
    }
    if (ref === shooter || !ref.body.alive) continue; // corpse: shoot through
    const isHead = hit.object.userData.part === 'head';
    const dmg = def.damage * (isHead ? def.headMult : 1);
    const dealt = applyDamage(ref, dmg);
    if (shooter.isPlayer) {
      hud.hitmarker(!ref.body.alive);
      audio.hit();
      if (!ref.body.alive) audio.kill();
    }
    if (!ref.body.alive) onAgentKilled(ref, shooter);
    else if (ref.isPlayer) { hud.damageFlash(); audio.hurt(); state.trauma = Math.min(1, state.trauma + 0.3); }
    return { kind: 'agent', agent: ref, point: _hitPoint.clone(), head: isHead, dmg: dealt };
  }
  return null;
}

function fireFrom(agent, dirOverride) {
  const def = currentWeapon(agent.loadout);
  const res = takeRound(agent.loadout);
  if (res !== 'ok') {
    if (res === 'empty' && agent.isPlayer) { audio.dry(); startReload(agent.loadout); }
    return false;
  }
  // Melee: a short-range swing — raycast first, then a generous cone
  // check so a close target is hit even if the crosshair is slightly off.
  if (def.melee) {
    camera.getWorldDirection(_dir);
    const hit = resolveShot(agent, eyePos(agent.body, _origin), _dir, def);
    if (!hit) {
      for (const other of agents) {
        if (other === agent || other.team === agent.team || !other.body.alive) continue;
        const dx = other.body.pos.x - agent.body.pos.x;
        const dz = other.body.pos.z - agent.body.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > def.range) continue;
        const fwd = new THREE.Vector3(-Math.sin(agent.body.yaw), 0, -Math.cos(agent.body.yaw));
        if ((dx * fwd.x + dz * fwd.z) / Math.max(0.01, d) < 0.82) continue;
        const dealt = applyDamage(other, def.damage);
        if (agent.isPlayer) { hud.hitmarker(!other.body.alive); audio.hit(); if (!other.body.alive) audio.kill(); }
        if (!other.body.alive) onAgentKilled(other, agent);
        break;
      }
    }
    if (agent.isPlayer) { audio.melee(); swingT = 0.28; }
    applyRecoil(agent.body, def, rng);
    viewKick = Math.min(0.09, viewKick + def.recoilPitch * 1.4);
    return true;
  }
  const moveSpeed = Math.hypot(agent.body.vel.x, agent.body.vel.z);
  const spread = computeSpread(def, moveSpeed, agent.body.airborne, agent.body.crouch, agent.isPlayer && state.ads, agent.loadout.bloom);
  eyePos(agent.body, _origin);
  // Shotgun: one ray per pellet, each with its own spread.
  const pellets = def.pellets || 1;
  let firstHit = null;
  let firstEnd = null;
  for (let p = 0; p < pellets; p++) {
    if (dirOverride) _dir.copy(dirOverride);
    else {
      camera.getWorldDirection(_dir);
      _dir.x += (rng() - 0.5) * 2 * spread;
      _dir.y += (rng() - 0.5) * 2 * spread;
      _dir.z += (rng() - 0.5) * 2 * spread;
      _dir.normalize();
    }
    const hit = resolveShot(agent, _origin, _dir, def);
    if (p === 0) {
      firstHit = hit;
      firstEnd = hit ? hit.point : _origin.clone().addScaledVector(_dir, def.range);
    }
  }
  const end = firstEnd;
  muzzlePos(agent, _origin);
  fx.tracer(_origin, end);
  fx.muzzle(_origin, _dir);
  // Eject one brass shell to the shooter's right.
  if (agent.isPlayer) {
    const right = new THREE.Vector3(Math.cos(agent.body.yaw), 0, -Math.sin(agent.body.yaw));
    fx.eject(_origin.clone().add(right.clone().multiplyScalar(0.15)), right);
  }
  applyRecoil(agent.body, def, rng);
  viewKick = Math.min(0.09, viewKick + def.recoilPitch * 1.4);
  state.trauma = Math.min(1, state.trauma + 0.05);
  if (agent.isPlayer) audio.shot(def.kind);
  else audio.distantShot();
  state.shotEvents.push({ x: agent.body.pos.x, z: agent.body.pos.z, team: agent.team, t: state.time });
  return true;
}

function onAgentKilled(victim, killer) {
  const msg = `${killer.name} ▸ ${victim.name}`;
  hud.killfeedAdd(msg, killer.isPlayer);
  killer.kills = (killer.kills || 0) + 1;
  victim.deaths = (victim.deaths || 0) + 1;
  if (killer.isPlayer) { player.money += KILL_REWARD; hud.setMoney(player.money); }
  // Drop the bomb where the carrier died.
  if (match.bomb.state === 'carried' && match.bomb.carrier === victim) {
    dropBomb(match, victim.body.pos.x, victim.body.pos.z);
    bombMesh.visible = true;
    bombMesh.position.set(victim.body.pos.x, 0.2, victim.body.pos.z);
    hud.setBombStatus('Charge dropped — pick it up', true);
  }
  // Fall the body over.
  if (!victim.isPlayer) {
    victim.mesh.group.rotation.x = -Math.PI / 2;
    victim.mesh.group.position.y = 0.35;
  }
}

// ---- grenades ---------------------------------------------------------------
function throwGrenade() {
  if (match.phase !== 'live' || !player.body.alive) return;
  const g = player.loadout.grenades;
  // Frag first, then smoke, then flash.
  const kind = g.frag > 0 ? 'frag' : g.smoke > 0 ? 'smoke' : g.flash > 0 ? 'flash' : null;
  if (!kind) { hud.toast('No utility left — buy more [B]'); return; }
  g[kind]--;
  updateWeaponLabel();
  camera.getWorldDirection(_dir);
  const pos = eyePos(player.body, new THREE.Vector3()).addScaledVector(_dir, 0.5);
  const vel = _dir.clone().multiplyScalar(15);
  vel.y += 3.5;
  state.grenades.push({ pos, vel, kind, t: kind === 'frag' ? 2.0 : 1.5 });
  audio.click();
}

function detonateGrenade(gr) {
  if (gr.kind === 'frag') {
    fx.explosion(gr.pos);
    audio.explosion();
    state.trauma = Math.min(1, state.trauma + 0.4);
    // AoE with falloff (95 up close, ~10 at the edge), walls block it.
    for (const a of agents) {
      if (!a.body.alive) continue;
      const d = Math.hypot(a.body.pos.x - gr.pos.x, a.body.pos.z - gr.pos.z);
      if (d > 7) continue;
      eyePos(a.body, _origin);
      raycaster.set(_origin, new THREE.Vector3(gr.pos.x - _origin.x, gr.pos.y - _origin.y, gr.pos.z - _origin.z).normalize());
      raycaster.far = d;
      if (raycaster.intersectObjects(wallMeshes, false).length > 0) continue;
      const dmg = Math.max(10, 95 * (1 - d / 7));
      const dealt = applyDamage(a, dmg);
      if (a.isPlayer) { hud.damageFlash(); audio.hurt(); }
      if (!a.body.alive) {
        onAgentKilled(a, player);
        if (a !== player) hud.killfeedAdd(`YOU ▸ ${a.name} (frag)`, true);
      }
    }
    return;
  }
  if (gr.kind === 'smoke') {
    fx.smokeAt(gr.pos.x, Math.max(0.8, gr.pos.y), gr.pos.z, 14);
    audio.smoke();
  } else {
    audio.flash();
    fx.explosion(gr.pos); // bright flash, no damage
    for (const a of agents) {
      if (!a.body.alive) continue;
      const d = Math.hypot(a.body.pos.x - gr.pos.x, a.body.pos.z - gr.pos.z);
      if (d > 28) continue;
      eyePos(a.body, _origin);
      const blocked = (() => {
        // reuse the map LOS test via a raycast against walls
        raycaster.set(_origin, new THREE.Vector3(gr.pos.x - _origin.x, gr.pos.y - _origin.y, gr.pos.z - _origin.z).normalize());
        raycaster.far = d;
        return raycaster.intersectObjects(wallMeshes, false).length > 0;
      })();
      if (blocked) continue;
      const facing = a.isPlayer ? camera.getWorldDirection(new THREE.Vector3()) : new THREE.Vector3(-Math.sin(a.body.yaw), 0, -Math.cos(a.body.yaw));
      const toFlash = new THREE.Vector3(gr.pos.x - _origin.x, gr.pos.y - _origin.y, gr.pos.z - _origin.z).normalize();
      const dot = facing.dot(toFlash);
      const strength = clamp(1.2 - d / 28, 0.25, 1) * (dot > -0.2 ? 1 : 0.4);
      if (a.isPlayer) hud.flashBlind(strength);
      else a.ai.blindT = Math.max(a.ai.blindT || 0, strength * 2.5);
    }
  }
}

// ---- bomb (player side) -------------------------------------------------------
function playerBombAction(dt) {
  const b = match.bomb;
  const attacking = match.attackTeam === 'harbor';
  // Plant: carrier, in a site, holding E.
  if (b.state === 'carried' && b.carrier === player && attacking && player.body.alive) {
    const site = Object.values(SITES).find((s) => pointInSite(player.body.pos.x, player.body.pos.z, s));
    if (site && keys['KeyE']) {
      state.plantT += dt;
      hud.showPlant(`Planting charge — ${site.id}`, state.plantT / PLANT_TIME);
      if (Math.floor(state.plantT * 2) !== Math.floor((state.plantT - dt) * 2)) audio.plantBeep(Math.floor(state.plantT));
      if (state.plantT >= PLANT_TIME) {
        state.plantT = 0;
        hud.hidePlant();
        plantBomb(match, site.id);
        player.money += PLANT_REWARD;
        hud.setMoney(player.money);
        hud.killfeedAdd(`YOU planted the charge at ${site.id}`, true);
        bombMesh.visible = true;
        bombMesh.position.set(site.x, 0.2, site.z);
        onBombPlantedOrders(world, site.id);
        audio.plantBeep(6);
      }
      return;
    }
  }
  // Defuse: bomb planted, defender, near the charge, holding E.
  if (b.state === 'planted' && !attacking && player.body.alive) {
    const d = Math.hypot(player.body.pos.x - b.x, player.body.pos.z - b.z);
    if (d < 2.6 && keys['KeyE']) {
      state.defuseT += dt;
      hud.showPlant('Defusing charge', state.defuseT / DEFUSE_TIME);
      if (Math.floor(state.defuseT * 2) !== Math.floor((state.defuseT - dt) * 2)) audio.plantBeep(Math.floor(state.defuseT));
      if (state.defuseT >= DEFUSE_TIME) {
        state.defuseT = 0;
        hud.hidePlant();
        player.money += DEFUSE_REWARD;
        hud.setMoney(player.money);
        closeRound('rust' === match.attackTeam ? 'harbor' : 'rust', 'Charge defused');
      }
      return;
    }
  }
  if (state.plantT > 0 || state.defuseT > 0) { state.plantT = 0; state.defuseT = 0; hud.hidePlant(); }
  // Pick up a dropped charge by walking over it.
  if (b.state === 'dropped' && attacking && player.body.alive) {
    const d = Math.hypot(player.body.pos.x - b.x, player.body.pos.z - b.z);
    if (d < 1.3) {
      match.bomb = { state: 'carried', carrier: player, site: null, x: 0, z: 0, timer: 0 };
      bombMesh.visible = false;
      hud.setBombStatus('You carry the charge', false);
      hud.toast('Charge picked up');
    }
  }
}

// ---- round flow ---------------------------------------------------------------
function closeRound(winner, reason) {
  const res = endRound(match, winner, reason);
  const playerWon = winner === 'harbor';
  const reward = winner === 'harbor' ? res.harborReward : res.rustReward;
  if (winner === 'harbor') player.money += res.harborReward;
  else player.money += res.rustReward;
  hud.setMoney(player.money);
  hud.showBanner(
    playerWon ? 'ROUND WON' : 'ROUND LOST',
    `${reason} · +$${reward} · Wardens ${match.wins.harbor} — ${match.wins.rust} Smugglers`,
    playerWon,
  );
  if (playerWon) audio.roundWin(); else audio.roundLose();
  if (match.bomb.state === 'planted' && reason === 'Charge detonated') {
    fx.explosion(new THREE.Vector3(match.bomb.x, 1, match.bomb.z));
    audio.explosion();
    state.trauma = 1;
  }
  match.bomb.state = 'done';
  bombMesh.visible = false;
}

function beginRound(round) {
  startRound(match, round);
  // Reset every agent: spawn, health, ammo; weapons and money persist.
  const atkSpawns = match.attackTeam === 'harbor' ? SPAWNS.attack : SPAWNS.defend;
  const defSpawns = match.attackTeam === 'harbor' ? SPAWNS.defend : SPAWNS.attack;
  player.body.pos.set(atkSpawns[0].x, 0, atkSpawns[0].z);
  player.body.yaw = 0; player.body.pitch = 0; player.body.vel.set(0, 0, 0);
  player.body.hp = 100; player.body.alive = true; player.body.crouch = false;
  refillAmmo(player.loadout);
  let ai = 0;
  let di = 0;
  for (const bot of bots) {
    const sp = bot.team === match.attackTeam ? atkSpawns[1 + (ai++ % 4)] : defSpawns[di++ % 5];
    bot.body.pos.set(sp.x, 0, sp.z);
    bot.body.yaw = bot.team === match.attackTeam ? 0 : Math.PI;
    bot.body.hp = 100; bot.body.alive = true; bot.body.vel.set(0, 0, 0);
    refillAmmo(bot.loadout);
    bot.mesh.group.rotation.x = 0;
    bot.mesh.group.position.y = 0;
    bot.ai.state = 'route';
    bot.ai.target = null;
    bot.ai.blindT = 0;
  }
  // The charge goes to the player when Harbor attacks, else the first Rust bot.
  if (match.attackTeam === 'harbor') match.bomb.carrier = player;
  else match.bomb.carrier = bots.find((b) => b.team === 'rust');
  match.bomb.state = 'carried';
  bombMesh.visible = false;
  state.grenades.length = 0;
  state.plantT = 0;
  state.defuseT = 0;
  assignRoundOrders(world);
  const side = match.attackTeam === 'harbor' ? 'ATTACK' : 'DEFEND';
  hud.setObjective(match.attackTeam === 'harbor'
    ? 'Plant the charge at Site A or B — you carry it'
    : 'Defend both sites — stop the plant');
  hud.setBombStatus(match.attackTeam === 'harbor' ? 'You carry the charge' : '', false);
  hud.setScore(match.wins.harbor, match.wins.rust, round);
  hud.showBanner(`ROUND ${round} — ${side}`, 'Buy phase · press [B] to buy', null);
  hud.showBuy(player.money);
  updateWeaponLabel();
}

// ---- the bot world ------------------------------------------------------------
const world = {
  state: match, rng, waypoints, agents, fx, audio,
  shotEvents: state.shotEvents,
  takeRound: (bot) => takeRound(bot.loadout),
  reloadBot: (bot) => { startReload(bot.loadout); },
  fireHitscan: (bot, origin, dir, def) => {
    resolveShot(bot, origin, dir, def);
    muzzlePos(bot, _origin);
    fx.tracer(_origin, _origin.clone().addScaledVector(dir, def.range));
    state.shotEvents.push({ x: bot.body.pos.x, z: bot.body.pos.z, team: bot.team, t: state.time });
  },
  onPlant: (bot) => {
    plantBomb(match, bot.ai.site);
    hud.killfeedAdd(`${bot.name} planted the charge at ${bot.ai.site}`, false);
    bombMesh.visible = true;
    const s = SITES[bot.ai.site];
    bombMesh.position.set(s.x, 0.2, s.z);
    onBombPlantedOrders(world, bot.ai.site);
    audio.plantBeep(6);
  },
  onDefuse: (bot) => {
    closeRound(bot.team, 'Charge defused');
  },
};

// ---- simulation step ----------------------------------------------------------
function aliveCount() {
  let harbor = 0;
  let rust = 0;
  for (const a of agents) {
    if (!a.body.alive) continue;
    if (a.team === 'harbor') harbor++; else rust++;
  }
  return { harbor, rust };
}

function step(dt) {
  state.time += dt;
  state.tick++;
  match.time = state.time;

  // Player movement (only while alive and the round is running).
  if (player.body.alive && (match.phase === 'live' || match.phase === 'buy')) {
    const joy = touch.joy || { x: 0, y: 0 };
    const input = {
      f: !!keys['KeyW'] || joy.y < -0.3, b: !!keys['KeyS'] || joy.y > 0.3,
      l: !!keys['KeyA'] || joy.x < -0.3, r: !!keys['KeyD'] || joy.x > 0.3,
      crouch: !!keys['ControlLeft'] || !!keys['ControlRight'],
      jump: !!keys['Space'],
      ads: state.ads,
      sprint: !!keys['ShiftLeft'] || !!keys['ShiftRight'],
    };
    const def = currentWeapon(player.loadout);
    const speed = movePlayer(player.body, input, def, dt);
    // Mouse look.
    player.body.yaw -= mouseDX * 0.0022;
    player.body.pitch -= mouseDY * 0.0022;
    player.body.pitch = clamp(player.body.pitch, -1.45, 1.45);
    swayX = clamp(swayX - mouseDX * 0.00005, -0.025, 0.025);
    mouseDX = 0;
    mouseDY = 0;
    // Footsteps.
    if (player.body.stepped) { player.body.stepped = false; audio.step(speed > 4); }
    // Firing.
    const firing = state.firing && (def.auto || state.firingSemi);
    if (firing && match.phase === 'live') {
      if (fireFrom(player)) state.firingSemi = false;
      else state.firingSemi = false;
    }
    if (tickWeapon(player.loadout, dt)) audio.click();
    // Bomb actions.
    if (match.phase === 'live') playerBombAction(dt);
    // ADS zoom.
    const wantFov = state.ads && def.zoomFov ? def.zoomFov : 74;
    if (Math.abs(camera.fov - wantFov) > 0.5) {
      camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 14);
      camera.updateProjectionMatrix();
    }
    // Crosshair spread readout.
    const spread = computeSpread(def, speed, player.body.airborne, player.body.crouch, state.ads, player.loadout.bloom);
    hud.setCrosshairGap(4 + spread * 900);
  }

  // Grenades fly.
  for (let i = state.grenades.length - 1; i >= 0; i--) {
    const gr = state.grenades[i];
    gr.t -= dt;
    gr.vel.y -= 12 * dt;
    gr.pos.addScaledVector(gr.vel, dt);
    if (gr.pos.y < 0.15) { gr.pos.y = 0.15; gr.vel.y *= -0.35; gr.vel.x *= 0.6; gr.vel.z *= 0.6; }
    if (gr.t <= 0) { detonateGrenade(gr); state.grenades.splice(i, 1); }
  }

  // Bots.
  for (const bot of bots) {
    if (bot.ai.blindT > 0) bot.ai.blindT -= dt;
    updateBot(bot, world, dt);
    tickWeapon(bot.loadout, dt); // cooldowns + reloads tick every step
    // Bots pick up a dropped charge.
    if (match.bomb.state === 'dropped' && bot.team === match.attackTeam && bot.body.alive) {
      const d = Math.hypot(bot.body.pos.x - match.bomb.x, bot.body.pos.z - match.bomb.z);
      if (d < 1.3) {
        match.bomb = { state: 'carried', carrier: bot, site: null, x: 0, z: 0, timer: 0 };
        bombMesh.visible = false;
      }
    }
  }

  // Round clock.
  const alive = aliveCount();
  const ev = tickMatch(match, dt, alive);
  if (ev === 'live') {
    hud.hideBuy();
    hud.showBanner(`ROUND ${match.round}`, 'Go — plant or eliminate', null);
  } else if (ev === 'bomb') {
    closeRound(match.attackTeam, 'Charge detonated');
  } else if (ev === 'elim-harbor') {
    closeRound('harbor', 'Smugglers eliminated');
  } else if (ev === 'elim-rust') {
    closeRound('rust', 'Wardens eliminated');
  } else if (ev === 'timeout') {
    closeRound(match.attackTeam === 'harbor' ? 'rust' : 'harbor', 'Time expired — defense holds');
  } else if (ev === 'next') {
    if (match.matchWinner) {
      match.phase = 'matchend';
      const won = match.matchWinner === 'harbor';
      hud.showMatchEnd(
        match.matchWinner === 'draw' ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT',
        `Wardens ${match.wins.harbor} — ${match.wins.rust} Smugglers · ${won ? 'The harbor is ours.' : 'The Smugglers keep the docks.'}`,
      );
      if (won) audio.roundWin(); else audio.roundLose();
    } else {
      beginRound(match.round + 1);
    }
  }

  // Bomb beeping light.
  if (match.bomb.state === 'planted') {
    const light = bombMesh.getObjectByName('bomb-light');
    if (light) {
      const period = Math.max(0.25, match.bomb.timer / BOMB_TIME * 1.1);
      light.material.color.setHex(Math.floor(state.time / period) % 2 === 0 ? 0xff2222 : 0x440000);
      if (Math.floor(state.time / period) !== Math.floor((state.time - dt) / period)) audio.plantBeep(3);
    }
  }

  // HUD (values that change every step).
  hud.setHealth(player.body.hp, player.loadout.armor);
  const ammo = player.loadout.ammo[player.loadout.current];
  if (player.loadout.current === 'blade') hud.setAmmo('—', '', false);
  else hud.setAmmo(ammo.mag, ammo.reserve, player.loadout.reloading > 0);
  hud.setMoney(player.money);
  hud.setTimer(match.phase === 'end' || match.phase === 'matchend' ? 0 : match.roundTime, match.phase);
  hud.setSideInfo(`${match.attackTeam === 'harbor' ? 'WARDENS ATTACK' : 'SMUGGLERS ATTACK'} · ${alive.harbor}v${alive.rust} alive`);
  // Minimap at ~10 Hz: walls, sites, player, allies, enemies the player
  // can actually see (LOS-checked, so no wallhack).
  if (state.tick % 6 === 0 && match.phase !== 'matchend') {
    const enemies = [];
    eyePos(player.body, _eyeA);
    for (const b of bots) {
      if (b.team === 'rust' && b.body.alive) {
        eyePos(b.body, _eyeB);
        const d = Math.hypot(_eyeB.x - _eyeA.x, _eyeB.z - _eyeA.z);
        if (d < 55 && !segmentBlocked(_eyeA.x, _eyeA.y, _eyeA.z, _eyeB.x, _eyeB.y, _eyeB.z)) {
          enemies.push({ x: b.body.pos.x, z: b.body.pos.z });
        }
      }
    }
    hud.drawMinimap({
      walls: map.colliders,
      sites: Object.values(SITES),
      player: { x: player.body.pos.x, z: player.body.pos.z, yaw: player.body.yaw },
      allies: bots.filter((b) => b.team === 'harbor' && b.body.alive).map((b) => ({ x: b.body.pos.x, z: b.body.pos.z })),
      enemies,
    });
  }
  if (match.bomb.state === 'planted') {
    hud.setBombStatus(`CHARGE PLANTED — ${match.bomb.site} · ${Math.ceil(match.bomb.timer)}s`, true);
  }
  // Prune old shot events.
  if (state.shotEvents.length > 40) state.shotEvents.splice(0, state.shotEvents.length - 40);
}

// ---- render -------------------------------------------------------------------
let lastTime = performance.now();
let accumulator = 0;
let renders = 0;

function render() {
  if (player.body.alive) {
    syncCamera(camera, player.body);
  } else {
    // Spectate the first living ally in first person.
    const ally = agents.find((a) => a.team === 'harbor' && a.body.alive && !a.isPlayer)
      || agents.find((a) => a.body.alive);
    if (ally) syncCamera(camera, ally.body);
  }
  // Screen shake (trauma^2, decays).
  if (state.trauma > 0.001) {
    const s = state.trauma * state.trauma * 0.05;
    camera.position.x += (rng() - 0.5) * s;
    camera.position.y += (rng() - 0.5) * s;
    state.trauma = Math.max(0, state.trauma - 0.02);
  }
  // Viewmodel kick + walk bob + reload dip + melee swing + sway.
  viewKick = Math.max(0, viewKick - 0.004);
  if (swingT > 0) swingT -= 1 / 60;
  const vm = viewmodels[player.loadout.current];
  const bob = player.body.alive ? Math.sin(state.time * 9) * 0.006 * Math.min(1, Math.hypot(player.body.vel.x, player.body.vel.z) / 5) : 0;
  const reloadFrac = player.loadout.reloading > 0
    ? Math.sin((1 - player.loadout.reloading / currentWeapon(player.loadout).reloadTime) * Math.PI) : 0;
  for (const [k, g] of Object.entries(viewmodels)) g.visible = player.body.alive && k === player.loadout.current;
  vm.position.z = -0.5 + viewKick;
  vm.position.y = -0.24 + bob - reloadFrac * 0.1;
  vm.position.x = 0.26 + swayX;
  vm.rotation.x = reloadFrac * 0.5;
  vm.rotation.z = swingT > 0 ? Math.sin((0.28 - swingT) / 0.28 * Math.PI) * 0.8 : 0;
  swayX *= 0.9;
  fx.update(1 / 60);
  renderer.render(scene, camera);
  renders++;
}

function loop(now) {
  if (state.frozen) return;
  requestAnimationFrame(loop);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, 0.1);
  accumulator += dt;
  while (accumulator >= FIXED_STEP) {
    step(FIXED_STEP);
    accumulator -= FIXED_STEP;
  }
  render();
}

// ---- deterministic screenshot modes -------------------------------------------
function setupShot(kind) {
  beginRound(1);
  hud.hideOverlay();
  hud.hideBuy();
  hud.hideBanner();
  if (kind === 'start') {
    // Spawn, buy menu open, allies in view.
    player.body.pos.set(0, 0, 17);
    player.body.yaw = 0.25;
    player.body.pitch = -0.02;
    hud.showBuy(player.money);
    hud.setObjective('Buy phase — gear up, then plant at A or B');
    placeAlliesForShot();
  } else if (kind === 'play') {
    match.phase = 'live';
    match.roundTime = 62;
    match.wins.harbor = 1;
    player.money = 2450;
    player.body.pos.set(0, 0, 6);
    player.body.yaw = 0.12;
    player.body.pitch = 0.01;
    player.loadout.owned.ar = true;
    player.loadout.ammo.ar = { mag: 21, reserve: 75 };
    switchWeapon(player.loadout, 'ar');
    updateWeaponLabel();
    // Two enemies mid, one ally on the left lane.
    const e1 = bots.find((b) => b.name === 'SCRAP');
    const e2 = bots.find((b) => b.name === 'BOLT');
    const a1 = bots.find((b) => b.name === 'MARA');
    e1.body.pos.set(-1.5, 0, -7);
    e1.body.yaw = Math.PI;
    e2.body.pos.set(4, 0, -9);
    e2.body.yaw = Math.PI - 0.4;
    a1.body.pos.set(-4.5, 0, 9);
    a1.body.yaw = 0.3;
    for (const b of bots) {
      if (b !== e1 && b !== e2 && b !== a1) { b.body.pos.set(20, 0, 14); b.body.alive = true; }
    }
    hud.hideBuy();
    hud.killfeedAdd('YOU ▸ RUSTY', true);
    hud.setScore(1, 0, 1);
    hud.setObjective('Mid control — push Site A or B');
    // One live tracer + hitmarker for the action frame.
    state.firing = false;
    fireFrom(player);
  } else if (kind === 'end') {
    match.phase = 'end';
    match.endT = 5;
    match.roundTime = 0;
    match.wins.harbor = 1;
    plantBomb(match, 'A');
    bombMesh.visible = true;
    bombMesh.position.set(SITES.A.x, 0.2, SITES.A.z);
    player.body.pos.set(-14, 0, 2);
    player.body.yaw = 0.84;
    player.body.pitch = 0.02;
    const d1 = bots.find((b) => b.name === 'SCRAP');
    const d2 = bots.find((b) => b.name === 'GRIME');
    d1.body.alive = false; d1.mesh.group.rotation.x = -Math.PI / 2; d1.mesh.group.position.set(-22, 0.35, -5);
    d2.body.alive = false; d2.mesh.group.rotation.x = -Math.PI / 2; d2.mesh.group.position.set(-26, 0.35, -10);
    hud.showBanner('ROUND WON', 'Site A secured · Wardens 1 — 0 Smugglers', true);
    hud.setScore(1, 0, 1);
    hud.setBombStatus('CHARGE PLANTED — A · 32s', true);
  } else if (kind === 'win') {
    match.phase = 'matchend';
    match.wins.harbor = 5;
    match.wins.rust = 3;
    match.matchWinner = 'harbor';
    player.body.pos.set(0, 0, 8);
    player.body.yaw = 0;
    hud.showMatchEnd('VICTORY', 'Wardens 5 — 3 Smugglers · The harbor is ours.');
    hud.setScore(5, 3, 9);
  }
  // Settle: run a few fixed steps so meshes, HUD and FX are placed, then
  // render twice and freeze.
  for (let i = 0; i < 10; i++) step(FIXED_STEP);
  syncCamera(camera, player.body);
  render();
  render();
  state.frozen = true;
  window.__shotReady = true;
}

function placeAlliesForShot() {
  const spots = [{ x: -2.5, z: 16, yaw: 0.2 }, { x: 2.5, z: 16, yaw: -0.2 }];
  const allies = bots.filter((b) => b.team === 'harbor');
  allies.forEach((b, i) => {
    const s = spots[i % spots.length];
    b.body.pos.set(s.x, 0, s.z);
    b.body.yaw = s.yaw;
    b.mesh.group.position.copy(b.body.pos);
    b.mesh.group.rotation.y = b.body.yaw;
  });
}

// ---- boot ---------------------------------------------------------------------
beginRound(1);
updateWeaponLabel();
showViewmodel();
hud.setMuted(false);
window.__game = { state, match, agents, player, bots, hud, touch };
if (shot) {
  setupShot(shot);
} else {
  requestAnimationFrame(loop);
}
