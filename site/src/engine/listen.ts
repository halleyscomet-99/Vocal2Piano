// What the piano does with the voice while it plays, like a human accompanist:
// - waits for the singer to come in at the start of each line,
// - stops when the singing stops in the middle of a line, and picks up where it starts again,
// - plays as loud as the singing,
// - moves to the key actually being sung.
// It never follows the singer's tempo note by note (that was too jumpy); it only waits.
// Pure logic, fed one microphone frame at a time; src/App.tsx applies the actions.

import type { Note } from "./types";
import { pcDiff } from "./voice";

export interface ListenOptions {
  wait: boolean; // wait for me to come in, and when I stop
  loudness: boolean; // piano follows how loud I sing
  key: boolean; // piano moves to the key I sing in
}
export const DEFAULT_LISTEN: ListenOptions = { wait: true, loudness: true, key: true };

/** One pitch reading from the microphone. */
export interface Frame {
  t: number; // song time of the sound (performance clock)
  at: number; // audio-clock time of the sound
  midi: number | null; // fractional MIDI pitch, null when no clear pitch
  level: number; // 0..1
}

export type Action =
  | { type: "gate"; time: number } // don't schedule anything at or after this song time yet
  | { type: "hold"; time: number; reason: "entrance" | "stopped" } // stop here and wait
  | { type: "resume"; time: number; at: number } // song time `time` sounded at audio time `at`
  | { type: "loudness"; gain: number }
  | { type: "key"; shift: number }; // semitones to move the piano by

export interface Line {
  start: number;
  end: number;
  notes: Note[];
}

