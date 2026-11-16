// Pooled visual effects: tracers, muzzle flash, impact sparks, smoke clouds,
// explosion flash. Everything is allocated once at boot and reused — the hot
// loop never news an object. All timers tick in the fixed simulation step.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const TRACER_MAX = 24;
const SPARK_MAX = 320;
const SMOKE_MAX = 8;

function makeSmokeTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(200,205,215,0.85)');
  grad.addColorStop(0.55, 'rgba(160,168,180,0.45)');
  grad.addColorStop(1, 'rgba(140,148,160,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createFx(scene) {
  const smokeTex = makeSmokeTexture();
  const tracers = [];
  for (let i = 0; i < TRACER_MAX; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xffd27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    line.frustumCulled = false;
    line.visible = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }

  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_MAX * 3), 3));
  const sparkMat = new THREE.PointsMaterial({ color: 0xffc46b, size: 0.14, transparent: true, opacity: 0.95, depthWrite: false });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  sparks.visible = false;
  scene.add(sparks);
  const sparkVel = new Float32Array(SPARK_MAX * 3);
  const sparkLife = new Float32Array(SPARK_MAX);
  let sparkCursor = 0;

  const smokes = [];
  for (let i = 0; i < SMOKE_MAX; i++) {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: smokeTex, transparent: true, opacity: 0, depthWrite: false,
    }));
    spr.scale.set(1, 1, 1);
    spr.visible = false;
    scene.add(spr);
    smokes.push({ spr, life: 0, max: 1, x: 0, y: 0, z: 0 });
  }

  // Muzzle flash: a small radial sprite at the barrel tip (a big plane
  // would cover the whole screen at this distance).
  const flashMat = new THREE.SpriteMaterial({
    map: smokeTex, color: 0xffc46b, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Sprite(flashMat);
  flash.scale.set(0.45, 0.45, 1);
  flash.visible = false;
  scene.add(flash);

  // Explosion flash: one big additive sprite, reused.
  const boomMat = new THREE.SpriteMaterial({ map: smokeTex, color: 0xffb347, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const boom = new THREE.Sprite(boomMat);
  boom.visible = false;
  scene.add(boom);
  let boomLife = 0;

  // Ejected shells: 8 small brass capsules, pooled, with gravity.
  const shells = [];
  const shellGeo = new THREE.CapsuleGeometry(0.02, 0.05, 2, 6);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xd8a93a, roughness: 0.35, metalness: 0.8 });
  for (let i = 0; i < 8; i++) {
    const s = new THREE.Mesh(shellGeo, shellMat);
    s.visible = false;
    scene.add(s);
    shells.push({ mesh: s, vel: new THREE.Vector3(), life: 0 });
  }
  let shellCursor = 0;

  const tmp = new THREE.Vector3();

  return {
    tracer(from, to) {
      let best = tracers[0];
      for (const t of tracers) if (t.life <= 0) { best = t; break; }
      const pos = best.line.geometry.attributes.position;
      pos.setXYZ(0, from.x, from.y, from.z);
      pos.setXYZ(1, to.x, to.y, to.z);
      pos.needsUpdate = true;
      best.line.visible = true;
      best.line.material.opacity = 0.9;
      best.life = 0.07;
    },
    sparksAt(p, n, spread = 3) {
      for (let k = 0; k < n; k++) {
        const i = sparkCursor;
        sparkCursor = (sparkCursor + 1) % SPARK_MAX;
        const pos = sparkGeo.attributes.position;
        pos.setXYZ(i, p.x, p.y, p.z);
        sparkVel[i * 3] = (Math.random() - 0.5) * spread;
        sparkVel[i * 3 + 1] = Math.random() * spread * 0.7;
        sparkVel[i * 3 + 2] = (Math.random() - 0.5) * spread;
        sparkLife[i] = 0.35;
      }
      sparkGeo.attributes.position.needsUpdate = true;
      sparks.visible = true;
    },
    smokeAt(x, y, z, dur = 14) {
      let slot = smokes.find((s) => s.life <= 0) || smokes[0];
      slot.x = x; slot.y = y; slot.z = z;
      slot.life = dur; slot.max = dur;
      slot.spr.position.set(x, y, z);
      slot.spr.scale.set(2, 2, 1);
      slot.spr.visible = true;
    },
    smokeActive() {
      return smokes.filter((s) => s.life > 0).map((s) => ({ x: s.x, y: s.y, z: s.z, r: 3.6 }));
    },
    muzzle(pos, dir) {
      tmp.copy(pos).addScaledVector(dir, 0.35);
      flash.position.copy(tmp);
      flash.visible = true;
      flashMat.opacity = 0.95;
    },
    explosion(p) {
      boom.position.copy(p);
      boom.scale.set(2, 2, 1);
      boom.visible = true;
      boomMat.opacity = 1;
      boomLife = 0.7;
      this.sparksAt(p, 60, 9);
    },
    eject(pos, right) {
      const s = shells[shellCursor];
      shellCursor = (shellCursor + 1) % shells.length;
      s.mesh.position.copy(pos);
      s.mesh.visible = true;
      s.vel.set(right.x * 1.6 + (Math.random() - 0.5), 2.2 + Math.random(), right.z * 1.6 + (Math.random() - 0.5));
      s.life = 0.7;
    },
    update(dt) {
      for (const t of tracers) {
        if (t.life > 0) {
          t.life -= dt;
          t.line.material.opacity = Math.max(0, t.life / 0.07) * 0.9;
          if (t.life <= 0) t.line.visible = false;
        }
      }
      let anySpark = false;
      for (let i = 0; i < SPARK_MAX; i++) {
        if (sparkLife[i] > 0) {
          sparkLife[i] -= dt;
          const pos = sparkGeo.attributes.position;
          pos.setXYZ(i,
            pos.getX(i) + sparkVel[i * 3] * dt,
            pos.getY(i) + sparkVel[i * 3 + 1] * dt,
            pos.getZ(i) + sparkVel[i * 3 + 2] * dt);
          sparkVel[i * 3 + 1] -= 9 * dt;
          anySpark = true;
        }
      }
      sparkGeo.attributes.position.needsUpdate = true;
      sparks.visible = anySpark;
      for (const s of smokes) {
        if (s.life > 0) {
          s.life -= dt;
          const grow = 1 + (1 - s.life / s.max) * 5;
          s.spr.scale.set(grow, grow, 1);
          s.spr.material.opacity = Math.min(0.85, s.life / s.max * 1.4) * 0.8;
          if (s.life <= 0) s.spr.visible = false;
        }
      }
      if (flashMat.opacity > 0) {
        flashMat.opacity -= dt * 14;
        if (flashMat.opacity <= 0) flash.visible = false;
      }
      if (boomLife > 0) {
        boomLife -= dt;
        const k = Math.max(0, boomLife / 0.7);
        boom.scale.set(2 + (1 - k) * 14, 2 + (1 - k) * 14, 1);
        boomMat.opacity = k;
        if (boomLife <= 0) boom.visible = false;
      }
      for (const s of shells) {
        if (s.life > 0) {
          s.life -= dt;
          s.vel.y -= 12 * dt;
          s.mesh.position.addScaledVector(s.vel, dt);
          if (s.mesh.position.y < 0.03) { s.mesh.position.y = 0.03; s.vel.set(0, 0, 0); }
          s.mesh.rotation.x += dt * 9;
          if (s.life <= 0) s.mesh.visible = false;
        }
      }
    },
  };
}
