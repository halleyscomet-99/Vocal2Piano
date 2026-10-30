// Robot geometry and hardware limits.
// Values marked "estimate" have not been measured on the real robot yet.

export type CarriageId = "bass" | "treble";
export const CARRIAGES: CarriageId[] = ["bass", "treble"];

export const KEY_LOW = 21; // A0
export const KEY_HIGH = 108; // C8
export const WHITE_KEY_MM = 23.5;

export const WHITE_FINGERS = 7;
export const BLACK_FINGERS = 6;

export const ROBOT = {
  // Same as the firmware's SPEED_LIMIT_MM and ACCEL_LIMIT_MM (firmware/src/config.h); raise both
  // together once the motors are tested faster.
  carriageSpeedMm: 100, // mm/s
  carriageAccelMm: 1000, // mm/s²
  settle: 0.02, // s, settle time after a move
  minNoteLen: 0.06, // s, shortest strike before a carriage may leave
  minRelease: 0.03, // s, finger must be up this long before re-striking
  maxHold: 2.0, // s, JF-1039(B) should not stay energized longer
  strikeTime: 0.05, // s at full duty, then drops to holdDuty
  holdDuty: 0.35, // estimate: PWM duty that still holds the plunger down
  solenoidAmps: 0.4,
  solenoidBudgetAmps: 4.0, // 5 A supply minus motors + logic (estimate)
};

export const isBlack = (midi: number) => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);

export const WHITE_KEYS: number[] = [];
for (let m = KEY_LOW; m <= KEY_HIGH; m++) if (!isBlack(m)) WHITE_KEYS.push(m);
const whiteIndex = new Map(WHITE_KEYS.map((m, i) => [m, i]));

/** Carriage position = white-key index under finger W1. */
export const MAX_POS = WHITE_KEYS.length - WHITE_FINGERS;

export const whiteIndexOf = (midi: number) => whiteIndex.get(midi);

/** Which finger of a carriage at `pos` can play `midi`, or null. */
export function fingerFor(pos: number, midi: number): string | null {
  if (midi < KEY_LOW || midi > KEY_HIGH) return null;
  if (!isBlack(midi)) {
    const i = whiteIndex.get(midi)! - pos;
    return i >= 0 && i < WHITE_FINGERS ? `W${i + 1}` : null;
  }
  // Black finger Bn sits in the gap between Wn and Wn+1.
  const i = whiteIndex.get(midi - 1)! - pos;
  return i >= 0 && i < BLACK_FINGERS ? `B${i + 1}` : null;
}

/** MIDI note under each finger slot; black slots over an E–F / B–C gap are null. */
export function fingerKeys(pos: number) {
  const white = Array.from({ length: WHITE_FINGERS }, (_, i) => WHITE_KEYS[pos + i]);
  const black = Array.from({ length: BLACK_FINGERS }, (_, i) => {
    const m = WHITE_KEYS[pos + i] + 1;
    return isBlack(m) ? m : null;
  });
  return { white, black };
}

/** PCA9685 channel per finger, as measured on the real boards (see hardware/PCB/README.md). */
export function pwmChannel(carriage: CarriageId, finger: string): number {
  const n = Number(finger.slice(1));
  const white = finger[0] === "W";
  if (carriage === "treble") return white ? n - 1 : 6 + n;
  return white ? 7 - n : 13 - n;
}

export const I2C_ADDRESS: Record<CarriageId, number> = { treble: 0x41, bass: 0x40 };

/** Seconds to move a carriage `whiteKeys` positions (trapezoid profile + settle). */
export function moveTime(whiteKeys: number): number {
  const d = Math.abs(whiteKeys) * WHITE_KEY_MM;
  if (d === 0) return 0;
  const v = ROBOT.carriageSpeedMm;
  const a = ROBOT.carriageAccelMm;
  const t = d < (v * v) / a ? 2 * Math.sqrt(d / a) : d / v + v / a;
  return t + ROBOT.settle;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (midi: number) => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
