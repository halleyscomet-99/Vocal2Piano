// After a take, or after singing with Listen on: compare the singing with the melody, note by note.
// Octaves are ignored (singing the tune an octave down is fine).

import type { Note } from "./types";
import { pcDiff, pitchFrames } from "./voice";

export interface SungFrame {
  t: number; // song time
  midi: number;
}

export interface NoteResult {
  note: Note;
  cents: number | null; // sung minus written; null = not heard
  offsetMs: number | null; // sung onset minus written onset
}

export interface Phrase {
  start: number;
  end: number;
  notes: number;
  missed: number;
  meanCents: number; // signed
  meanAbsCents: number;
}

export interface PitchReport {
  frames: SungFrame[];
  notes: NoteResult[];
  phrases: Phrase[];
  inTune: number; // share of heard notes within ±50 cents
  heard: number; // share of melody notes heard at all
  meanCents: number; // + sharp, − flat
  timingMs: number | null; // median onset offset; + late, − early
}

// Pitch tracking a take is the slow part; do it once per recording.
const cache = new WeakMap<AudioBuffer, { t: number; midi: number }[]>();
function voicedFrames(buffer: AudioBuffer) {
  let f = cache.get(buffer);
  if (!f) {
    f = pitchFrames(buffer.getChannelData(0), buffer.sampleRate, 0.02)
      .filter((x) => x.midi !== null)
      .map((x) => ({ t: x.t, midi: x.midi! }));
    cache.set(buffer, f);
  }
  return f;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * @param melody melody in song time (tempo and transpose applied)
 * @param start song time of the take's first sample
 * @param rate how fast the take plays relative to the song now (buffer s per song s)
 */
export function checkPitch(buffer: AudioBuffer, start: number, rate: number, melody: Note[]): PitchReport {
  const frames: SungFrame[] = voicedFrames(buffer).map((f) => ({ t: start + f.t / rate, midi: f.midi }));
  return checkFrames(frames, start, start + buffer.duration / rate, melody);
}

/** The same check from pitch readings already on the song clock (sorted by time), e.g. heard live. */
export function checkFrames(frames: SungFrame[], start: number, end: number, melody: Note[]): PitchReport {
  // Only melody notes the singing covers.
  const covered = melody.filter((n) => n.time >= start && n.time + n.duration <= end + 0.1).sort((x, y) => x.time - y.time);

  let k = 0;
  const notes: NoteResult[] = covered.map((note) => {
    const a = note.time + note.duration * 0.2;
    const b = note.time + note.duration * 0.8;
    while (k < frames.length && frames[k].t < note.time - 0.3) k++;
    const inside: number[] = [];
    let onset: number | null = null;
    for (let j = k; j < frames.length && frames[j].t < Math.max(b, note.time + 0.4); j++) {
      const f = frames[j];
      const d = pcDiff(f.midi, note.midi);
      if (onset === null && Math.abs(d) < 1.5 && f.t < note.time + 0.4) onset = f.t;
      if (f.t >= a && f.t <= b) inside.push(d);
    }
    if (inside.length < 3) return { note, cents: null, offsetMs: null };
    return { note, cents: Math.round(median(inside) * 100), offsetMs: onset === null ? null : Math.round((onset - note.time) * 1000) };
  });

  // Phrases: split the melody at rests longer than 0.6 s.
  const phrases: Phrase[] = [];
  let cur: NoteResult[] = [];
  const flush = () => {
    if (!cur.length) return;
    const heard = cur.filter((r) => r.cents !== null).map((r) => r.cents!);
    const last = cur.at(-1)!.note;
    phrases.push({
      start: cur[0].note.time,
      end: last.time + last.duration,
      notes: cur.length,
      missed: cur.length - heard.length,
      meanCents: heard.length ? Math.round(heard.reduce((s, c) => s + c, 0) / heard.length) : 0,
      meanAbsCents: heard.length ? Math.round(heard.reduce((s, c) => s + Math.abs(c), 0) / heard.length) : 0,
    });
    cur = [];
  };
  notes.forEach((r, i) => {
    const prev = notes[i - 1]?.note;
    if (prev && r.note.time - (prev.time + prev.duration) > 0.6) flush();
    cur.push(r);
  });
  flush();

  const heard = notes.filter((r) => r.cents !== null);
  const offsets = notes.filter((r) => r.offsetMs !== null).map((r) => r.offsetMs!);
  return {
    frames,
    notes,
    phrases,
    inTune: heard.length ? heard.filter((r) => Math.abs(r.cents!) <= 50).length / heard.length : 0,
    heard: notes.length ? heard.length / notes.length : 0,
    meanCents: heard.length ? Math.round(heard.reduce((s, r) => s + r.cents!, 0) / heard.length) : 0,
    timingMs: offsets.length >= 3 ? median(offsets) : null,
  };
}
