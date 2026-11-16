// Touch controls (Android): virtual joystick, drag-to-aim, action buttons.
// Only activates on touch-capable devices (adds body.touch, which shows
// #touch-ui). The module writes into the same keys/state the keyboard path
// uses, so the simulation never knows which input produced a move.
export function createTouch(hooks) {
  const capable = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
  if (!capable) return { active: false };
  document.body.classList.add('touch');
  const $ = (id) => document.getElementById(id);
  const zone = $('stick-zone');
  const nub = $('stick-nub');
  const joy = { x: 0, y: 0, id: null };
  const aim = { id: null, lx: 0, ly: 0 };

  function setNub(dx, dy) {
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    joy.id = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    moveJoy(e);
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joy.id) return;
    moveJoy(e);
  });
  function endJoy(e) {
    if (e.pointerId !== joy.id) return;
    joy.id = null; joy.x = 0; joy.y = 0;
    setNub(0, 0);
  }
  zone.addEventListener('pointerup', endJoy);
  zone.addEventListener('pointercancel', endJoy);
  function moveJoy(e) {
    const r = zone.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    const max = r.width / 2;
    if (len > max) { dx *= max / len; dy *= max / len; }
    joy.x = dx / max;
    joy.y = dy / max;
    setNub(dx, dy);
  }

  // Drag anywhere on the right half of the screen to aim (the canvas gets
  // the touches; buttons and the stick zone are separate elements).
  const canvas = hooks.canvas;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || aim.id !== null) return;
    if (e.clientX < window.innerWidth / 2) return;
    aim.id = e.pointerId;
    aim.lx = e.clientX;
    aim.ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== aim.id) return;
    hooks.onLook((e.clientX - aim.lx) * 2.4, (e.clientY - aim.ly) * 2.4);
    aim.lx = e.clientX;
    aim.ly = e.clientY;
  });
  function endAim(e) {
    if (e.pointerId === aim.id) aim.id = null;
  }
  canvas.addEventListener('pointerup', endAim);
  canvas.addEventListener('pointercancel', endAim);

  function hold(id, down, up) {
    const b = $(id);
    if (!b) return;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); down(); });
    b.addEventListener('pointerup', (e) => { e.preventDefault(); if (up) up(); });
    b.addEventListener('pointercancel', () => { if (up) up(); });
    b.addEventListener('pointerleave', () => { if (up) up(); });
  }
  hold('btn-fire', () => hooks.onFire(true), () => hooks.onFire(false));
  hold('btn-jump', () => hooks.onJump());
  hold('btn-crouch', () => hooks.onCrouch());
  hold('btn-reload', () => hooks.onReload());
  hold('btn-weapon', () => hooks.onCycleWeapon());
  hold('btn-grenade', () => hooks.onGrenade());

  return { active: true, joy };
}
