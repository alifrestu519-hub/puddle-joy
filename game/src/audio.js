// Every sound is synthesised with WebAudio: no audio files, no network.
// The context is created on the first user gesture; until then every call
// is a no-op, so the title screen and the screenshot scenes stay silent.
export function createAudio() {
  let ctx = null;
  let master = null;
  let musicGain = null;
  let muted = false;
  let musicTimer = null;
  let musicStep = 0;

  /** A tiny pentatonic lantern theme, one quiet note per beat. */
  const MELODY = [392, 0, 494, 587, 0, 494, 392, 330, 0, 392, 440, 494, 0, 587, 659, 0];
  const BASS = [131, 0, 0, 165, 0, 0, 196, 0, 0, 0, 165, 0, 147, 0, 0, 0];

  function ensure() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
      musicGain = ctx.createGain();
      musicGain.gain.value = 0.12;
      musicGain.connect(master);
    } catch {
      return false;
    }
    return true;
  }

  function tone(freq, dur, type, vol, when = 0, slideTo = 0) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(dur, vol, freq) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.value = vol;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(t);
  }

  function scheduleMusic() {
    if (!ctx || muted) return;
    const beat = 0.34;
    const note = MELODY[musicStep % MELODY.length];
    const bass = BASS[musicStep % BASS.length];
    if (note) tone(note, beat * 0.9, 'sine', 0.16);
    if (bass) tone(bass, beat * 1.6, 'triangle', 0.2);
    musicStep += 1;
    musicTimer = window.setTimeout(scheduleMusic, beat * 1000);
  }

  return {
    /** Call from any user gesture: unlocks sound and starts the theme. */
    unlock() {
      if (!ensure()) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (!musicTimer) scheduleMusic();
    },
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.5;
      if (muted && musicTimer) {
        window.clearTimeout(musicTimer);
        musicTimer = null;
      } else if (!muted && ctx && !musicTimer) {
        scheduleMusic();
      }
      return muted;
    },
    isMuted() {
      return muted;
    },
    shoot() {
      tone(760, 0.09, 'square', 0.1, 0, 320);
    },
    burst() {
      tone(520, 0.12, 'square', 0.14, 0, 180);
      noise(0.08, 0.1, 2400);
    },
    hit() {
      tone(240, 0.06, 'triangle', 0.12, 0, 140);
    },
    kill() {
      tone(520, 0.14, 'sawtooth', 0.1, 0, 90);
      noise(0.12, 0.12, 1200);
    },
    hurt() {
      tone(180, 0.28, 'sawtooth', 0.2, 0, 55);
    },
    pickup() {
      tone(980, 0.07, 'sine', 0.12);
      tone(1318, 0.09, 'sine', 0.1, 0.05);
    },
    levelUp() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.14, i * 0.07));
    },
    dash() {
      noise(0.16, 0.14, 3200);
    },
    wave() {
      tone(392, 0.16, 'triangle', 0.14);
      tone(587, 0.24, 'triangle', 0.14, 0.12);
    },
    boss() {
      tone(98, 0.7, 'sawtooth', 0.22, 0, 49);
      tone(147, 0.5, 'sawtooth', 0.14, 0.1, 73);
    },
    victory() {
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.3, 'triangle', 0.15, i * 0.11));
    },
    defeat() {
      [392, 330, 262, 196].forEach((f, i) => tone(f, 0.4, 'sawtooth', 0.12, i * 0.16));
    },
  };
}
