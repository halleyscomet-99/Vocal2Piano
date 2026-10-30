// Hum → accompaniment: transcribe a hummed melody (sung against a click), find its key,
// and choose a chord for every half bar with a Viterbi search over diatonic chords, using
// statistics from the POP909 and McGill Billboard corpora.

import { type ChordChart, chordName } from "./arranger";
import { BILLBOARD } from "./billboardStats";
import { POP909 } from "./melodyStats";
import type { Note } from "./types";
import { pitchFrames } from "./voice";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Notes from a hummed recording. `bar1` is where bar 1 starts in the recording (s);
 * returned times are relative to it (a pickup can be slightly negative), quantized to eighths.
 */
export function transcribe(samples: Float32Array, sampleRate: number, bar1: number, bpm: number): Note[] {
  const hop = 0.02;
  const frames = pitchFrames(samples, sampleRate, hop);
  const voiced = frames.filter((f) => f.midi !== null).map((f) => f.midi!);
  if (voiced.length < 10) return [];

  // 5-frame median smoothing over voiced neighbours removes octave blips.
  const m = frames.map((f) => f.midi);
  const sm = m.map((v, i) => {
    if (v === null) return null;
    const win = m.slice(Math.max(0, i - 2), i + 3).filter((x): x is number => x !== null);
    return median(win);
  });
  const level = frames.map((f, i) => (frames[i - 1]?.short ?? f.short) / 4 + f.short / 2 + (frames[i + 1]?.short ?? f.short) / 4);

  // Runs of steady pitch. Pitch steps are judged relative to the run, so this works at any tuning.
  type Seg = { i0: number; i1: number; pitches: number[]; peak: number };
  let segs: Seg[] = [];
  let cur: Seg | null = null;
  let gap = 0;
  sm.forEach((v, i) => {
    // A sharp dip in level inside a note is a re-sung note on the same pitch.
    if (cur && level[i] < 0.35 * cur.peak) {
      segs.push(cur);
      cur = null;
      return;
    }
    if (v === null) {
      if (cur && ++gap > 1) {
        segs.push(cur);
        cur = null;
      }
      return;
    }
    gap = 0;
    if (cur && Math.abs(v - median(cur.pitches.slice(-5))) < 0.75) {
      cur.pitches.push(v);
      cur.i1 = i + 1;
      cur.peak = Math.max(cur.peak, level[i]);
    } else {
      if (cur) segs.push(cur);
      cur = { i0: i, i1: i + 1, pitches: [v], peak: level[i] };
    }
  });
  if (cur) segs.push(cur);

  // Humming the same note twice without a break leaves only a soft dip in level: split there.
  // A dip counts when the level falls to under 70 % of the peaks on both sides (within 0.3 s).
  const reach = Math.round(0.3 / hop);
  segs = segs.flatMap((sg) => {
    const out: Seg[] = [];
    let from = sg.i0;
    for (let i = sg.i0 + 3; i < sg.i1 - 3; i++) {
      if (level[i] > level[i - 1] || level[i] > level[i + 1]) continue;
      const before = Math.max(...level.slice(Math.max(from, i - reach), i));
      const after = Math.max(...level.slice(i + 1, Math.min(sg.i1, i + 1 + reach)));
      if (level[i] >= 0.7 * Math.min(before, after) || i - from < 5) continue;
      out.push({ ...sg, i0: from, i1: i, pitches: sg.pitches.slice(from - sg.i0, i - sg.i0) });
      from = i;
    }
    out.push({ ...sg, i0: from, pitches: sg.pitches.slice(from - sg.i0) });
    return out;
  });
  const t0 = (sg: Seg) => frames[sg.i0].t;
  const t1 = (sg: Seg) => frames[sg.i1 - 1].t + hop;
  segs = segs.filter((sg) => t1(sg) - t0(sg) >= 0.1);
  if (!segs.length) return [];

  // Singers sit off A440 and drift as they go, so the reference follows them: it starts at the
  // tuning of the first notes (averaged on a circle so ±50 cents don't cancel) and then moves a
  // little towards each note's tuning. Without wrapping, so a slow drift past 50 cents stays in key.
  const pitch = segs.map((sg) => median(sg.pitches));
  const dur = segs.map((sg) => t1(sg) - t0(sg));
  const first = segs.slice(0, 6);
  let ref = Math.atan2(sum(first.map((_, j) => dur[j] * Math.sin(2 * Math.PI * pitch[j]))), sum(first.map((_, j) => dur[j] * Math.cos(2 * Math.PI * pitch[j])))) / (2 * Math.PI);
  const tuning = pitch.map((p, k) => {
    const here = ref;
    const off = p - ref - Math.round(p - ref);
    ref += Math.min(0.5, dur[k]) * 0.6 * off;
    return here;
  });
  // A note halfway between two keys is the one in the key of the tune.
  const rough = pitch.map((p, k) => ({ midi: Math.round(p - tuning[k]), time: t0(segs[k]), duration: dur[k], velocity: 1 }));
  const key = detectKey(rough);
  const scale = (key.minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]).map((x) => (key.tonic + x) % 12);
  const inKey = (n: number) => scale.includes(((n % 12) + 12) % 12);
  const snap = (p: number) => {
    const n = Math.round(p);
    if (Math.abs(p - n) < 0.3 || inKey(n)) return n;
    const other = p > n ? n + 1 : n - 1;
    return inKey(other) ? other : n;
  };

  // People sing a little behind (or ahead of) the click, and the recording's start time is only
  // known roughly. Where the note starts sit against the eighth-note grid, on average, is that
  // offset; take it out before snapping to the grid.
  const beat = 60 / bpm;
  const g = beat / 2;
  let px = 0;
  let py = 0;
  for (const sg of segs) {
    const a = (2 * Math.PI * (t0(sg) - bar1)) / g;
    px += Math.cos(a);
    py += Math.sin(a);
  }
  const shift = Math.hypot(px, py) / segs.length > 0.3 ? (Math.atan2(py, px) / (2 * Math.PI)) * g : 0;
  const q = (t: number) => Math.round((t - bar1 - shift) / g) * g;

  const notes: Note[] = [];
  segs.forEach((sg, k) => {
    const time = q(t0(sg));
    if (time < -beat) return; // count-in noise
    const end = Math.max(time + g, q(t1(sg)));
    const midi = snap(pitch[k] - tuning[k]);
    const prev = notes.at(-1);
    if (prev && prev.time === time) {
      if (end - time > prev.duration) Object.assign(prev, { midi, duration: end - time });
      return;
    }
    if (prev && prev.time + prev.duration > time) prev.duration = time - prev.time;
    notes.push({ midi, time, duration: end - time, velocity: 0.7 });
  });
  return notes;
}

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / 12;
  const mb = b.reduce((s, v) => s + v, 0) / 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

