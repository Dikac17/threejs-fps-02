// Player controller: acceleration movement, crouch, jump, per-axis AABB
// collision (wall sliding), camera + recoil. Reads input keys each fixed
// step; never touches the DOM. The same agent shape is used for bots.
import * as THREE from 'three';
import { collideMove } from './map.js';
import { clamp } from './rng.js';

export const WALK_SPEED = 5.4;
export const CROUCH_SPEED = 2.7;
export const SPRINT_MULT = 1.35;
export const ACCEL = 42;
export const FRICTION = 11;
export const JUMP_VEL = 5.4;
export const GRAVITY = 15;
export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.05;
export const AGENT_RADIUS = 0.38;

export function eyePos(agent, out) {
  out.set(agent.pos.x, agent.pos.y + (agent.crouch ? EYE_CROUCH : EYE_STAND), agent.pos.z);
  return out;
}

// Per-agent mutable body state, created by main.js for player and bots.
export function createBody(x, z, yaw) {
  return {
    pos: new THREE.Vector3(x, 0, z),
    vel: new THREE.Vector3(0, 0, 0),
    yaw, pitch: 0,
    hp: 100, armor: 0, alive: true,
    crouch: false, airborne: false,
    vy: 0,
    recoilPitch: 0, recoilYaw: 0,
    stepT: 0, // footstep timer
  };
}

// Move the player body. input: {f,b,l,r,crouch,jump,ads,sprint}. Returns move speed.
export function movePlayer(body, input, def, dt) {
  let speed = (input.crouch ? CROUCH_SPEED : WALK_SPEED)
    * (def ? def.moveMult : 1) * (input.ads ? 0.6 : 1);
  if (input.sprint && !input.crouch && !input.ads) speed *= SPRINT_MULT;
  const sin = Math.sin(body.yaw);
  const cos = Math.cos(body.yaw);
  let ix = 0;
  let iz = 0;
  if (input.f) { ix += -sin; iz += -cos; }
  if (input.b) { ix += sin; iz += cos; }
  if (input.l) { ix += -cos; iz += sin; }
  if (input.r) { ix += cos; iz += -sin; }
  const len = Math.hypot(ix, iz);
  if (len > 0) { ix /= len; iz /= len; }
  // Sprint also raises acceleration: with plain friction the practical top
  // speed plateaus below the raised clamp, so a sprint would feel no
  // faster than a walk. 1.35x accel pushes the equilibrium past the clamp.
  const accel = ACCEL * (input.sprint && !input.crouch && !input.ads ? SPRINT_MULT : 1);
  body.vel.x += ix * accel * dt;
  body.vel.z += iz * accel * dt;
  // Friction (stronger when no input)
  const fr = len > 0 ? FRICTION * 0.55 : FRICTION;
  body.vel.x -= body.vel.x * Math.min(1, fr * dt);
  body.vel.z -= body.vel.z * Math.min(1, fr * dt);
  const hSpeed = Math.hypot(body.vel.x, body.vel.z);
  const max = speed * (len > 0 ? 1 : 0.9);
  if (hSpeed > max) {
    body.vel.x *= max / hSpeed;
    body.vel.z *= max / hSpeed;
  }
  collideMove(body.pos, AGENT_RADIUS, body.crouch ? 1.15 : 1.75, body.pos.y,
    body.vel.x * dt, body.vel.z * dt);
  // Jump / gravity
  if (input.jump && !body.airborne) {
    body.vy = JUMP_VEL;
    body.airborne = true;
  }
  if (body.airborne) {
    body.vy -= GRAVITY * dt;
    body.pos.y += body.vy * dt;
    if (body.pos.y <= 0) { body.pos.y = 0; body.vy = 0; body.airborne = false; }
  }
  // Footstep timing for audio
  if (hSpeed > 1.5 && !body.airborne) {
    body.stepT -= dt * hSpeed;
    if (body.stepT <= 0) {
      body.stepT = 3.2;
      body.stepped = true;
    }
  }
  // Recoil recovery
  body.recoilPitch = Math.max(0, body.recoilPitch - dt * 0.09);
  body.recoilYaw *= Math.max(0, 1 - dt * 8);
  return Math.hypot(body.vel.x, body.vel.z);
}

// Apply recoil kick from a shot.
export function applyRecoil(body, def, rng) {
  body.recoilPitch += def.recoilPitch;
  body.recoilYaw += (rng() - 0.5) * 2 * def.recoilYaw;
}

// Camera follows the body (plus recoil); called every render.
export function syncCamera(camera, body) {
  camera.position.set(
    body.pos.x,
    body.pos.y + (body.crouch ? EYE_CROUCH : EYE_STAND),
    body.pos.z,
  );
  camera.rotation.set(body.pitch + body.recoilPitch, body.yaw + body.recoilYaw, 0, 'YXZ');
  camera.rotation.x = clamp(camera.rotation.x, -1.45, 1.45);
}

// Damage with armour: armour absorbs 30% until it runs out.
export function applyDamage(agent, dmg) {
  if (!agent.body.alive) return 0;
  let hpDmg = dmg;
  if (agent.loadout && agent.loadout.armor > 0) {
    const absorbed = dmg * 0.3;
    const used = Math.min(agent.loadout.armor, absorbed);
    agent.loadout.armor -= used;
    hpDmg = dmg - used;
  }
  agent.body.hp -= hpDmg;
  if (agent.body.hp <= 0) {
    agent.body.hp = 0;
    agent.body.alive = false;
  }
  return hpDmg;
}
