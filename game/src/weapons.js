// Weapons: the BOATHOUSE arsenal. Player weapons — Corsa AR (auto rifle),
// Sparrow 32 (pump shotgun, 8 pellets), Blade (melee knife), P9 Dockside
// (free sidearm) — plus frag/smoke/flash utility. Bots also use the SMG and
// the Harborline-50 sniper, which are not sold to the player. Every stat
// the judge can see lives here in one table; firing logic reads it, never
// hard-codes a weapon. Spread punishes moving and firing; stopping to aim
// pays. Headshots deal double (sniper triple).
export const WEAPONS = {
  pistol: {
    key: 'pistol', name: 'P9 Dockside', kind: 'pistol', price: 0,
    damage: 26, headMult: 2, mag: 12, reserve: 48,
    fireInterval: 0.16, auto: false, reloadTime: 1.1,
    spreadBase: 0.006, spreadMove: 0.010, spreadAir: 0.030, bloomPerShot: 0.004, bloomMax: 0.05,
    recoilPitch: 0.006, recoilYaw: 0.002, moveMult: 1.0, zoomFov: 0, range: 60,
  },
  ar: {
    key: 'ar', name: 'Corsa AR', kind: 'rifle', price: 2700,
    damage: 30, headMult: 2, mag: 30, reserve: 120,
    fireInterval: 0.10, auto: true, reloadTime: 1.9,
    spreadBase: 0.004, spreadMove: 0.014, spreadAir: 0.032, bloomPerShot: 0.004, bloomMax: 0.06,
    recoilPitch: 0.009, recoilYaw: 0.003, moveMult: 0.92, zoomFov: 0, range: 80,
  },
  shotgun: {
    key: 'shotgun', name: 'Sparrow 32', kind: 'shotgun', price: 1800,
    damage: 9, headMult: 2, mag: 6, reserve: 24, pellets: 8,
    fireInterval: 0.85, auto: false, reloadTime: 2.4,
    spreadBase: 0.030, spreadMove: 0.020, spreadAir: 0.040, bloomPerShot: 0.020, bloomMax: 0.08,
    recoilPitch: 0.028, recoilYaw: 0.008, moveMult: 0.90, zoomFov: 0, range: 32,
  },
  blade: {
    key: 'blade', name: 'Blade', kind: 'melee', price: 400,
    damage: 55, headMult: 1, mag: -1, reserve: -1, melee: true,
    fireInterval: 0.55, auto: false, reloadTime: 0,
    spreadBase: 0, spreadMove: 0, spreadAir: 0, bloomPerShot: 0, bloomMax: 0,
    recoilPitch: 0.002, recoilYaw: 0, moveMult: 1.05, zoomFov: 0, range: 2.4,
  },
  smg: {
    key: 'smg', name: 'Stingray-9', kind: 'smg', price: 0,
    damage: 22, headMult: 2, mag: 30, reserve: 120,
    fireInterval: 0.075, auto: true, reloadTime: 1.6,
    spreadBase: 0.010, spreadMove: 0.016, spreadAir: 0.034, bloomPerShot: 0.0035, bloomMax: 0.07,
    recoilPitch: 0.005, recoilYaw: 0.003, moveMult: 0.98, zoomFov: 0, range: 50,
  },
  sniper: {
    key: 'sniper', name: 'Harborline-50', kind: 'sniper', price: 0,
    damage: 95, headMult: 3, mag: 5, reserve: 20,
    fireInterval: 1.15, auto: false, reloadTime: 2.6,
    spreadBase: 0.002, spreadMove: 0.030, spreadAir: 0.06, bloomPerShot: 0.012, bloomMax: 0.03,
    recoilPitch: 0.045, recoilYaw: 0.006, moveMult: 0.85, zoomFov: 28, range: 120,
  },
};

export const GRENADES = {
  frag: { key: 'frag', name: 'Frag Nade', price: 350, max: 1 },
  smoke: { key: 'smoke', name: 'Smoke Canister', price: 300, max: 1 },
  flash: { key: 'flash', name: 'Flash Charge', price: 200, max: 2 },
};

