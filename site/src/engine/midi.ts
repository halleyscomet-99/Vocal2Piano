import { Midi } from "@tonejs/midi";
import type { Score } from "./score";
import type { Plan } from "./types";
import { I2C_ADDRESS } from "./robot";

export async function readMidiScore(file: File): Promise<Score> {
  const midi = new Midi(await file.arrayBuffer());
  const tracks = midi.tracks
    .filter((t) => t.notes.length > 0)
    .map((t, i) => ({
      name: t.name || t.instrument.name || `Track ${i + 1}`,
      drum: t.channel === 9 || t.instrument.percussion,
      notes: t.notes.map((n) => ({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity })),
    }));
  if (tracks.every((t) => t.drum)) throw new Error("No notes found in this MIDI file");
  return {
    name: file.name.replace(/\.(mid|midi)$/i, ""),
    bpm: Math.round(midi.header.tempos[0]?.bpm ?? 120),
    tracks,
  };
}

/** Performance file the firmware will consume (format v0, may change). */
export function exportPlan(plan: Plan, songName: string) {
  const ms = (s: number) => Math.round(s * 1000);
  const data = {
    format: "vocal2piano-performance",
    version: 0,
    song: songName,
    i2c: I2C_ADDRESS,
    start: plan.start,
    moves: plan.moves.map((m) => ({ carriage: m.carriage, t0: ms(m.t0), t1: ms(m.t1), to: m.to })),
    strikes: plan.strikes.map((s) => ({ carriage: s.carriage, channel: s.channel, t: ms(s.time), dur: ms(s.duration), pwm: s.pwm })),
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${songName.replace(/[^\w-]+/g, "_")}.performance.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
