// Imported scores (MIDI, MusicXML) and deciding which part is the sung tune
// and which parts the robot plays.

import type { Note, Song } from "./types";

export interface ScoreTrack {
  name: string;
  notes: Note[];
  drum: boolean;
}

export interface Score {
  name: string;
  bpm: number;
  tracks: ScoreTrack[];
}

/** melody = sung, piano = the robot plays it, off = ignored. */
export type Role = "melody" | "piano" | "off";

const ONSET_EPS = 0.03;

/** Share of notes that start after the previous one has ended: 1 = a single line. */
function monophony(notes: Note[]): number {
  if (notes.length < 2) return 1;
  const s = [...notes].sort((a, b) => a.time - b.time);
  let ok = 0;
  for (let i = 1; i < s.length; i++) if (s[i].time >= s[i - 1].time + s[i - 1].duration - 0.05) ok++;
  return ok / (s.length - 1);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

export function trackSummary(t: ScoreTrack) {
  const pitches = t.notes.map((n) => n.midi);
  return {
    count: t.notes.length,
    low: Math.min(...pitches),
    high: Math.max(...pitches),
    mono: monophony(t.notes),
  };
}

/** Best guess at roles: one singable single-line track becomes the melody, drums are off, the rest is piano. */
export function guessRoles(score: Score): Role[] {
  const roles: Role[] = score.tracks.map((t) => (t.drum || t.notes.length === 0 ? "off" : "piano"));
  let best = -1;
  let bestScore = 1.5;
  const means = score.tracks.map((t) => mean(t.notes.map((n) => n.midi)));
  const highest = Math.max(...means.filter((_, i) => roles[i] !== "off"));
  score.tracks.forEach((t, i) => {
    if (roles[i] === "off" || t.notes.length < 8) return;
    const name = t.name.toLowerCase();
    if (/bass|drum|perc|pad|string|chord/.test(name)) return;
    const mono = monophony(t.notes);
    if (mono < 0.7) return;
    let s = mono * 2;
    if (/vocal|voice|vox|melod|lead|sing|tune|solo/.test(name)) s += 3;
    if (/piano|keys|pno|accomp/.test(name)) s -= 1;
    if (means[i] === highest) s += 1;
    const m = means[i];
    if (m < 52 || m > 84) s -= 1.5; // outside where people sing
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  });
  if (best >= 0) roles[best] = "melody";
  return roles;
}

/**
 * Split a piano part into its top line (the melody, if it sits above `floor`) and the rest.
 * At each onset the highest note wins; melody notes are trimmed so they never overlap.
 */
export function skyline(notes: Note[], floor = 60): { melody: Note[]; rest: Note[] } {
  const s = [...notes].sort((a, b) => a.time - b.time || b.midi - a.midi);
  const melody: Note[] = [];
  const rest: Note[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && s[j].time - s[i].time < ONSET_EPS) j++;
    const group = s.slice(i, j); // sorted high → low within the onset
    const top = group[0];
    const prev = melody.at(-1);
    // Skip a top note that is just an inner voice under a melody note still sounding much higher.
    const masked = prev && prev.time + prev.duration > top.time + 0.05 && prev.midi - top.midi > 4;
    if (top.midi >= floor && !masked) {
      melody.push({ ...top });
      rest.push(...group.slice(1));
    } else rest.push(...group);
    i = j;
  }
  for (let k = 0; k + 1 < melody.length; k++) {
    melody[k].duration = Math.min(melody[k].duration, Math.max(0.05, melody[k + 1].time - melody[k].time));
  }
  return { melody, rest };
}

export interface ScoreSongOptions {
  /** With no melody track: take the melody from the top line of the piano part. */
  topLine: boolean;
  /** Also play the melody on the piano, as a guide while learning it. */
  guide: boolean;
}

export function songFromScore(score: Score, roles: Role[], o: ScoreSongOptions): Song {
  const piano = score.tracks.flatMap((t, i) => (roles[i] === "piano" ? t.notes : []));
  let melody = score.tracks.flatMap((t, i) => (roles[i] === "melody" ? t.notes : [])).sort((a, b) => a.time - b.time);
  let notes = piano;
  if (!melody.length && o.topLine && piano.length) {
    const split = skyline(piano);
    melody = split.melody;
    notes = split.rest;
  }
  if (o.guide) notes = [...notes, ...melody.map((n) => ({ ...n, velocity: Math.min(1, n.velocity + 0.1) }))];
  return { name: score.name, bpm: score.bpm, notes, melody: melody.length ? melody : undefined };
}
