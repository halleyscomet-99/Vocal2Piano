// In-browser song analysis: tempo + beat grid, bar-level chords, and key.
// Good enough for songs with a steady beat and clear harmony (EDM, pop).
// A Python pipeline with source separation (software/) can replace it later.

import type { ChordChart } from "./arranger";

const SR = 22050;
const ONSET_N = 1024; // short frames → precise beat timing
const HOP = 256;
const CHROMA_N = 4096; // long frames → fine pitch resolution
const CHROMA_HOP = 2048;
const PC_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export interface AudioAnalysis {
  name: string;
  duration: number;
  bpm: number;
  offset: number; // s, first downbeat
  key: string; // e.g. "A minor"
  tonic: number; // pitch class
  chart: ChordChart;
  buffer: AudioBuffer; // original audio, for A/B listening
}

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const hann = (n: number) => new Float32Array(n).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));

const tick = () => new Promise((r) => setTimeout(r, 0));

export async function analyzeAudio(file: File, onProgress: (stage: string, k: number) => void): Promise<AudioAnalysis> {
  onProgress("Decoding", 0);
  const raw = await file.arrayBuffer();
  const ctx = new AudioContext();
  const buffer = await ctx.decodeAudioData(raw);
  void ctx.close();

  // Mono, 22.05 kHz
  const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const x = (await off.startRendering()).getChannelData(0);
  const result = await analyzeSamples(x, file.name.replace(/\.[^.]+$/, ""), onProgress);
  return { ...result, duration: buffer.duration, buffer };
}