const KEY_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** Krumhansl–Schmuckler key from a duration-weighted pitch-class histogram. */
export function detectKey(notes: Note[]): { tonic: number; minor: boolean; name: string } {
  const h = new Array(12).fill(0);
  for (const n of notes) h[((n.midi % 12) + 12) % 12] += n.duration;
  const last = notes.at(-1);
  let best = { tonic: 0, minor: false, score: -Infinity };
  for (let t = 0; t < 12; t++) {
    for (const minor of [false, true]) {
      const prof = (minor ? KS_MINOR : KS_MAJOR).map((_, i, p) => p[(i - t + 12) % 12]);
      let s = corr(h, prof);
      if (last && last.midi % 12 === t) s += 0.08; // tunes like to end on the tonic
      if (s > best.score) best = { tonic: t, minor, score: s };
    }
  }
  return { tonic: best.tonic, minor: best.minor, name: `${KEY_NAMES[best.tonic]} ${best.minor ? "minor" : "major"}` };
}

// Diatonic chord choices (offset from tonic, quality). How likely each follows another comes from
// POP909 (melodyStats.ts); how songs start and end from the McGill Billboard corpus (billboardStats.ts).
export const MAJOR_CHORDS: [number, "maj" | "min"][] = [[0, "maj"], [2, "min"], [4, "min"], [5, "maj"], [7, "maj"], [9, "min"]]; // I ii iii IV V vi
export const MINOR_CHORDS: [number, "maj" | "min"][] = [[0, "min"], [3, "maj"], [5, "min"], [7, "maj"], [8, "maj"], [10, "maj"]]; // i III iv V VI VII
export const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]);
export const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);

/**
 * Log-likelihood of a bar of melody over a chord: every beat of melody (each note counted up
 * to two beats) is an observation, scored by how often melodies sit at that interval above the
 * root of a major or minor chord in the POP909 dataset (melodyStats.ts).
 */
