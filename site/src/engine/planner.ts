// Playability planner: turns an ideal piano arrangement into what the robot can
// actually play — carriage positions over time, a finger for every note, and
// warnings for anything it had to drop, fold or shorten.

import {
  CARRIAGES,
  type CarriageId,
  KEY_HIGH,
  KEY_LOW,
  MAX_POS,
  ROBOT,
  WHITE_FINGERS,
  fingerFor,
  moveTime,
  noteName,
  pwmChannel,
} from "./robot";
import type { Move, Note, Plan, PlanWarning, Song, Strike } from "./types";

export interface PlanOptions {
  transpose: number; // semitones
  tempo: number; // playback speed multiplier
  split: number; // notes below this MIDI pitch go to the bass carriage
  fold: boolean; // shift unreachable notes by octaves instead of dropping them
  maxVoices: number; // per carriage per onset; 0 = no limit
}

export const DEFAULT_OPTIONS: PlanOptions = { transpose: 0, tempo: 1, split: 60, fold: true, maxVoices: 4 };

interface Slice {
  time: number;
  notes: Record<CarriageId, Note[]>;
}

const ONSET_EPS = 0.025;
const LATE_PENALTY = 1000;
const MISS_PENALTY = 20;
const FOLD_PENALTY = 3;

export function plan(song: Song, opts: PlanOptions): Plan {
  const warnings: PlanWarning[] = [];
  const dropped: Note[] = [];

  // 1. Transpose, change tempo, and pull out-of-range notes back onto the keyboard.
  const notes: Note[] = song.notes
    .map((n) => {
      let midi = n.midi + opts.transpose;
      while (midi < KEY_LOW) midi += 12;
      while (midi > KEY_HIGH) midi -= 12;
      return { ...n, midi, time: n.time / opts.tempo, duration: n.duration / opts.tempo };
    })
    .sort((a, b) => a.time - b.time || a.midi - b.midi);

  // 2. Group onsets into slices and split hands.
  const slices: Slice[] = [];
  for (const n of notes) {
    let s = slices[slices.length - 1];
    if (!s || n.time - s.time > ONSET_EPS) {
      s = { time: n.time, notes: { bass: [], treble: [] } };
      slices.push(s);
    }
    const hand = n.midi < opts.split ? "bass" : "treble";
    if (!s.notes[hand].some((m) => m.midi === n.midi)) s.notes[hand].push(n);
  }

  const total = slices.reduce((k, s) => k + s.notes.bass.length + s.notes.treble.length, 0);

  // 3. Thin thick chords: keep the outer voices, then fill from the top.
  if (opts.maxVoices > 0) {
    for (const s of slices) {
      for (const c of CARRIAGES) {
        const ns = s.notes[c];
        if (ns.length <= opts.maxVoices) continue;
        ns.sort((a, b) => a.midi - b.midi);
        const keep = [ns[0], ns[ns.length - 1], ...ns.slice(1, -1).reverse()].slice(0, opts.maxVoices);
        for (const n of ns) {
          if (keep.includes(n)) continue;
          warnings.push({ kind: "thinned", time: s.time, midi: n.midi, message: `${noteName(n.midi)} left out of a ${ns.length}-note chord` });
        }
        s.notes[c] = keep.sort((a, b) => a.midi - b.midi);
      }
    }
  }

  // 4. Carriage paths. Treble (usually the melody side) is planned first,
  //    then bass, which must stay at least one carriage-width to its left.
  const treblePath = solvePath(slices, "treble", opts.fold, WHITE_FINGERS, MAX_POS, null);
  const bassPath = solvePath(slices, "bass", opts.fold, 0, MAX_POS - WHITE_FINGERS, treblePath);
  const paths: Record<CarriageId, number[]> = { bass: bassPath, treble: treblePath };

  // 5. Give every note a finger, on either carriage, folding by octave if allowed.
  const strikes: Strike[] = [];
  for (let t = 0; t < slices.length; t++) {
    const s = slices[t];
    const used = new Set<number>();
    for (const own of CARRIAGES) {
      const other: CarriageId = own === "bass" ? "treble" : "bass";
      for (const n of s.notes[own]) {
        const target = assign(n.midi, [own, other], paths, t, used, opts.fold);
        if (!target) {
          dropped.push(n);
          warnings.push({ kind: "dropped", time: s.time, midi: n.midi, message: `${noteName(n.midi)} is out of reach of both carriages` });
          continue;
        }
        used.add(target.midi);
        const folded = target.midi !== n.midi;
        if (folded) {
          warnings.push({ kind: "folded", time: s.time, midi: n.midi, message: `${noteName(n.midi)} played an octave-shift away as ${noteName(target.midi)}` });
        }
        strikes.push({
          midi: target.midi,
          srcMidi: n.midi,
          time: s.time,
          duration: n.duration,
          velocity: n.velocity,
          carriage: target.carriage,
          finger: target.finger,
          channel: pwmChannel(target.carriage, target.finger),
          pwm: Math.round(4095 * (0.6 + 0.4 * n.velocity)),
          folded,
          truncated: false,
          id: n.id,
        });
      }
    }
  }

  // 6. Moves: start as late as possible so notes ring as long as they can.
  const moves: Move[] = [];
  for (const c of CARRIAGES) {
    const path = paths[c];
    for (let t = 1; t < slices.length; t++) {
      if (path[t] === path[t - 1]) continue;
      const t1 = slices[t].time;
      const t0 = t1 - moveTime(path[t] - path[t - 1]);
      moves.push({ carriage: c, t0, t1, from: path[t - 1], to: path[t] });
      const earliest = slices[t - 1].time + (slices[t - 1].notes[c].length ? ROBOT.minNoteLen : 0);
      if (t0 < earliest - 1e-6) {
        warnings.push({ kind: "late-move", time: t1, message: `${c} carriage needs ${Math.round((earliest - t0) * 1000)} ms more to reach its next position` });
      }
    }
  }
  moves.sort((a, b) => a.t0 - b.t0);

  // 7. Release fingers before their carriage moves, before a re-strike, and after maxHold.
  for (const c of CARRIAGES) {
    const mine = strikes.filter((s) => s.carriage === c);
    const starts = moves.filter((m) => m.carriage === c).map((m) => m.t0);
    for (let i = 0; i < mine.length; i++) {
      const s = mine[i];
      let end = s.time + s.duration;
      const nextMove = starts.find((t0) => t0 > s.time);
      if (nextMove !== undefined) end = Math.min(end, nextMove - 0.01);
      const again = mine.slice(i + 1).find((o) => o.finger === s.finger);
      if (again) end = Math.min(end, again.time - ROBOT.minRelease);
      if (end - s.time > ROBOT.maxHold) {
        end = s.time + ROBOT.maxHold;
        warnings.push({ kind: "hold", time: s.time, midi: s.midi, message: `${noteName(s.midi)} cut to ${ROBOT.maxHold} s to protect the solenoid` });
      }
      end = Math.max(end, s.time + 0.03);
      if (end < s.time + s.duration - 1e-6) s.truncated = true;
      s.duration = end - s.time;
    }
  }

  // 8. Current budget: full current during the strike, holdDuty afterwards.
  const edges: [number, number][] = [];
  for (const s of strikes) {
    const strikeEnd = Math.min(s.time + ROBOT.strikeTime, s.time + s.duration);
    edges.push([s.time, ROBOT.solenoidAmps], [strikeEnd, -ROBOT.solenoidAmps * (1 - ROBOT.holdDuty)]);
    edges.push([s.time + s.duration, -ROBOT.solenoidAmps * ROBOT.holdDuty]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let amps = 0;
  let peakAmps = 0;
  let overSince: number | null = null;
  let overPeak = 0;
  for (const [time, delta] of edges) {
    amps += delta;
    peakAmps = Math.max(peakAmps, amps);
    if (amps > ROBOT.solenoidBudgetAmps + 1e-6) {
      if (overSince === null) overSince = time;
      overPeak = Math.max(overPeak, amps);
    } else if (overSince !== null) {
      warnings.push({ kind: "current", time: overSince, message: `Solenoids draw ${overPeak.toFixed(1)} A, over the ${ROBOT.solenoidBudgetAmps} A budget` });
      overSince = null;
      overPeak = 0;
    }
  }

  warnings.sort((a, b) => a.time - b.time);
  const lastEnd = Math.max(0, ...notes.map((n) => n.time + n.duration));
  return {
    strikes: strikes.sort((a, b) => a.time - b.time),
    moves,
    warnings,
    dropped,
    start: { bass: bassPath[0] ?? 14, treble: treblePath[0] ?? 23 },
    duration: lastEnd,
    stats: {
      notes: total,
      played: strikes.length,
      folded: strikes.filter((s) => s.folded).length,
      dropped: dropped.length,
      moves: moves.length,
      peakAmps,
    },
  };
}

function reachCost(pos: number, notes: Note[], fold: boolean): number {
  let cost = 0;
  for (const n of notes) {
    if (fingerFor(pos, n.midi)) continue;
    cost += fold && (fingerFor(pos, n.midi + 12) || fingerFor(pos, n.midi - 12)) ? FOLD_PENALTY : MISS_PENALTY;
  }
  return cost;
}

/**
 * Viterbi over carriage positions. Moves that can't finish in time are allowed
 * at a large penalty (and reported later), so a path always exists.
 * `partner`, when given, is the treble path the bass carriage must stay left of.
 */
function solvePath(slices: Slice[], c: CarriageId, fold: boolean, lo: number, hi: number, partner: number[] | null): number[] {
  const n = slices.length;
  if (n === 0) return [];
  const P = hi - lo + 1;
  const ceiling = (t: number) => (partner ? Math.min(partner[t], partner[Math.max(0, t - 1)]) - WHITE_FINGERS : hi);
  const cost: Float64Array[] = [];
  const back: Int16Array[] = [];

  let prev = new Float64Array(P);
  for (let p = 0; p < P; p++) prev[p] = lo + p > ceiling(0) ? Infinity : reachCost(lo + p, slices[0].notes[c], fold);
  cost.push(prev);
  back.push(new Int16Array(P));

  for (let t = 1; t < n; t++) {
    const dt = slices[t].time - slices[t - 1].time - (slices[t - 1].notes[c].length ? ROBOT.minNoteLen : 0);
    const cur = new Float64Array(P).fill(Infinity);
    const bp = new Int16Array(P);
    const cap = ceiling(t);
    for (let p = 0; p < P; p++) {
      if (lo + p > cap) continue;
      const here = reachCost(lo + p, slices[t].notes[c], fold);
      let best = Infinity;
      let arg = 0;
      for (let q = 0; q < P; q++) {
        if (prev[q] === Infinity) continue;
        const d = Math.abs(p - q);
        let step = prev[q];
        if (d > 0) step += 0.5 + 0.02 * d + (moveTime(d) > dt ? LATE_PENALTY : 0);
        if (step < best) {
          best = step;
          arg = q;
        }
      }
      cur[p] = best + here;
      bp[p] = arg;
    }
    cost.push(cur);
    back.push(bp);
    prev = cur;
  }

  let p = 0;
  for (let i = 1; i < P; i++) if (prev[i] < prev[p]) p = i;
  const path = new Array<number>(n);
  for (let t = n - 1; t >= 0; t--) {
    path[t] = lo + p;
    p = back[t][p];
  }
  return path;
}

function assign(
  midi: number,
  order: CarriageId[],
  paths: Record<CarriageId, number[]>,
  t: number,
  used: Set<number>,
  fold: boolean,
): { carriage: CarriageId; finger: string; midi: number } | null {
  const candidates = fold ? [midi, midi - 12, midi + 12, midi - 24, midi + 24] : [midi];
  for (const m of candidates) {
    if (used.has(m)) continue;
    for (const c of order) {
      const finger = fingerFor(paths[c][t], m);
      if (finger) return { carriage: c, finger, midi: m };
    }
  }
  return null;
}

/** Interpolated carriage position (in white keys) at time t. */
export function carriagePosAt(p: Plan, c: CarriageId, t: number): number {
  let pos = p.start[c];
  for (const m of p.moves) {
    if (m.carriage !== c || m.t0 > t) continue;
    if (t >= m.t1) {
      pos = m.to;
      continue;
    }
    const k = (t - m.t0) / (m.t1 - m.t0);
    const e = k * k * (3 - 2 * k);
    return m.from + (m.to - m.from) * e;
  }
  return pos;
}