/** Core analysis on mono samples at 22.05 kHz. */
export async function analyzeSamples(
  x: Float32Array,
  name: string,
  onProgress: (stage: string, k: number) => void = () => {},
): Promise<Omit<AudioAnalysis, "buffer" | "duration">> {

  // Pass 1: spectral flux for onsets.
  const fluxTop = Math.floor(5000 / (SR / ONSET_N));
  const frames = Math.max(0, Math.floor((x.length - ONSET_N) / HOP));
  if (frames < 1000) throw new Error("This clip is too short to analyse");
  const flux = new Float32Array(frames);
  const lowFlux = new Float32Array(frames); // < 200 Hz: kick and bass mark the beat
  const lowTop = Math.ceil(200 / (SR / ONSET_N));
  {
    const win = hann(ONSET_N);
    const re = new Float32Array(ONSET_N);
    const im = new Float32Array(ONSET_N);
    let prev = new Float32Array(fluxTop);
    for (let f = 0; f < frames; f++) {
      const o = f * HOP;
      for (let i = 0; i < ONSET_N; i++) {
        re[i] = x[o + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      const mag = new Float32Array(fluxTop);
      let fl = 0;
      let lo = 0;
      for (let k = 1; k < fluxTop; k++) {
        mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
        const d = Math.max(0, mag[k] - prev[k]);
        fl += d;
        if (k < lowTop) lo += d;
      }
      flux[f] = fl;
      lowFlux[f] = lo;
      prev = mag;
      if (f % 2000 === 0) {
        onProgress("Listening", (0.5 * f) / frames);
        await tick();
      }
    }
  }

  // Pass 2: chroma (all pitches) and bass chroma (< 260 Hz).
  const binHz = SR / CHROMA_N;
  const pcOf = new Int8Array(CHROMA_N / 2).fill(-1);
  for (let k = 1; k < CHROMA_N / 2; k++) {
    const f = k * binHz;
    if (f >= 50 && f <= 2100) pcOf[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
  }
  const bassTop = Math.floor(260 / binHz);
  const chroma: Float32Array[] = [];
  const bass: Float32Array[] = [];
  {
    const win = hann(CHROMA_N);
    const mag = new Float32Array(CHROMA_N / 2);
    const re = new Float32Array(CHROMA_N);
    const im = new Float32Array(CHROMA_N);
    const cframes = Math.floor((x.length - CHROMA_N) / CHROMA_HOP);
    for (let f = 0; f < cframes; f++) {
      const o = f * CHROMA_HOP;
      for (let i = 0; i < CHROMA_N; i++) {
        re[i] = x[o + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      const c = new Float32Array(12);
      const b = new Float32Array(12);
      for (let k = 0; k < CHROMA_N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
      // Only spectral peaks count, so broadband drums don't smear every pitch class.
      for (let k = 1; k < CHROMA_N / 2 - 1; k++) {
        const pc = pcOf[k];
        if (pc < 0 || mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;
        c[pc] += mag[k];
        if (k < bassTop) b[pc] += mag[k];
      }
      chroma.push(c);
      bass.push(b);
      if (f % 200 === 0) {
        onProgress("Listening", 0.5 + (0.5 * f) / cframes);
        await tick();
      }
    }
  }
  const chromaAt = (onsetFrame: number) => Math.min(chroma.length - 1, Math.round((onsetFrame * HOP) / CHROMA_HOP));

  // Onset envelope: flux minus local mean, half-wave rectified.
  onProgress("Finding the beat", 1);
  await tick();
  const onsetEnv = (v: Float32Array) => {
    const out = new Float32Array(frames);
    const W = 16;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      let n = 0;
      for (let j = Math.max(0, i - W); j < Math.min(frames, i + W); j++, n++) s += v[j];
      out[i] = Math.max(0, v[i] - s / n);
      peak = Math.max(peak, out[i]);
    }
    return out.map((e) => e / (peak || 1));
  };
  const env = onsetEnv(flux);
  const lowEnv = onsetEnv(lowFlux);

  // Tempo: autocorrelation, weighted toward ~120 bpm.
  const fps = SR / HOP;
  const lagOf = (bpm: number) => (60 * fps) / bpm;
  let bestLag = lagOf(120);
  let bestScore = -Infinity;
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += env[i] * env[i + lag];
    return s / (frames - lag);
  };
  for (let lag = Math.floor(lagOf(190)); lag <= Math.ceil(lagOf(65)); lag++) {
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const s = ac(lag) * w;
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  const [a0, a1, a2] = [ac(bestLag - 1), ac(bestLag), ac(bestLag + 1)];
  const den = a0 - 2 * a1 + a2;
  const period = bestLag + (den !== 0 ? (0.5 * (a0 - a2)) / den : 0);
  const bpm = (60 * fps) / period;

  // Beat phase
  let phase = 0;
  bestScore = -Infinity;
  for (let p = 0; p < period; p++) {
    let s = 0;
    for (let t = p; t < frames; t += period) s += (env[Math.round(t)] ?? 0) + 2 * (lowEnv[Math.round(t)] ?? 0);
    if (s > bestScore) {
      bestScore = s;
      phase = p;
    }
  }
  const beats: number[] = [];
  for (let t = phase; t < frames; t += period) beats.push(t);

  // Beat-synchronous chroma
  const beatChroma = beats.map((b0, i) => {
    const b1 = beats[i + 1] ?? Math.min(frames, b0 + period);
    const c = new Float32Array(12);
    const bs = new Float32Array(12);
    const end = Math.max(chromaAt(b0) + 1, chromaAt(b1));
    for (let f = chromaAt(b0); f < end; f++) {
      for (let k = 0; k < 12; k++) {
        c[k] += chroma[f][k];
        bs[k] += bass[f][k];
      }
    }
    return { c, bs };
  });
  const norm = (v: Float32Array) => {
    const m = Math.hypot(...v) || 1;
    return v.map((e) => e / m);
  };

  // Downbeat: the bar phase where harmony changes most and onsets are strongest.
  const change = beatChroma.map((b, i) => {
    if (i === 0) return 0;
    const p = norm(beatChroma[i - 1].c);
    const q = norm(b.c);
    return 1 - p.reduce((s, e, k) => s + e * q[k], 0);
  });
  let down = 0;
  bestScore = -Infinity;
  for (let d = 0; d < 4; d++) {
    let s = 0;
    for (let i = d; i < beats.length; i += 4) s += change[i] * 4 + (env[Math.round(beats[i])] ?? 0);
    if (s > bestScore) {
      bestScore = s;
      down = d;
    }
  }

  // Chord per bar: major/minor triad templates + bass-root bonus.
  onProgress("Reading chords", 1);
  await tick();
  const templates: { name: string; root: number; v: Float32Array }[] = [];
  for (let r = 0; r < 12; r++) {
    for (const [suffix, third] of [["", 4], ["m", 3]] as const) {
      const v = new Float32Array(12);
      v[r] = 1;
      v[(r + third) % 12] = 0.85;
      v[(r + 7) % 12] = 0.8;
      templates.push({ name: PC_NAMES[r] + suffix, root: r, v: norm(v) });
    }
  }
  const total = new Float32Array(12);
  const loudness: number[] = [];
  const chords: string[] = [];
  for (let i = down; i + 3 < beatChroma.length; i += 4) {
    const c = new Float32Array(12);
    const bs = new Float32Array(12);
    for (let j = i; j < i + 4; j++) {
      for (let k = 0; k < 12; k++) {
        c[k] += beatChroma[j].c[k];
        bs[k] += beatChroma[j].bs[k];
      }
    }
    for (let k = 0; k < 12; k++) total[k] += c[k];
    loudness.push(c.reduce((s, e) => s + e, 0));
    // Remove the flat noise floor before matching.
    const floor = Math.min(...c);
    const cn = norm(c.map((e) => e - floor));
    const bn = norm(bs);
    let best = templates[0];
    let score = -Infinity;
    for (const t of templates) {
      const s = t.v.reduce((acc, e, k) => acc + e * cn[k], 0) + 0.25 * bn[t.root];
      if (s > score) {
        score = s;
        best = t;
      }
    }
    chords.push(best.name);
  }
  // Very quiet bars (intros, breakdowns) get no chord.
  const loudMax = Math.max(...loudness);
  loudness.forEach((l, i) => {
    if (l < loudMax * 0.12) chords[i] = "N";
  });
  // Smooth one-bar blips: A B A → A A A.
  for (let i = 1; i + 1 < chords.length; i++) {
    if (chords[i - 1] === chords[i + 1] && chords[i] !== chords[i - 1] && chords[i] !== "N") chords[i] = chords[i - 1];
  }

  // Key: Krumhansl–Schmuckler.
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (a: number[], b: Float32Array) => {
    const ma = a.reduce((s, e) => s + e, 0) / 12;
    const mb = b.reduce((s, e) => s + e, 0) / 12;
    let n = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < 12; i++) {
      n += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return n / Math.sqrt(da * db || 1);
  };
  let tonic = 0;
  let minor = false;
  bestScore = -Infinity;
  for (let r = 0; r < 12; r++) {
    for (const [prof, isMinor] of [[MAJ, false], [MIN, true]] as const) {
      const rot = prof.map((_, i) => prof[(i - r + 12) % 12]);
      const s = corr(rot, total);
      if (s > bestScore) {
        bestScore = s;
        tonic = r;
        minor = isMinor;
      }
    }
  }

  const offset = (beats[down] * HOP) / SR;
  const last = [...chords].reverse().find((c) => c !== "N");
  return {
    name,
    bpm: Math.round(bpm * 10) / 10,
    offset,
    key: `${PC_NAMES[tonic]} ${minor ? "minor" : "major"}`,
    tonic,
    chart: {
      name,
      bpm,
      chords,
      offset,
      scaleRoot: minor ? (tonic + 3) % 12 : tonic,
      ending: last,
    },
  };
}