function fit(notes: Note[], barT: number, bar: number, root: number, quality: "maj" | "min", beat: number) {
  const table = POP909[quality];
  let s = 0;
  for (const n of notes) {
    const a = Math.max(n.time, barT);
    const b = Math.min(n.time + Math.min(n.duration, 2 * beat), barT + bar);
    if (b <= a) continue;
    s += ((b - a) / beat) * Math.log(table[(((n.midi - root) % 12) + 12) % 12]);
  }
  return s;
}

export interface Harmonized {
  chart: ChordChart;
  key: string;
  tonic: number;
}

/** Melody weight that picked the annotated chord most often on POP909 training songs (software/pop909_stats.py). */
export const DEFAULT_MELODY_WEIGHT = 3;

/**
 * Chord chart for a melody (times from bar 1; a pickup before bar 1 gets its own empty bar).
 * A hidden Markov model over half bars, so a bar can change chord halfway. Melody-over-chord and
 * chord-to-chord probabilities come from POP909, how songs start and end from Billboard. With the
 * default weight it picked the annotated chord in 39% of half bars on held-out POP909 songs, against
 * 29% for chord habits alone and 36% for the melody alone. Lower weights change chord less often,
 * higher ones follow the tune more, like the "jazz factor" slider in MySong (Simon, Morris & Basu, CHI 2008).
 */
export function harmonize(melody: Note[], bpm: number, melodyWeight = DEFAULT_MELODY_WEIGHT, name = "Hummed melody"): Harmonized {
  const beat = 60 / bpm;
  const bar = beat * 4;
  const half = bar / 2;
  const pickup = melody.some((n) => n.time < -1e-6);
  const notes = pickup ? melody.map((n) => ({ ...n, time: n.time + bar })) : melody;
  const key = detectKey(melody);
  const set = key.minor ? MINOR_CHORDS : MAJOR_CHORDS;
  const next = key.minor ? POP909.minorNextHalf : POP909.majorNextHalf;
  const startP = key.minor ? BILLBOARD.minorStart : BILLBOARD.majorStart;
  const endP = key.minor ? BILLBOARD.minorEnd : BILLBOARD.majorEnd;
  const flats = (key.minor ? FLAT_MINOR : FLAT_MAJOR).has(key.tonic);
  const end = Math.max(bar, ...notes.map((n) => n.time + n.duration));
  const bars = Math.ceil(end / bar - 0.05);
  const first = pickup ? 1 : 0;
  const steps = (bars - first) * 2;
  const emit = (k: number, c: number) => {
    const [off, q] = set[c];
    return melodyWeight * fit(notes, first * bar + k * half, half, (key.tonic + off) % 12, q, beat);
  };

  // Viterbi over half bars.
  const n = set.length;
  let score = set.map((_, c) => emit(0, c) + Math.log(startP[c]));
  const back: number[][] = [];
  for (let k = 1; k < steps; k++) {
    const ptr: number[] = [];
    score = set.map((_, c) => {
      let bestPrev = 0;
      let best = -Infinity;
      for (let p = 0; p < n; p++) {
        const v = score[p] + Math.log(next[p][c]);
        if (v > best) {
          best = v;
          bestPrev = p;
        }
      }
      ptr.push(bestPrev);
      return best + emit(k, c) + (k === steps - 1 ? Math.log(endP[c]) : 0);
    });
    back.push(ptr);
  }
  let c = score.indexOf(Math.max(...score));
  const path = [c];
  for (let k = back.length - 1; k >= 0; k--) {
    c = back[k][c];
    path.unshift(c);
  }
  const name1 = (i: number) => chordName((key.tonic + set[i][0]) % 12, set[i][1], flats);
  // Two halves with the same chord make one bar; different ones are written "C G".
  const names: string[] = [];
  for (let b = 0; b < path.length; b += 2) names.push(path[b] === path[b + 1] ? name1(path[b]) : `${name1(path[b])} ${name1(path[b + 1])}`);
  const chords = [...(pickup ? ["N"] : []), ...names];
  const tonicChord = chordName(key.tonic, key.minor ? "min" : "maj", flats);

  return {
    key: key.name,
    tonic: key.tonic,
    chart: {
      name,
      bpm,
      chords,
      ending: tonicChord,
      tonic: key.tonic,
      scaleRoot: key.minor ? (key.tonic + 3) % 12 : key.tonic,
      melody: notes,
    },
  };
}