/** The tune's lines: split where it rests for 1.5 beats or more. */
export function linesOf(melody: Note[], beat: number): Line[] {
  const rest = Math.max(0.6, 1.5 * beat);
  const lines: Line[] = [];
  for (const n of [...melody].sort((a, b) => a.time - b.time)) {
    const cur = lines.at(-1);
    if (cur && n.time - cur.end < rest) {
      cur.notes.push(n);
      cur.end = Math.max(cur.end, n.time + n.duration);
    } else lines.push({ start: n.time, end: n.time + n.duration, notes: [n] });
  }
  return lines;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** How late the singer may come in before the piano stops to wait (s). */
export const GRACE = 0.4;
const EARLY = 0.4; // singing this long before a line starts counts as coming in
const FLOOR_FRAMES = 75; // ~3 s of frames for the background level
const MIN_LEVEL = 0.1;
const DECAY = 0.6; // s a piano note is still heard after it ends

export class Listener {
  state: "playing" | "waiting" = "playing";
  reason: "entrance" | "stopped" | null = null;
  /** The last frame was the voice (not silence, not the piano). */
  voiced = false;
  /** Shown while waiting: the song time it will start from when the singing starts. */
  waitAt = 0;

  private lines: Line[] = [];
  private melody: Note[] = [];
  private piano: Note[] = [];
  private beat = 0.5;
  private next = 0; // index of the line we're waiting to hear start
  private gate = Infinity;
  private lastVoice = -Infinity; // song time of the last voiced frame
  private levels: number[] = [];
  private run = 0; // voiced frames in a row
  private gap = 99; // unvoiced frames in a row
  private onsetAt = 0;
  private onsetPitches: number[] = [];
  private stopFrom = 0;
  private env = 0;
  private ref = 0;
  private refN = 0;
  private gain = 1;
  private sentGain = 1;
  private diffs: number[] = [];
  private keyLine = -1;
  // After picking up: the other places the singer might have come in, scored as the singing goes on.
  private check: { until: number; options: { delta: number; hits: number }[] } | null = null;
  private gapBefore = 0;

  constructor(
    public opts: ListenOptions,
    melody: Note[],
    piano: Note[],
    beat: number,
  ) {
    this.setSong(melody, piano, beat);
  }

  /** New key or tempo: same place in the song, new notes. */
  setSong(melody: Note[], piano: Note[], beat: number) {
    this.melody = [...melody].sort((a, b) => a.time - b.time);
    this.piano = [...piano].sort((a, b) => a.time - b.time);
    this.beat = beat;
    this.lines = linesOf(this.melody, beat);
  }

  /** Playing starts (or jumps) at song time t: forget any wait, aim at the next line. */
  reset(t: number): Action[] {
    this.state = "playing";
    this.reason = null;
    this.next = this.lines.findIndex((l) => l.start + GRACE > t);
    if (this.next < 0) this.next = this.lines.length;
    this.lastVoice = -Infinity;
    this.diffs = [];
    this.check = null;
    this.keyLine = this.lineAt(t);
    return [this.setGate()];
  }

  private setGate(): Action {
    const l = this.lines[this.next];
    this.gate = this.opts.wait && l ? l.start + GRACE : Infinity;
    return { type: "gate", time: this.gate };
  }

  private lineAt(t: number) {
    return this.lines.findIndex((l) => l.start - EARLY <= t && t <= l.end + 0.15);
  }

  private noteAt(t: number) {
    // Melody notes are sorted and rarely overlap; a short scan from a binary search is enough.
    let lo = 0;
    let hi = this.melody.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.melody[m].time <= t) lo = m + 1;
      else hi = m;
    }
    for (let i = lo - 1; i >= Math.max(0, lo - 4); i--) {
      const n = this.melody[i];
      if (n.time <= t && t <= n.time + n.duration) return n;
    }
    return null;
  }

  /** Is this pitch probably the piano itself, leaking into the microphone? */
  private isPiano(t: number, midi: number) {
    const tune = this.noteAt(t);
    if (tune && Math.abs(pcDiff(midi, tune.midi)) < 0.6) return false; // the note that should be sung: trust it
    for (let i = this.piano.length - 1; i >= 0; i--) {
      const n = this.piano[i];
      if (n.time > t) continue;
      if (n.time + n.duration + DECAY < t - 4) break;
      if (n.time + n.duration + DECAY >= t && Math.abs(pcDiff(midi, n.midi)) < 0.4) return true;
    }
    return false;
  }

  hear(f: Frame): Action[] {
    const out: Action[] = [];
    this.levels.push(f.level);
    if (this.levels.length > FLOOR_FRAMES) this.levels.shift();
    const floor = Math.min(...this.levels);
    const t = this.state === "waiting" ? this.waitAt : f.t;
    const voice = f.midi !== null && f.level >= Math.max(MIN_LEVEL, floor * 2.5) && !(this.state === "playing" && this.isPiano(t, f.midi));
    this.voiced = voice;

    // A new sung note after a pause, with the level clearly rising (a ringing piano only fades).
    if (voice) {
      if (this.run === 0) {
        const before = this.levels.slice(-6, -1);
        this.onsetAt = f.at;
        this.onsetPitches = [];
        this.gapBefore = this.gap;
        if (before.length && f.level < 1.6 * Math.min(...before)) this.gapBefore = 0;
      }
      this.run++;
      this.gap = 0;
      this.onsetPitches.push(f.midi!);
    } else {
      this.run = 0;
      this.gap++;
    }

    this.loudness(voice, f.level, out);

    // Waiting, and the singing starts: a few readings to hear which note, then go.
    if (this.state === "waiting") {
      if (voice && this.run === 3 && this.gapBefore >= 3) {
        const options = this.options();
        const time = this.closest(median(this.onsetPitches), options);
        const acts = this.resumeAt(time);
        if (options.length > 1) this.check = { until: time + 1.5, options: options.map((n) => ({ delta: n.time - time, hits: 0 })) };
        return [...out, ...acts];
      }
      return out;
    }

    // Just picked up: does the singing fit another of the places better? Then move there once.
    if (this.check) {
      if (voice)
        for (const o of this.check.options) {
          const n = this.noteAt(t + o.delta);
          if (n && Math.abs(pcDiff(f.midi!, n.midi)) < 0.75) o.hits++;
        }
      if (t > this.check.until) {
        const chosen = this.check.options.find((o) => o.delta === 0)!;
        const best = this.check.options.reduce((a, b) => (b.hits > a.hits ? b : a));
        this.check = null;
        if (best !== chosen && best.hits >= chosen.hits + 6 && best.hits >= 1.5 * chosen.hits) {
          this.onsetAt = f.at;
          return [...out, ...this.resumeAt(f.t + best.delta)];
        }
      }
    }

    if (voice) {
      this.lastVoice = t;
      // Coming in at (or a little before) the next line.
      const l = this.lines[this.next];
      if (l && t >= l.start - EARLY) {
        this.next++;
        out.push(this.setGate());
      }
      const n = this.noteAt(t);
      if (n && t >= n.time + 0.08) this.diffs.push(pcDiff(f.midi!, n.midi));
    }

    // The line being sung just ended: check which key it was sung in.
    const line = this.lineAt(t);
    if (line !== this.keyLine) {
      if (this.keyLine >= 0) {
        const shift = this.keyShift();
        if (shift) out.push({ type: "key", shift });
      }
      this.diffs = [];
      this.keyLine = line;
    }

    if (this.opts.wait) {
      // No voice yet when the line starts.
      if (t >= this.gate) {
        this.state = "waiting";
        this.reason = "entrance";
        this.waitAt = this.gate;
        out.push({ type: "hold", time: this.gate, reason: "entrance" });
        return out;
      }
      // Stopped in the middle of a line being sung.
      const quiet = Math.max(1.5, 3 * this.beat);
      const cur = this.lines[line];
      if (cur && this.lastVoice >= cur.start - EARLY && t - this.lastVoice >= quiet && t < cur.end - 0.2 && this.coverage(this.lastVoice, t) >= 0.6) {
        this.state = "waiting";
        this.reason = "stopped";
        this.waitAt = t;
        this.stopFrom = this.lastVoice;
        out.push({ type: "hold", time: t, reason: "stopped" });
      }
    }
    return out;
  }

  private resumeAt(time: number): Action[] {
    this.state = "playing";
    this.reason = null;
    this.lastVoice = time;
    this.next = this.lines.findIndex((l) => l.start - EARLY > time);
    if (this.next < 0) this.next = this.lines.length;
    this.diffs = [];
    this.keyLine = this.lineAt(time);
    return [{ type: "resume", time, at: this.onsetAt }, this.setGate()];
  }

  /**
   * The places the singer might come in. After stopping mid-line: the note it stopped on, the start of that
   * line, or the next line. At a line start: that line, or the one before (going over it
   * again). `closest` picks the one that starts on the sung pitch (ties go in
   * that order), and the check in `hear` moves on to another if the next notes fit it better.
   */
  private options(): Note[] {
    let options: (Note | undefined)[];
    if (this.reason === "stopped") {
      const li = this.lines.findIndex((l) => l.end >= this.stopFrom);
      options = [this.melody.find((n) => n.time + n.duration > this.stopFrom + 0.05), this.lines[li]?.notes[0], this.lines[li + 1]?.notes[0]];
    } else options = [this.lines[this.next]?.notes[0], this.lines[this.next - 1]?.notes[0]];
    return [...new Set(options.filter((n): n is Note => !!n))];
  }

  private closest(sung: number, options: Note[]): number {
    let best = options[0];
    let bestD = 1.5;
    for (const n of options) {
      const d = Math.abs(pcDiff(sung, n.midi));
      if (d < bestD - 0.25) {
        best = n;
        bestD = d;
      }
    }
    return best ? best.time : this.waitAt;
  }

  /** Share of [a, b] where the tune has a note to sing. */
  private coverage(a: number, b: number) {
    let covered = 0;
    for (const n of this.melody) {
      if (n.time >= b) break;
      covered += Math.max(0, Math.min(b, n.time + n.duration) - Math.max(a, n.time));
    }
    return covered / Math.max(1e-6, b - a);
  }

  /** Semitones the line was sung away from the written key, if clear enough to act on. */
  private keyShift(): number {
    if (!this.opts.key || this.diffs.length < 25) return 0;
    const m = median(this.diffs);
    const k = Math.round(m);
    if (k === 0 || Math.abs(k) > 5 || Math.abs(m - k) > 0.35) return 0;
    const close = this.diffs.filter((d) => Math.abs(d - k) <= 0.5).length / this.diffs.length;
    return close >= 0.65 ? k : 0;
  }

  /** Louder than the singer's usual level → louder piano, and softer → softer. */
  private loudness(voice: boolean, level: number, out: Action[]) {
    if (!this.opts.loudness) return;
    if (voice) {
      this.env = this.env ? this.env + (level - this.env) * 0.1 : level;
      this.refN++;
      this.ref = this.ref ? this.ref + (level - this.ref) * Math.max(0.005, 1 / this.refN) : level;
      if (this.refN >= 10) this.gain = Math.max(0.65, Math.min(1.3, (this.env / this.ref) ** 0.7));
    } else if (this.gap > 25) this.gain += (1 - this.gain) * 0.05;
    if (Math.abs(this.gain - this.sentGain) > 0.04) {
      this.sentGain = this.gain;
      out.push({ type: "loudness", gain: Math.round(this.gain * 100) / 100 });
    }
  }
}
