// Accompaniment generator: chord chart + style + flourish → piano part.
// Charts come from the demo progressions (the most common loops in the McGill Billboard
// corpus), from harmonizing a hummed melody, or from the chord editor.
// The styles are standard, named accompaniment patterns, not inventions of this project.

import { BILLBOARD } from "./billboardStats";
import type { Note, Song } from "./types";

export const QUALITY: Record<string, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
};

/** Suffix written after the root for each quality ("" = major). */
export const QUALITY_SUFFIX: Record<string, string> = { maj: "", min: "m", "7": "7", maj7: "maj7", m7: "m7", dim: "dim", sus4: "sus4" };

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** "Am7" → { root: 9, quality: "m7", tones: [0,3,7,10] } */
export function parseChord(sym: string) {
  const m = /^([A-G])([#b]?)(maj7|m7|dim|sus4|7|m)?$/.exec(sym);
  if (!m) throw new Error(`Unknown chord ${sym}`);
  const root = (PC[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
  const quality = m[3] === "m" ? "min" : (m[3] ?? "maj");
  return { root, quality, tones: QUALITY[quality] };
}

export function chordName(root: number, quality: string, flats = false): string {
  return (flats ? FLATS : SHARPS)[((root % 12) + 12) % 12] + QUALITY_SUFFIX[quality];
}

export type Style = "block" | "broken" | "alberti" | "stride" | "bossa";

/**
 * Standard keyboard accompaniment patterns, each a widely documented technique:
 * - block: block chords on beats 1 and 3 over a held root (the basic hymn/ballad texture)
 * - broken: broken-chord (arpeggiated) left hand, root–fifth–octave–fifth in eighths
 * - alberti: Alberti bass, low–high–middle–high (named after Domenico Alberti, c. 1710–1740)
 * - stride: stride piano, bass note on 1 and 3, chord on 2 and 4 (Harlem stride, 1920s)
 * - bossa: bossa nova comping, root–fifth bass with the chords off the beat (Brazil, late 1950s)
 */
export const STYLES: { id: Style; label: string }[] = [
  { id: "block", label: "Block chords" },
  { id: "broken", label: "Broken chords" },
  { id: "alberti", label: "Alberti bass" },
  { id: "stride", label: "Stride" },
  { id: "bossa", label: "Bossa nova" },
];

const MAJOR_DEGREES: Record<string, [number, string]> = { I: [0, "maj"], ii: [2, "min"], iii: [4, "min"], IV: [5, "maj"], V: [7, "maj"], vi: [9, "min"] };
const MINOR_DEGREES: Record<string, [number, string]> = { i: [0, "min"], III: [3, "maj"], iv: [5, "min"], V: [7, "maj"], VI: [8, "maj"], VII: [10, "maj"] };

/**
 * Demo progressions straight from the corpus: for each set of chords, its most common
 * 4-bar ordering, kept when it appears in at least 5% of songs. Major demos are in C,
 * minor demos in A minor; the key and speed controls move them anywhere.
 */
function corpusProgressions() {
  const pick = (loops: readonly { loop: readonly string[]; share: number }[], minor: boolean) => {
    const seen = new Set<string>();
    const out = [];
    for (const l of loops) {
      const set = [...new Set(l.loop)].sort().join();
      if (seen.has(set) || l.share < 0.05) continue;
      seen.add(set);
      const deg = minor ? MINOR_DEGREES : MAJOR_DEGREES;
      const tonic = minor ? 9 : 0;
      const chords = l.loop.map((r) => chordName((tonic + deg[r][0]) % 12, deg[r][1]));
      const name = l.loop.filter((r, i) => i === 0 || r !== l.loop[i - 1]).join("–");
      out.push({ id: name, name, bpm: 92, tonic, chords, share: l.share, minor });
    }
    return out;
  };
  return [...pick(BILLBOARD.majorLoops, false), ...pick(BILLBOARD.minorLoops, true)];
}

export const PROGRESSIONS = corpusProgressions();
export const CORPUS_SONGS = BILLBOARD.songs;

/** Chord voicing nearest to `center` (keeps the right hand moving smoothly). */
function voice(root: number, tones: number[], center: number): number[] {
  let best: number[] = [];
  let bestDist = Infinity;
  for (let base = center - 18; base <= center + 6; base++) {
    if (((base - root) % 12 + 12) % 12 !== 0) continue;
    for (let inv = 0; inv < tones.length; inv++) {
      const v = tones.map((t, i) => base + t + (i < inv ? 12 : 0)).sort((a, b) => a - b);
      const mid = (v[0] + v[v.length - 1]) / 2;
      const d = Math.abs(mid - center);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
  }
  return best;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

export type BarDynamic = "soft" | "full" | null;

export interface ChordChart {
  name: string;
  bpm: number;
  chords: string[]; // one per 4/4 bar, "N" = no chord, "C G" = C then G halfway through
  dyn?: BarDynamic[]; // per bar; null = normal
  offset?: number; // s, time of the first bar
  scaleRoot?: number; // major-scale pitch class used for pickups
  ending?: string; // chord to ring out on
  tonic?: number; // key tonic pitch class (for voice-fit)
  intro?: boolean; // two soft bars (the chart's last two chords) before bar 1
  outro?: boolean; // finish with a rolled chord instead of a plain one
  melody?: Note[]; // times relative to bar 1
}

export function progressionChart(progId: string, loops = 4): ChordChart {
  const prog = PROGRESSIONS.find((p) => p.id === progId) ?? PROGRESSIONS[0];
  return {
    name: prog.name,
    bpm: prog.bpm,
    chords: Array.from({ length: loops }, () => prog.chords).flat(),
    ending: prog.chords[0],
    tonic: prog.tonic,
    scaleRoot: prog.minor ? (prog.tonic + 3) % 12 : prog.tonic,
  };
}

const DYN_VEL: Record<string, number> = { soft: 0.7, full: 1.15, normal: 1 };

/** Re-voice a chord chart as piano accompaniment in the chosen style. */
export function arrangeChart(chart: ChordChart, style: Style, flourish: number): Song {
  const beat = 60 / chart.bpm;
  const bar = beat * 4;
  const scaleRoot = chart.scaleRoot ?? 0;
  const inScale = (m: number) => MAJOR.includes((((m - scaleRoot) % 12) + 12) % 12);
  const notes: Note[] = [];

  const intro = chart.intro ? chart.chords.filter((c) => c !== "N").slice(-2) : [];
  const chords = [...intro, ...chart.chords];
  const dyn: BarDynamic[] = [...intro.map((): BarDynamic => "soft"), ...chart.chords.map((_, i) => chart.dyn?.[i] ?? null)];
  const offset = chart.offset ?? 0;
  const shift = intro.length * bar; // melody and chart start after the intro

  // One bar of the style for one chord. A bar written "C G" changes chord halfway:
  // the first half is cut from a C bar, the second from a G bar.
  const playBar = (sym: string, i: number, t: number, out: Note[]) => {
    const { root, tones } = parseChord(sym);
    const d = dyn[i] ?? "normal";
    const k = DYN_VEL[d];
    const add = (midi: number, time: number, dur: number, vel: number) => out.push({ midi, time, duration: dur, velocity: Math.min(1, vel * k) });
    const bass = 36 + root; // root in C2..B2
    const full = voice(root, tones, 67);
    const rh = d === "soft" ? full.slice(-2) : full;
    const nextSym = chords[i + 1]?.split(" ")[0];

    if (d === "full") add(bass + 7, t, bar * 0.95, 0.5); // open fifth over the bass: fuller, still in one hand's reach

    switch (style) {
      case "block":
        add(bass, t, bar * 0.95, 0.75);
        add(bass + 12, t + beat * 2, beat * 1.9, 0.5);
        rh.forEach((m) => add(m, t, beat * 1.9, 0.6));
        rh.forEach((m) => add(m, t + beat * 2, beat * 1.9, 0.5));
        break;
      case "broken": {
        const pat = [bass, bass + 7, bass + 12, bass + 7];
        for (let j = 0; j < 8; j++) add(pat[j % 4], t + j * beat * 0.5, beat * 0.5, j % 4 === 0 ? 0.7 : 0.45);
        add(rh[rh.length - 1], t, bar * 0.9, 0.55);
        break;
      }
      case "alberti": {
        add(bass, t, bar * 0.95, 0.6);
        const [lo, mid, hi] = [full[0], full[1], full[full.length - 1]];
        const pat = [lo, hi, mid, hi];
        for (let j = 0; j < 8; j++) add(pat[j % 4], t + j * beat * 0.5, beat * 0.45, j % 2 === 0 ? 0.55 : 0.4);
        break;
      }
      case "bossa":
        add(bass, t, beat * 1.4, 0.65);
        add(bass + 7, t + beat * 1.5, beat * 0.45, 0.5);
        add(bass, t + beat * 2, beat * 1.4, 0.6);
        add(bass + 7, t + beat * 3.5, beat * 0.45, 0.5);
        for (const off of [0, 1.5, 2.5]) rh.forEach((m) => add(m, t + off * beat, beat * 0.4, off === 0 ? 0.55 : 0.45));
        break;
      case "stride": {
        const mid = voice(root, tones, 60);
        add(bass, t, beat * 0.9, 0.7);
        add(bass + 7 > 47 ? bass - 5 : bass + 7, t + beat * 2, beat * 0.9, 0.6);
        for (const off of [1, 3]) (d === "soft" ? mid.slice(-2) : mid).forEach((m) => add(m, t + off * beat, beat * 0.5, 0.5));
        break;
      }
    }

    // Flourish 1+: passing notes — two scale steps leading down into the next chord's top note.
    if (flourish >= 1 && nextSym && nextSym !== "N") {
      const next = parseChord(nextSym);
      const target = voice(next.root, next.tones, 67).at(-1)!;
      const above = (m: number) => {
        do m++;
        while (!inScale(m));
        return m;
      };
      const up1 = above(target);
      add(above(up1), t + beat * 3.5, beat * 0.25, 0.4);
      add(up1, t + beat * 3.75, beat * 0.25, 0.45);
    }
    // Flourish 2: also a grace note (acciaccatura) into the top voice on beat 3, and a left-hand fifth on the "and" of 2.
    if (flourish >= 2 && nextSym) {
      const top = full[full.length - 1];
      add(top - 1, t + beat * 2 - 0.07, 0.06, 0.35);
      add(bass + 7, t + beat * 1.5, beat * 0.45, 0.45);
    }
  };

  chords.forEach((sym, i) => {
    if (sym === "N") return;
    const t = offset + i * bar;
    const [first, second] = sym.split(" ");
    if (!second) return playBar(first, i, t, notes);
    const mid = t + bar / 2;
    const a: Note[] = [];
    const b: Note[] = [];
    playBar(first, i, t, a);
    playBar(second, i, t, b);
    for (const n of a) if (n.time < mid - 1e-6) notes.push({ ...n, duration: Math.min(n.duration, mid - n.time) });
    for (const n of b) if (n.time >= mid - 1e-6) notes.push(n);
  });

  // Ending: the final chord rings out, or rolls up from the bass with the outro.
  if (chart.ending) {
    const endT = offset + chords.length * bar;
    const { root, tones } = parseChord(chart.ending);
    const chord = voice(root, tones, 67);
    if (chart.outro) {
      const roll = [36 + root, 43 + root, 48 + root, ...chord, chord[0] + 12];
      roll.forEach((m, j) => notes.push({ midi: m, time: endT + j * 0.09, duration: bar * 1.5 - j * 0.09, velocity: 0.55 }));
    } else {
      notes.push({ midi: 36 + root, time: endT, duration: bar, velocity: 0.7 });
      chord.forEach((m) => notes.push({ midi: m, time: endT, duration: bar, velocity: 0.6 }));
    }
  }

  const melody = chart.melody?.map((n) => ({ ...n, time: n.time + offset + shift }));
  return { name: `${chart.name} — ${STYLES.find((s) => s.id === style)!.label}`, bpm: chart.bpm, notes, melody };
}
