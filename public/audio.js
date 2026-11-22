// Live sound for UNWRITTEN, borrowing earshot's forge approach: nothing is
// recorded. Every note, effect and ambience is synthesized on the spot from small
// recipes (modal resonators, contact noise, filtered noise, a computed room), and
// the music and soundscape of each zone come from the SOUND / MELODY lines Kimi
// writes for that zone.

const NOTE_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  pentatonic: [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10],
};
const LEADS = ['bell', 'pluck', 'glass', 'square', 'pad', 'flute'];
const AMBIENTS = ['wind', 'rain', 'bubbles', 'crickets', 'machines', 'fire', 'crowd', 'none'];
const ROOMS = { small: [0.5, 0.12], hall: [2.4, 0.3], cave: [3.6, 0.42], open: [1.1, 0.08] };

// Modal resonator partials: [frequency ratio, decay seconds, amplitude].
const BELL = [[1, 1.4, 1], [2.76, 0.7, 0.45], [5.4, 0.35, 0.22], [8.93, 0.18, 0.1]];
const GLASS = [[1, 0.9, 1], [2.32, 0.5, 0.5], [4.25, 0.25, 0.3], [6.63, 0.12, 0.15]];
const METAL = [[1, 0.6, 1], [1.59, 0.5, 0.7], [2.14, 0.4, 0.5], [2.83, 0.3, 0.4], [3.5, 0.2, 0.3]];

const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

