// Changing one part of a song: per-bar speed, piano style and cuts, and single notes
// left out or held longer or shorter, all on top of the whole-song settings.
// Bars are counted from the song's own start (4/4 at song.bpm).

import { type ChordChart, type Style, arrangeChart, chordName } from "./arranger";
import type { Note, Song } from "./types";

export interface BarEdit {
  speed?: number; // 1 = as the rest of the song
  style?: Style; // play this bar in another accompaniment style
  cut?: boolean; // leave the bar out
}
export type BarEdits = Record<number, BarEdit>;

/** One piano note: left out, or held for a different length (song seconds, before speed changes). */
export interface NoteEdit {
  mute?: boolean;
  duration?: number;
}
/** Keyed by note id (see `noteId`). */
export type NoteEdits = Record<string, NoteEdit>;

/** A bar on the edited timeline. Cut bars keep a mark (zero length) where they were. */
export interface BarMark {
  bar: number; // bar index in the original song
  time: number; // start, edited song seconds
  end: number;
  cut: boolean;
  edit?: BarEdit;
}

export interface EditedSong {
  song: Song; // piano notes carry ids
  /** Left-out notes, where they would be (edited time), so they can be brought back. */
  muted: Note[];
  /** Every piano note by id, at its original time, with its length change applied. */
  source: Map<string, Note>;
  marks: BarMark[];
  /** Edited time → original song time, and back (for keeping the current place when edits change). */
  toOrig: (t: number) => number;
  toPerf: (t: number) => number;
}

export const barLength = (bpm: number) => 240 / bpm;

export function isPlain(e: BarEdit | undefined) {
  return !e || (!e.cut && !e.style && (e.speed ?? 1) === 1);
}

export function songBars(song: Song) {
  const end = [...song.notes, ...(song.melody ?? [])].reduce((m, n) => Math.max(m, n.time + n.duration), 0);
  return Math.max(1, Math.ceil(end / barLength(song.bpm) - 1e-3));
}

/**
 * The chords of a written piano part, one or two per bar, so it can be re-played in
 * another style. Each half bar takes the major or minor triad that best covers the
 * notes sounding in it (bass notes count double, the tune counts half). Ties go to
 * the chord whose notes the whole song uses most, i.e. the one in the song's key.
 * A half bar with no notes keeps the chord before it.
 */
export function chartFromNotes(song: Song): ChordChart {
  const bar = barLength(song.bpm);
  const half = bar / 2;
  const n = songBars(song);
  const weigh = (w: number[], notes: Note[], k: number, scale: number) => {
    const a = k * half;
    const b = a + half;
    for (const x of notes) {
      const o = Math.min(b, x.time + x.duration) - Math.max(a, x.time);
      if (o > 0) w[x.midi % 12] += o * scale * (x.midi < 55 ? 2 : 1);
    }
  };
  const song12 = new Array(12).fill(0);
  for (let k = 0; k < n * 2; k++) {
    weigh(song12, song.notes, k, 1);
    weigh(song12, song.melody ?? [], k, 0.5);
  }
  const songTotal = song12.reduce((s, x) => s + x, 0) || 1;
  const halves: string[] = [];
  let prev = "N";
  for (let k = 0; k < n * 2; k++) {
    const w = new Array(12).fill(0);
    weigh(w, song.notes, k, 1);
    weigh(w, song.melody ?? [], k, 0.5);
    const total = w.reduce((s, x) => s + x, 0);
    if (total > 1e-6) {
      let best = -Infinity;
      for (let r = 0; r < 12; r++) {
        for (const [q, third] of [["maj", 4], ["min", 3]] as const) {
          const tones = [r, (r + third) % 12, (r + 7) % 12];
          const inside = tones.reduce((s, p) => s + w[p], 0);
          const usual = tones.reduce((s, p) => s + song12[p], 0) / songTotal;
          const score = inside - 0.6 * (total - inside) + 0.1 * w[r] + 0.3 * usual * total;
          if (score > best) {
            best = score;
            prev = chordName(r, q, [1, 3, 5, 8, 10].includes(r));
          }
        }
      }
    }
    halves.push(prev);
  }
  const chords = Array.from({ length: n }, (_, i) => (halves[2 * i] === halves[2 * i + 1] ? halves[2 * i] : `${halves[2 * i]} ${halves[2 * i + 1]}`));
  return { name: song.name, bpm: song.bpm, chords };
}

