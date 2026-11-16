// HUD: every DOM read/write lives here, so the simulation never touches
// the document. One update per element per frame at most; killfeed and
// banners are small DOM lists rebuilt only when they change.
import { buyCatalog } from './economy.js';

function $(id) { return document.getElementById(id); }

export function createHud(cb) {
  const el = {
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    dmg: $('dmg'),
    flash: $('flashblind'),
    healthNum: $('health-num'),
    healthBar: $('health-bar'),
    armorNum: $('armor-num'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    money: $('money'),
    timer: $('timer'),
    scoreH: $('score-harbor'),
    scoreR: $('score-rust'),
    roundNum: $('round-num'),
    objective: $('objective'),
    bombStatus: $('bomb-status'),
    killfeed: $('killfeed'),
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerSub: $('banner-sub'),
    buy: $('buy'),
    buyItems: $('buy-items'),
    buyMoney: $('buy-money'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayCopy: $('overlay-copy'),
    playBtn: $('play'),
    matchend: $('matchend'),
    matchendTitle: $('matchend-title'),
    matchendSub: $('matchend-sub'),
    toast: $('toast'),
    plantbar: $('plantbar'),
    plantFill: $('plant-fill'),
    plantLabel: $('plant-label'),
    minimap: $('minimap'),
    sideInfo: $('side-info'),
    scoreboard: $('scoreboard'),
    scoreRows: $('score-rows'),
  };
  let toastT = null;
  let feed = [];
  const mm = el.minimap ? el.minimap.getContext('2d') : null;

  function setOverlay(kind, data = {}) {
    el.overlay.hidden = false;
    el.matchend.hidden = true;
    if (kind === 'start') {
      el.overlayTitle.textContent = 'NEON HARBOR';
      el.overlayCopy.textContent = 'Round-based tactical FPS on the BOATHOUSE map. Wardens vs Smugglers — plant the charge at Site A or B, or wipe the other crew. First to 5 rounds takes the harbor.';
      el.playBtn.textContent = 'Click to play';
    } else if (kind === 'paused') {
      el.overlayTitle.textContent = 'Paused';
      el.overlayCopy.textContent = 'Click to resume. Esc releases the mouse.';
      el.playBtn.textContent = 'Resume';
    } else if (kind === 'dead') {
      el.overlayTitle.textContent = 'You are down';
      el.overlayCopy.textContent = 'Your crew fights on. Spectate until the round ends.';
      el.playBtn.textContent = 'Spectate';
    }
    el.playBtn.style.display = '';
  }

  const api = {
    setHealth(hp, armor) {
      el.healthNum.textContent = Math.ceil(hp);
      el.healthBar.style.width = Math.max(0, hp) + '%';
      el.healthBar.style.background = hp <= 30 ? '#e5484d' : hp <= 60 ? '#f5a623' : '#38bdf8';
      el.armorNum.textContent = armor > 0 ? '◆ ' + Math.ceil(armor) : '';
    },
    setAmmo(mag, reserve, reloading) {
      el.ammoMag.textContent = reloading ? '--' : mag;
      el.ammoReserve.textContent = '/ ' + reserve;
    },
    setMoney(m) { el.money.textContent = '$' + m; },
    setTimer(sec, phase) {
      const s = Math.max(0, Math.ceil(sec));
      el.timer.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      el.timer.style.color = phase === 'live' && s <= 10 ? '#e5484d' : '';
    },
    setScore(h, r, round) {
      el.scoreH.textContent = h;
      el.scoreR.textContent = r;
      el.roundNum.textContent = 'ROUND ' + round + ' / 9';
    },
    // Attack/defense + players alive, shown under the timer.
    setSideInfo(text) { if (el.sideInfo) el.sideInfo.textContent = text; },
    // Top-down minimap: walls, sites, player arrow, allies, visible enemies.
    // d: {walls, sites, player{x,z,yaw}, allies[{x,z}], enemies[{x,z}]}.
    drawMinimap(d) {
      if (!mm) return;
      const W = el.minimap.width;
      const H = el.minimap.height;
      const sx = (x) => (x + 32) / 64 * W;
      const sz = (z) => (z + 22) / 44 * H;
      mm.clearRect(0, 0, W, H);
      mm.fillStyle = 'rgba(10,16,26,0.85)';
      mm.fillRect(0, 0, W, H);
      mm.fillStyle = '#8a7a66';
      for (const c of d.walls) mm.fillRect(sx(c.x0), sz(c.z0), Math.max(1, sx(c.x1) - sx(c.x0)), Math.max(1, sz(c.z1) - sz(c.z0)));
      for (const s of d.sites) {
        mm.beginPath();
        mm.arc(sx(s.x), sz(s.z), 4, 0, Math.PI * 2);
        mm.fillStyle = s.id === 'A' ? '#22d3ee' : '#f59e0b';
        mm.fill();
        mm.fillStyle = '#e9e6df';
        mm.font = 'bold 8px system-ui, sans-serif';
        mm.textAlign = 'center';
        mm.fillText(s.id, sx(s.x), sz(s.z) - 6);
      }
      for (const a of d.allies) {
        mm.beginPath();
        mm.arc(sx(a.x), sz(a.z), 2.5, 0, Math.PI * 2);
        mm.fillStyle = '#2dd4bf';
        mm.fill();
      }
      for (const e of d.enemies) {
        mm.beginPath();
        mm.arc(sx(e.x), sz(e.z), 2.5, 0, Math.PI * 2);
        mm.fillStyle = '#e5484d';
        mm.fill();
      }
      // Player arrow (yaw 0 faces -z, i.e. up the map).
      const px = sx(d.player.x);
      const pz = sz(d.player.z);
      const a = Math.atan2(-Math.sin(d.player.yaw), -Math.cos(d.player.yaw));
      mm.save();
      mm.translate(px, pz);
      mm.rotate(Math.atan2(Math.sin(a), -Math.cos(a)) + Math.PI / 2);
      mm.fillStyle = '#ffffff';
      mm.beginPath();
      mm.moveTo(0, -5); mm.lineTo(3.5, 4); mm.lineTo(-3.5, 4); mm.closePath();
      mm.fill();
      mm.restore();
    },
    // Tab scoreboard: one row per agent (bots are bots, not fake players).
    showScoreboard(rows) {
      if (!el.scoreboard) return;
      el.scoreRows.innerHTML = rows.map((r) =>
        `<tr><td style="color:${r.team === 'harbor' ? '#2dd4bf' : '#f07f2e'}">${r.name}</td>` +
        `<td>${r.kills}</td><td>${r.deaths}</td><td>${r.money !== null ? '$' + r.money : '—'}</td></tr>`).join('');
      el.scoreboard.hidden = false;
    },
    hideScoreboard() { if (el.scoreboard) el.scoreboard.hidden = true; },
    setObjective(text) { el.objective.textContent = text; },
    setBombStatus(text, urgent) {
      el.bombStatus.textContent = text;
      el.bombStatus.style.color = urgent ? '#e5484d' : '';
    },
    setCrosshairGap(px) {
      el.crosshair.style.setProperty('--gap', px + 'px');
    },
    hitmarker(kill) {
      el.hitmarker.classList.add('on');
      el.hitmarker.style.color = kill ? '#e5484d' : '';
      setTimeout(() => el.hitmarker.classList.remove('on'), 90);
    },
    damageFlash() {
      el.dmg.style.opacity = '0.55';
      setTimeout(() => { el.dmg.style.opacity = '0'; }, 140);
    },
    flashBlind(strength) {
      el.flash.style.opacity = String(strength);
      setTimeout(() => { el.flash.style.opacity = '0'; }, 2600);
    },
    killfeedAdd(text, good) {
      feed.unshift({ text, good, t: Date.now() });
      feed = feed.slice(0, 4);
      el.killfeed.innerHTML = feed.map((f) =>
        `<div style="color:${f.good ? '#7ee2a8' : '#f0a0a0'}">${f.text}</div>`).join('');
    },
    showBanner(title, sub, good) {
      el.bannerTitle.textContent = title;
      el.bannerSub.textContent = sub || '';
      el.bannerTitle.style.color = good === false ? '#e5484d' : good === true ? '#7ee2a8' : '';
      el.banner.hidden = false;
      clearTimeout(api._bannerT);
      api._bannerT = setTimeout(() => { el.banner.hidden = true; }, 4200);
    },
    hideBanner() { el.banner.hidden = true; },
    toast(msg) {
      el.toast.textContent = msg;
      el.toast.style.opacity = '1';
      clearTimeout(toastT);
      toastT = setTimeout(() => { el.toast.style.opacity = '0'; }, 1800);
    },
    showPlant(label, frac) {
      el.plantbar.hidden = false;
      el.plantLabel.textContent = label;
      el.plantFill.style.width = Math.round(frac * 100) + '%';
    },
    hidePlant() { el.plantbar.hidden = true; },
    showBuy(money) {
      el.buy.hidden = false;
      el.buyMoney.textContent = '$' + money;
      el.buyItems.innerHTML = buyCatalog().map((item, i) =>
        `<button class="buy-item" data-id="${item.id}">
          <b>[${i + 1}] ${item.name}</b><span>${item.desc}</span><i>$${item.price}</i>
        </button>`).join('');
      el.buyItems.querySelectorAll('.buy-item').forEach((b) => {
        b.addEventListener('click', () => cb.onBuy(b.dataset.id));
      });
    },
    refreshBuyMoney(money) { el.buyMoney.textContent = '$' + money; },
    hideBuy() { el.buy.hidden = true; },
    isBuyOpen() { return !el.buy.hidden; },
    showOverlay: setOverlay,
    hideOverlay() { el.overlay.hidden = true; },
    showMatchEnd(title, sub) {
      el.matchend.hidden = false;
      el.overlay.hidden = true;
      el.matchendTitle.textContent = title;
      el.matchendSub.textContent = sub;
    },
    onPlay(fn) { el.playBtn.addEventListener('click', fn); },
    setMuted(m) { const b = $('mute'); if (b) b.textContent = m ? '🔇 Muted' : '🔊 Sound'; },
  };

  const muteBtn = $('mute');
  if (muteBtn) muteBtn.addEventListener('click', () => cb.onMute());
  const buyClose = $('buy-close');
  if (buyClose) buyClose.addEventListener('click', () => api.hideBuy());
  return api;
}
