// Round economy: money earned per round and spent in the buy menu.
// Rewards follow the CS shape (win > loss, loss streaks pay more, kills and
// the objective pay) so saving vs force-buying is a real decision.
import { WEAPONS, GRENADES, buyWeapon } from './weapons.js';

export const START_MONEY = 800;
export const WIN_REWARD = 3250;
export const LOSS_REWARD = 1900;
export const LOSS_STREAK_BONUS = 500; // per consecutive loss, capped at +1000
export const KILL_REWARD = 300;
export const PLANT_REWARD = 300;
export const DEFUSE_REWARD = 300;
export const ARMOR_PRICE = 650;

export function roundReward(won, lossStreak) {
  if (won) return WIN_REWARD;
  return LOSS_REWARD + Math.min(2, lossStreak) * LOSS_STREAK_BONUS;
}

// Buy catalogue for the HUD menu: one entry per purchasable thing.
export function buyCatalog() {
  const items = [];
  for (const key of ['ar', 'shotgun', 'blade']) {
    const w = WEAPONS[key];
    const desc = w.melee
      ? `${w.damage} dmg · melee · no ammo`
      : w.pellets ? `${w.damage}x${w.pellets} pellets · ${w.mag} shells · ${w.auto ? 'auto' : 'pump'}`
        : `${w.damage} dmg · ${w.mag} rounds · ${w.auto ? 'auto' : 'semi'}`;
    items.push({ id: key, kind: 'weapon', name: w.name, desc, price: w.price });
  }
  items.push({ id: 'armor', kind: 'armor', name: 'Kevlar Vest', desc: 'Absorbs 30% of damage taken', price: ARMOR_PRICE });
  items.push({ id: 'frag', kind: 'grenade', name: GRENADES.frag.name, desc: 'Explodes — heavy damage up close', price: GRENADES.frag.price });
  items.push({ id: 'smoke', kind: 'grenade', name: GRENADES.smoke.name, desc: 'Blocks sight for 14s', price: GRENADES.smoke.price });
  items.push({ id: 'flash', kind: 'grenade', name: GRENADES.flash.name, desc: 'Blinds anyone looking at it', price: GRENADES.flash.price });
  return items;
}

// Attempt a purchase for the player. Returns 'ok' | 'poor' | 'owned' | 'full'.
export function tryBuy(player, itemId) {
  const loadout = player.loadout;
  if (itemId === 'armor') {
    if (loadout.armor >= 100) return 'full';
    if (player.money < ARMOR_PRICE) return 'poor';
    player.money -= ARMOR_PRICE;
    loadout.armor = 100;
    return 'ok';
  }
  if (itemId === 'frag' || itemId === 'smoke' || itemId === 'flash') {
    const g = GRENADES[itemId];
    if (loadout.grenades[itemId] >= g.max) return 'full';
    if (player.money < g.price) return 'poor';
    player.money -= g.price;
    loadout.grenades[itemId] += 1;
    return 'ok';
  }
  const w = WEAPONS[itemId];
  if (!w) return 'owned';
  if (loadout.owned[itemId]) return 'owned';
  if (player.money < w.price) return 'poor';
  player.money -= w.price;
  buyWeapon(loadout, itemId);
  return 'ok';
}
