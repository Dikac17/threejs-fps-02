// Round + match state machine. One match is first-to-5 rounds (max 9):
// rounds 1-4 Wardens attack, 5-8 Smugglers attack, 9 Wardens attack again.
// A round ends by elimination, bomb explosion, defuse, or timeout
// (defenders win a timeout with no plant). This module owns the clock and
// the bomb; main.js owns the agents and the rendering.
import { roundReward } from './economy.js';
import { SITES } from './map.js';

export const BUY_TIME = 15;
export const ROUND_TIME = 100;
export const BOMB_TIME = 35;
export const PLANT_TIME = 3;
export const DEFUSE_TIME = 5;
export const END_TIME = 5;
export const WIN_ROUNDS = 5;
export const MAX_ROUNDS = 9;

export function createMatch() {
  return {
    phase: 'buy',
    round: 1,
    wins: { harbor: 0, rust: 0 },
    lossStreak: { harbor: 0, rust: 0 },
    roundTime: BUY_TIME,
    attackTeam: 'harbor',
    time: 0,
    bomb: { state: 'carried', carrier: null, site: null, x: 0, z: 0, timer: 0 },
    roundWinner: null,
    roundReason: '',
    matchWinner: null,
    endT: 0,
  };
}

export function attackTeamForRound(round) {
  if (round <= 4) return 'harbor';
  if (round <= 8) return 'rust';
  return 'harbor';
}

export function startRound(m, round) {
  m.round = round;
  m.phase = 'buy';
  m.roundTime = BUY_TIME;
  m.attackTeam = attackTeamForRound(round);
  m.bomb = { state: 'carried', carrier: null, site: null, x: 0, z: 0, timer: 0 };
  m.roundWinner = null;
  m.roundReason = '';
  m.endT = 0;
}

// Returns an event string when the round ends, else null.
export function tickMatch(m, dt, aliveCount) {
  m.time += dt;
  if (m.phase === 'buy') {
    m.roundTime -= dt;
    if (m.roundTime <= 0) { m.phase = 'live'; m.roundTime = ROUND_TIME; return 'live'; }
    return null;
  }
  if (m.phase === 'live') {
    m.roundTime -= dt;
    if (m.bomb.state === 'planted') {
      m.bomb.timer -= dt;
      if (m.bomb.timer <= 0) return 'bomb';
    }
    if (aliveCount.harbor === 0) return 'elim-rust';
    if (aliveCount.rust === 0) return 'elim-harbor';
    if (m.roundTime <= 0) return 'timeout';
    return null;
  }
  if (m.phase === 'end') {
    m.endT -= dt;
    if (m.endT <= 0) return 'next';
    return null;
  }
  return null;
}

// Close a round: pay rewards, count the win, decide match end.
export function endRound(m, winner, reason) {
  m.phase = 'end';
  m.endT = END_TIME;
  m.roundWinner = winner;
  m.roundReason = reason;
  m.wins[winner]++;
  const loser = winner === 'harbor' ? 'rust' : 'harbor';
  m.lossStreak[winner] = 0;
  m.lossStreak[loser]++;
  if (m.wins[winner] >= WIN_ROUNDS || m.round >= MAX_ROUNDS) {
    m.matchWinner = m.wins.harbor > m.wins.rust ? 'harbor'
      : m.wins.rust > m.wins.harbor ? 'rust' : 'draw';
  }
  return {
    winner, reason,
    harborReward: roundReward(winner === 'harbor', m.lossStreak.harbor),
    rustReward: roundReward(winner === 'rust', m.lossStreak.rust),
    matchOver: !!m.matchWinner,
  };
}

export function plantBomb(m, siteId) {
  const site = SITES[siteId];
  m.bomb = { state: 'planted', carrier: null, site: siteId, x: site.x, z: site.z, timer: BOMB_TIME };
}

export function dropBomb(m, x, z) {
  m.bomb = { state: 'dropped', carrier: null, site: null, x, z, timer: 0 };
}
