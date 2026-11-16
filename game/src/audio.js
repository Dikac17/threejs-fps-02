// Procedural sound: every effect is synthesised with Web Audio (oscillator +
// filtered noise). No audio files, no network. Created lazily on the first
// user gesture, as browsers require; muted state persists for the session.
export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let noiseBuf = null;

  function ensure() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
      const len = Math.floor(ctx.sampleRate * 1);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      return false;
    }
    return true;
  }

  function noise(dur, filterType, freq, gainVal, when = 0) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  function tone(type, f0, f1, dur, gainVal, when = 0) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  return {
    unlock() { if (ensure() && ctx.state === 'suspended') ctx.resume(); },
    setMuted(m) {
      muted = m;
      if (master) master.gain.value = m ? 0 : 0.5;
    },
    isMuted() { return muted; },
    shot(kind) {
      if (!ensure()) return;
      if (kind === 'sniper') { noise(0.35, 'lowpass', 900, 0.9); tone('sine', 160, 40, 0.3, 0.7); }
      else if (kind === 'rifle') { noise(0.14, 'lowpass', 1600, 0.7); tone('square', 220, 70, 0.09, 0.25); }
      else if (kind === 'shotgun') { noise(0.3, 'lowpass', 1100, 1.0); tone('sine', 130, 35, 0.28, 0.8); noise(0.12, 'highpass', 2500, 0.3); }
      else if (kind === 'smg') { noise(0.09, 'bandpass', 2200, 0.55); tone('square', 300, 90, 0.06, 0.18); }
      else { noise(0.12, 'lowpass', 1400, 0.6); tone('square', 190, 60, 0.08, 0.22); }
    },
    melee() { noise(0.16, 'bandpass', 900, 0.4); tone('sine', 300, 120, 0.12, 0.2); },
    impact() { noise(0.05, 'highpass', 1800, 0.25); tone('square', 500, 300, 0.04, 0.12); },
    // Harbour ambience: soft waves + the odd gull. Started once after the
    // first gesture; quiet by design, never over the gunfire.
    ambientStart() {
      if (!ensure() || this._amb) return;
      this._amb = true;
      const wave = () => {
        if (muted) return;
        noise(2.2, 'lowpass', 320, 0.05);
      };
      const gull = () => {
        if (!muted) {
          const f = 1400 + Math.random() * 500;
          tone('sine', f, f * 0.7, 0.35, 0.05);
          tone('sine', f * 1.1, f * 0.8, 0.3, 0.04, 0.4);
        }
        setTimeout(gull, 7000 + Math.random() * 9000);
      };
      wave();
      setInterval(wave, 5000);
      setTimeout(gull, 4000);
    },
    distantShot() { noise(0.12, 'lowpass', 700, 0.16); },
    dry() { tone('square', 1400, 1200, 0.03, 0.12); },
    reload() { tone('square', 900, 700, 0.03, 0.15); tone('square', 700, 900, 0.03, 0.15, 0.18); tone('square', 1100, 800, 0.04, 0.18, 0.42); },
    step(run) { noise(0.06, 'lowpass', 500, run ? 0.10 : 0.06); },
    hit() { tone('sine', 1800, 1800, 0.05, 0.25); },
    kill() { tone('sine', 660, 660, 0.07, 0.25); tone('sine', 990, 990, 0.09, 0.25, 0.07); },
    hurt() { tone('sawtooth', 140, 70, 0.18, 0.3); },
    plantBeep(n) { tone('sine', 880 + n * 60, 880 + n * 60, 0.06, 0.3); },
    plantStart() { tone('sine', 520, 520, 0.1, 0.25); tone('sine', 780, 780, 0.1, 0.25, 0.12); },
    defuseStart() { tone('sine', 440, 440, 0.1, 0.25); tone('sine', 660, 660, 0.1, 0.25, 0.12); },
    explosion() { noise(1.4, 'lowpass', 400, 1.0); tone('sine', 120, 28, 1.2, 0.9); noise(0.5, 'highpass', 3000, 0.25); },
    flash() { tone('sine', 2400, 2400, 0.4, 0.2); noise(0.3, 'highpass', 4000, 0.2); },
    smoke() { noise(0.6, 'lowpass', 600, 0.3); },
    roundWin() { [523, 659, 784].forEach((f, i) => tone('triangle', f, f, 0.22, 0.3, i * 0.13)); },
    roundLose() { [392, 330, 262].forEach((f, i) => tone('triangle', f, f, 0.25, 0.28, i * 0.15)); },
    buy() { tone('sine', 880, 880, 0.05, 0.2); tone('sine', 1320, 1320, 0.06, 0.2, 0.06); },
    denied() { tone('square', 220, 180, 0.12, 0.2); },
    click() { tone('sine', 1200, 1200, 0.03, 0.15); },
  };
}
