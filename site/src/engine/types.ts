import type { CarriageId } from "./robot";

export interface Note {
  midi: number;
  time: number; // s
  duration: number; // s
  velocity: number; // 0..1
  id?: string; // piano notes: which note this is, for editing single notes
}

export interface Song {
  name: string;
  bpm: number;
  notes: Note[]; // what the piano plays
  /** The sung tune. Not played by the robot; used to show what to sing and to check the pitch. */
  melody?: Note[];
}

export interface Strike {
  midi: number; // pitch actually played
  srcMidi: number; // pitch in the arrangement (differs when folded)
  time: number;
  duration: number;
  velocity: number;
  carriage: CarriageId;
  finger: string; // W1..W7, B1..B6
  channel: number; // PCA9685 channel
  pwm: number; // 12-bit strike duty
  folded: boolean;
  truncated: boolean;
  id?: string; // the arrangement note it plays
}

export interface Move {
  carriage: CarriageId;
  t0: number;
  t1: number;
  from: number;
  to: number;
}

export type WarningKind = "dropped" | "late-move" | "current" | "thinned" | "folded" | "hold";

export interface PlanWarning {
  kind: WarningKind;
  time: number;
  message: string;
  midi?: number;
}

export interface Plan {
  strikes: Strike[];
  moves: Move[];
  warnings: PlanWarning[];
  dropped: Note[];
  start: Record<CarriageId, number>;
  duration: number;
  stats: {
    notes: number;
    played: number;
    folded: number;
    dropped: number;
    moves: number;
    peakAmps: number;
  };
}