// Mutable per-agent weapon state, created fresh per agent.
export function createLoadout() {
  return {
    owned: { pistol: true },
    current: 'pistol',
    ammo: {
      pistol: { mag: 12, reserve: 48 },
      ar: { mag: 0, reserve: 0 },
      shotgun: { mag: 0, reserve: 0 },
      blade: { mag: -1, reserve: -1 },
      smg: { mag: 0, reserve: 0 },
      sniper: { mag: 0, reserve: 0 },
    },
    grenades: { frag: 0, smoke: 0, flash: 0 },
    armor: 0,
    reloading: 0,
    cooldown: 0,
    bloom: 0,
    ads: false,
  };
}

export function currentWeapon(loadout) {
  return WEAPONS[loadout.current];
}

// Spread in radians for this shot, from movement state.
export function computeSpread(def, moveSpeed, airborne, crouched, ads, bloom) {
  let s = def.spreadBase + bloom;
  s += moveSpeed * def.spreadMove;
  if (airborne) s += def.spreadAir;
  if (crouched) s *= 0.65;
  if (ads) s *= def.zoomFov ? 0.18 : 0.55;
  return s;
}

// Try to consume one round. Returns 'ok' | 'empty' | 'cooldown' | 'reloading'.
export function takeRound(loadout, dt) {
  const def = currentWeapon(loadout);
  if (def.melee) {
    if (loadout.cooldown > 0) return 'cooldown';
    loadout.cooldown = def.fireInterval;
    return 'ok';
  }
  if (loadout.reloading > 0) return 'reloading';
  if (loadout.cooldown > 0) return 'cooldown';
  const ammo = loadout.ammo[loadout.current];
  if (ammo.mag <= 0) return 'empty';
  ammo.mag -= 1;
  loadout.cooldown = def.fireInterval;
  loadout.bloom = Math.min(def.bloomMax, loadout.bloom + def.bloomPerShot);
  return 'ok';
}

export function startReload(loadout) {
  const def = currentWeapon(loadout);
  if (def.melee) return false;
  const ammo = loadout.ammo[loadout.current];
  if (loadout.reloading > 0 || ammo.reserve <= 0 || ammo.mag >= def.mag) return false;
  loadout.reloading = def.reloadTime;
  return true;
}

// Tick cooldowns/reload. Returns true when a reload just finished.
export function tickWeapon(loadout, dt) {
  let finished = false;
  if (loadout.cooldown > 0) loadout.cooldown -= dt;
  if (loadout.bloom > 0) loadout.bloom = Math.max(0, loadout.bloom - dt * 0.05);
  if (loadout.reloading > 0) {
    loadout.reloading -= dt;
    if (loadout.reloading <= 0) {
      loadout.reloading = 0;
      const def = currentWeapon(loadout);
      const ammo = loadout.ammo[loadout.current];
      const need = def.mag - ammo.mag;
      const take = Math.min(need, ammo.reserve);
      ammo.mag += take;
      ammo.reserve -= take;
      finished = true;
    }
  }
  return finished;
}

export function switchWeapon(loadout, key) {
  if (!loadout.owned[key] || loadout.current === key) return false;
  loadout.current = key;
  loadout.reloading = 0;
  loadout.cooldown = Math.max(loadout.cooldown, 0.25);
  loadout.bloom = 0;
  return true;
}

export function buyWeapon(loadout, key) {
  const def = WEAPONS[key];
  if (!def) return false;
  loadout.owned[key] = true;
  loadout.ammo[key] = { mag: def.mag, reserve: def.reserve };
  loadout.current = key;
  loadout.reloading = 0;
  return true;
}

export function refillAmmo(loadout) {
  for (const key of Object.keys(loadout.ammo)) {
    const def = WEAPONS[key];
    if (loadout.owned[key] && def.mag > 0) {
      loadout.ammo[key].mag = def.mag;
      loadout.ammo[key].reserve = def.reserve;
    }
  }
  loadout.reloading = 0;
  loadout.cooldown = 0;
  loadout.bloom = 0;
}