/** Give each note an id from its place in the song (start, pitch), stable across edits. */
function withIds(notes: Note[]): Note[] {
  const seen = new Map<string, number>();
  return notes.map((x) => {
    const base = `${Math.round(x.time * 1000)}:${x.midi}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return { ...x, id: k ? `${base}#${k}` : base };
  });
}

/**
 * Apply per-bar and per-note edits. `restyle(style)` gives the whole song in that style
 * (same bars); bars with a style take their notes from it, the rest keep the original notes.
 */
export function editSong(song: Song, edits: BarEdits, noteEdits: NoteEdits, restyle: (s: Style) => Note[]): EditedSong {
  const bar = barLength(song.bpm);
  const n = songBars(song);
  const speed = (k: number) => edits[k]?.speed ?? 1;
  const cut = (k: number) => !!edits[k]?.cut;
  const starts: number[] = [];
  let acc = 0;
  for (let k = 0; k < n; k++) {
    starts.push(acc);
    if (!cut(k)) acc += bar / speed(k);
  }
  const marks: BarMark[] = starts.map((t, k) => ({ bar: k, time: t, end: cut(k) ? t : t + bar / speed(k), cut: cut(k), edit: edits[k] }));
  const barOf = (t: number) => Math.min(n - 1, Math.max(0, Math.floor(t / bar + 1e-6)));
  const toPerf = (t: number) => {
    const k = barOf(t);
    return cut(k) ? starts[k] : starts[k] + (t - k * bar) / speed(k);
  };
  const toOrig = (t: number) => {
    let k = 0;
    for (let j = 0; j < n; j++) if (!cut(j) && starts[j] <= t + 1e-9) k = j;
    return k * bar + (t - starts[k]) * speed(k);
  };

  const move = (x: Note): Note | null => {
    const k = barOf(x.time);
    if (cut(k)) return null;
    return { ...x, time: toPerf(x.time), duration: x.duration / speed(k) };
  };
  const styled = new Map<Style, Note[]>();
  const notes: Note[] = [];
  for (const x of song.notes) if (!edits[barOf(x.time)]?.style) notes.push(x);
  for (let k = 0; k < n; k++) {
    const s = edits[k]?.style;
    if (!s) continue;
    if (!styled.has(s)) styled.set(s, restyle(s));
    for (const x of styled.get(s)!) if (barOf(x.time) === k) notes.push(x);
  }
  const keep = (xs: Note[]) => xs.map(move).filter((x): x is Note => x !== null);
  const piano = withIds(notes.sort((a, b) => a.time - b.time || a.midi - b.midi)).map((x) => {
    const e = noteEdits[x.id!];
    return e?.duration ? { ...x, duration: e.duration } : x;
  });
  return {
    song: { ...song, notes: keep(piano.filter((x) => !noteEdits[x.id!]?.mute)), melody: song.melody && keep(song.melody) },
    muted: keep(piano.filter((x) => noteEdits[x.id!]?.mute)),
    source: new Map(piano.map((x) => [x.id!, x])),
    marks,
    toOrig,
    toPerf,
  };
}

/** The style-change helper for a chart-based song or a written piano part. */
export function restyler(song: Song, chart: ChordChart | null, flourish: number) {
  let derived: ChordChart | null = null;
  return (s: Style) => {
    if (chart) return arrangeChart(chart, s, flourish).notes;
    derived ??= chartFromNotes(song);
    return arrangeChart(derived, s, 0).notes;
  };
}