export function parseNote(text) {
  const m = /^([A-G])([#b]?)(\d)$/.exec(String(text).trim());
  if (!m) return null;
  const index = NOTE_INDEX[m[1] + m[2]];
  return index === undefined ? null : 12 * (Number(m[3]) + 1) + index;
}

function hash(str) {
  let h = 2166136261;
  for (const c of String(str)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

// Turns what Kimi wrote for a zone into a playable spec, filling any gap from the zone name.
export function soundSpec(zone) {
  const r = seeded(hash(zone?.name ?? 'zone'));
  const pickFrom = (list) => list[Math.floor(r() * list.length)];
  const raw = zone?.sound ?? {};
  const bpm = Math.min(160, Math.max(70, Math.round(Number(raw.bpm)) || Math.round(85 + r() * 50)));
  const scale = SCALES[raw.scale] ? raw.scale : pickFrom(Object.keys(SCALES));
  const root = NOTE_INDEX[raw.root] !== undefined ? raw.root : pickFrom(['C', 'D', 'E', 'F', 'G', 'A']);
  const lead = LEADS.includes(raw.lead) ? raw.lead : pickFrom(LEADS);
  const ambient = AMBIENTS.includes(raw.ambient) ? raw.ambient : pickFrom(AMBIENTS);
  const room = ROOMS[raw.room] ? raw.room : pickFrom(Object.keys(ROOMS));
  let melody = String(zone?.melody ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16)
    .map((s) => (s === '-' ? null : parseNote(s)));
  const fromKimi = melody.filter((n) => n !== null).length >= 4;
  if (!fromKimi) {
    const steps = SCALES[scale];
    let degree = 0;
    melody = Array.from({ length: 16 }, (_, i) => {
      if (i % 2 === 1 && r() < 0.5) return null;
      degree = Math.max(-2, Math.min(9, degree + Math.floor(r() * 5) - 2));
      const oct = Math.floor(degree / steps.length);
      return 60 + NOTE_INDEX[root] + steps[((degree % steps.length) + steps.length) % steps.length] + 12 * oct;
    });
  }
  while (melody.length < 16) melody.push(null);
  return { bpm, scale, root, rootIndex: NOTE_INDEX[root], lead, ambient, room, melody, fromKimi };
}

export function describe(spec) {
  return `${spec.bpm} bpm · ${spec.root} ${spec.scale} · ${spec.lead} · ${spec.ambient === 'none' ? 'silence' : spec.ambient} · ${spec.room}`;
}

export function createAudio() {
  let ctx = null;
  let output;
  let master;
  let music;
  let sfxBus;
  let amb;
  let reverb;
  let send;
  let noiseBuffer;
  let spec = null;
  let step = 0;
  let nextTime = 0;
  let muted = false;
  let ambient = { nodes: [], type: 'none', nextAt: 0 };

  function start() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    master.connect(comp);
    comp.connect(ctx.destination);
    output = comp;
    send = ctx.createGain();
    send.gain.value = 0.1;
    reverb = ctx.createConvolver();
    reverb.buffer = room(1.1);
    send.connect(reverb);
    reverb.connect(master);
    music = bus(0.4);
    sfxBus = bus(0.75);
    amb = bus(0.3);
    noiseBuffer = makeNoise(2);
    nextTime = ctx.currentTime + 0.1;
    setInterval(schedule, 25);
  }

  function bus(level) {
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(master);
    g.connect(send);
    return g;
  }

  // A computed room: exponentially decaying stereo noise as the impulse response.
  function room(seconds) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6;
    }
    return buf;
  }

  function makeNoise(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function envelope(gain, t, attack, peak, decay) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function tone(type, freq, t, decay, dest, peak = 0.3, attack = 0.004, endFreq = 0) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + attack + decay * 0.8);
    const g = ctx.createGain();
    envelope(g, t, attack, peak, decay);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
    return o;
  }

  function noise(t, decay, dest, { type = 'bandpass', freq = 1000, q = 1, peak = 0.3, attack = 0.002, endFreq = 0 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + attack + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    envelope(g, t, attack, peak, decay);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + decay + 0.05);
  }

  // Modal resonator: a struck object as a handful of decaying partials, plus a contact click.
  function modal(freq, t, dest, partials, peak = 0.2) {
    for (const [ratio, decay, amp] of partials) {
      if (freq * ratio < 18000) tone('sine', freq * ratio, t, decay, dest, peak * amp, 0.002);
    }
    noise(t, 0.012, dest, { freq: Math.min(9000, freq * 3), q: 1.5, peak: peak * 0.25 });
  }

  function lead(kind, midi, t, len) {
    const f = midiToHz(midi);
    if (kind === 'bell') modal(f, t, music, BELL, 0.15);
    else if (kind === 'glass') modal(f * 2, t, music, GLASS, 0.1);
    else if (kind === 'pluck') {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(f * 8, t);
      flt.frequency.exponentialRampToValueAtTime(f * 1.3, t + 0.25);
      const g = ctx.createGain();
      envelope(g, t, 0.003, 0.17, 0.32);
      o.connect(flt);
      flt.connect(g);
      g.connect(music);
      o.start(t);
      o.stop(t + 0.4);
    } else if (kind === 'square') tone('square', f, t, len * 0.9, music, 0.06);
    else if (kind === 'pad') {
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = detune;
        const flt = ctx.createBiquadFilter();
        flt.type = 'lowpass';
        flt.frequency.value = f * 3;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.12);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len * 1.8);
        o.connect(flt);
        flt.connect(g);
        g.connect(music);
        o.start(t);
        o.stop(t + len * 1.9);
      }
    } else {
      // flute: sine with vibrato and a breath of noise
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      const depth = ctx.createGain();
      depth.gain.value = f * 0.006;
      lfo.connect(depth);
      depth.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.13, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len * 1.1);
      o.connect(g);
      g.connect(music);
      o.start(t);
      lfo.start(t);
      o.stop(t + len * 1.2);
      lfo.stop(t + len * 1.2);
      noise(t, len * 0.6, music, { freq: f * 2, q: 3, peak: 0.018, attack: 0.03 });
    }
  }

  const degreeSemitones = (scale, degree) => {
    const s = SCALES[scale];
    const oct = Math.floor(degree / s.length);
    return s[((degree % s.length) + s.length) % s.length] + 12 * oct;
  };

  function playStep(s, t) {
    const st = s % 16;
    const bar = Math.floor(s / 16) % 4;
    const stepDur = 60 / spec.bpm / 4;
    const chordDegree = [0, 5, 3, 4][bar];
    const bassRoot = 36 + spec.rootIndex + degreeSemitones(spec.scale, chordDegree);
    const fast = spec.bpm >= 120;

    // Drums: a kick from a pitched sine drop, a snare from noise and a tone, hats from bright noise.
    if (st === 0 || st === 8 || (fast && (st === 4 || st === 12))) tone('sine', 150, t, 0.32, music, 0.5, 0.002, 42);
    if (st === 4 || st === 12) {
      noise(t, 0.13, music, { freq: 1900, q: 0.8, peak: 0.14 });
      tone('triangle', 190, t, 0.07, music, 0.07);
    }
    if (st % 2 === 1) noise(t, 0.03, music, { type: 'highpass', freq: 7500, q: 0.5, peak: 0.045 });

    if (st % 4 === 0) tone('triangle', midiToHz(bassRoot + (st === 8 ? 7 : 0)), t, stepDur * 3.4, music, 0.2, 0.005);
    if (st === 0 && spec.lead !== 'pad') {
      for (const k of [0, 2, 4]) lead('pad', 48 + spec.rootIndex + degreeSemitones(spec.scale, chordDegree + k), t, stepDur * 10);
    }
    const note = spec.melody[st];
    if (note !== null && note !== undefined) lead(spec.lead, note, t, stepDur * 2);
  }

  function ambientEvent(t) {
    const r = Math.random;
    switch (ambient.type) {
      case 'rain':
        tone('sine', 2000 + r() * 2500, t, 0.03, amb, 0.035, 0.001);
        return 0.03 + r() * 0.09;
      case 'bubbles':
        tone('sine', 240 + r() * 120, t, 0.08, amb, 0.09, 0.005, 700 + r() * 500);
        return 0.12 + r() * 0.35;
      case 'crickets':
        for (let k = 0; k < 3; k++) tone('sine', 4400 + r() * 200, t + k * 0.045, 0.02, amb, 0.04, 0.003);
        return 0.5 + r() * 0.9;
      case 'machines':
        modal(280 + r() * 420, t, amb, METAL, 0.05);
        return 0.8 + r() * 1.7;
      case 'fire':
        noise(t, 0.006, amb, { freq: 1500 + r() * 2500, q: 2, peak: 0.12, attack: 0.001 });
        return 0.02 + r() * 0.12;
      case 'wind':
        noise(t, 1.6, amb, { type: 'bandpass', freq: 300 + r() * 300, q: 1.2, peak: 0.08, attack: 1, endFreq: 900 + r() * 500 });
        return 3 + r() * 4;
      case 'crowd':
        noise(t, 0.25, amb, { freq: 800 + r() * 700, q: 4, peak: 0.03, attack: 0.05 });
        return 0.3 + r() * 0.8;
      default:
        return 1;
    }
  }

  function bed(type, freq, q, level, lfoRate = 0, lfoDepth = 0) {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 1.2);
    src.connect(f);
    f.connect(g);
    g.connect(amb);
    src.start(t, Math.random());
    const nodes = [src];
    if (lfoRate) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = lfoRate;
      const depth = ctx.createGain();
      depth.gain.value = lfoDepth;
      lfo.connect(depth);
      depth.connect(f.frequency);
      lfo.start(t);
      nodes.push(lfo);
    }
    ambient.nodes.push({ gain: g, nodes });
  }

  function setAmbient(type) {
    const t = ctx.currentTime;
    for (const n of ambient.nodes) {
      n.gain.gain.setTargetAtTime(0.0001, t, 0.3);
      for (const node of n.nodes) node.stop(t + 1.6);
    }
    ambient = { nodes: [], type, nextAt: t + 0.5 };
    if (type === 'wind') bed('lowpass', 480, 0.7, 0.45, 0.11, 260);
    else if (type === 'rain') {
      bed('highpass', 1300, 0.5, 0.22);
      bed('lowpass', 650, 0.5, 0.14);
    } else if (type === 'bubbles') bed('lowpass', 260, 0.7, 0.22);
    else if (type === 'crickets') bed('lowpass', 320, 0.5, 0.05);
    else if (type === 'machines') {
      bed('bandpass', 120, 2, 0.32, 0.5, 30);
      bed('lowpass', 70, 1, 0.25);
    } else if (type === 'fire') bed('lowpass', 380, 0.6, 0.22);
    else if (type === 'crowd') {
      bed('bandpass', 600, 0.8, 0.28, 0.2, 200);
      bed('bandpass', 1400, 1.2, 0.08, 0.3, 300);
    }
  }

  function schedule() {
    if (!ctx) return;
    while (nextTime < ctx.currentTime + 0.15) {
      if (spec) playStep(step, nextTime);
      if (ambient.type !== 'none' && nextTime >= ambient.nextAt) ambient.nextAt = nextTime + ambientEvent(nextTime);
      nextTime += spec ? 60 / spec.bpm / 4 : 0.125;
      step++;
    }
  }

  function setZone(next) {
    if (!ctx || !next) return;
    const t = ctx.currentTime;
    // Short dip, then the new zone's music starts on a fresh bar.
    music.gain.setTargetAtTime(0.0001, t, 0.08);
    music.gain.setTargetAtTime(0.4, t + 0.35, 0.15);
    spec = next;
    step = 0;
    nextTime = t + 0.35;
    const [seconds, level] = ROOMS[next.room];
    reverb.buffer = room(seconds);
    send.gain.setTargetAtTime(level, t, 0.2);
    setAmbient(next.ambient);
    play('zone');
  }

  function play(name) {
    if (!ctx) return;
    const t = ctx.currentTime + 0.005;
    const root = spec ? spec.rootIndex : 0;
    const scale = spec ? spec.scale : 'major';
    switch (name) {
      case 'jump':
        tone('square', midiToHz(60 + root + 12), t, 0.1, sfxBus, 0.05, 0.002, midiToHz(60 + root + 24));
        noise(t, 0.08, sfxBus, { freq: 1600, q: 0.7, peak: 0.05, endFreq: 3200 });
        break;
      case 'land':
        noise(t, 0.05, sfxBus, { type: 'lowpass', freq: 520, q: 0.7, peak: 0.12 });
        break;
      case 'step':
        noise(t, 0.035, sfxBus, { type: 'bandpass', freq: 380 + Math.random() * 260, q: 1.2, peak: 0.035 });
        break;
      case 'impact':
        tone('sine', 120, t, 0.35, sfxBus, 0.35, 0.002, 38);
        noise(t, 0.3, sfxBus, { type: 'lowpass', freq: 700, q: 0.7, peak: 0.18, endFreq: 200 });
        break;
      case 'coin':
        modal(midiToHz(72 + root + degreeSemitones(scale, 4)), t, sfxBus, BELL, 0.1);
        modal(midiToHz(72 + root + degreeSemitones(scale, 7)), t + 0.07, sfxBus, BELL, 0.1);
        break;
      case 'stomp':
        tone('sine', 190, t, 0.16, sfxBus, 0.5, 0.002, 48);
        noise(t, 0.04, sfxBus, { type: 'lowpass', freq: 900, q: 0.7, peak: 0.22 });
        noise(t + 0.01, 0.09, sfxBus, { freq: 600, q: 3, peak: 0.1, endFreq: 300 });
        break;
      case 'hurt':
        tone('sawtooth', 440, t, 0.35, sfxBus, 0.12, 0.003, 110);
        tone('sawtooth', 452, t, 0.35, sfxBus, 0.08, 0.003, 104);
        noise(t, 0.2, sfxBus, { freq: 800, q: 0.8, peak: 0.25 });
        break;
      case 'zone':
        noise(t, 0.25, sfxBus, { freq: 300, q: 1.5, peak: 0.12, attack: 0.6, endFreq: 5000 });
        for (const k of [0, 2, 4]) modal(midiToHz(72 + root + degreeSemitones(scale, k)), t + 0.85 + k * 0.03, sfxBus, BELL, 0.07);
        break;
      case 'sign':
        modal(midiToHz(84 + root), t, sfxBus, GLASS, 0.05);
        break;
      case 'quest':
        // A rising bell arpeggio in the region's own scale.
        [0, 2, 4, 7, 9].forEach((k, i) => modal(midiToHz(72 + root + degreeSemitones(scale, k)), t + i * 0.09, sfxBus, BELL, 0.1));
        break;
      case 'sync':
        // A clap for lining up the separately captured audio with the video.
        tone('sine', 1000, t, 0.1, sfxBus, 0.5, 0.002);
        break;
      default:
        break;
    }
  }

  function toggleMute() {
    muted = !muted;
    if (ctx) master.gain.setTargetAtTime(muted ? 0 : 0.85, ctx.currentTime, 0.05);
    return muted;
  }

  // A MediaStream of exactly what the player hears, for recording demos.
  function capture() {
    start();
    if (!ctx) return null;
    const dest = ctx.createMediaStreamDestination();
    output.connect(dest);
    return dest.stream;
  }

  return { start, setZone, play, toggleMute, capture, get muted() { return muted; } };
}
