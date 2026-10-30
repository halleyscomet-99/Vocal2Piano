// Humming a tune: four clicks, then the tune is hummed against the click while the meter
// shows what the microphone hears. On Done, the recording is transcribed and harmonized
// (engine/harmonize.ts).

import type { AudioEvent, Player } from "./audio";
import { transcribe } from "./engine/harmonize";
import type { Note } from "./engine/types";
import { type Mic, toAudioBuffer } from "./mic";
import { noteName } from "./engine/robot";

export interface HumView {
  phase: "countin" | "humming";
  beat: number; // beats since the first click
  /** The microphone right now: level 0..1, and the note it hears the voice on (null = no voice). */
  level: number;
  note: string | null;
  /** Seconds of humming heard so far. */
  heard: number;
}

const MIC_DELAY = 0.05;
const MAX_BARS = 120;

export class HumSession {
  private timer = 0;
  private stopPitch = () => {};
  private stopRec: () => ReturnType<ReturnType<Mic["record"]>> = () => ({ samples: new Float32Array(), sampleRate: 48000, t0: 0 });
  private levels: number[] = [];
  private level = 0;
  private note: string | null = null;
  private heard = 0;

  constructor(
    private player: Player,
    private mic: Mic,
    readonly bpm: number,
    private click: boolean,
    private onView: (v: HumView) => void,
  ) {}

  start() {
    const beat = 60 / this.bpm;
    const clicks: AudioEvent[] = [];
    for (let b = -4; b < (this.click ? MAX_BARS * 4 : 0); b++) {
      const accent = b % 4 === 0;
      // E6 on the first beat of a bar, A5 on the others; quieter once the humming starts.
      clicks.push({ midi: accent ? 88 : 81, time: b * beat, duration: 0.03, velocity: b < 0 ? 0.9 : 0.35, part: "click" });
    }
    this.player.play(clicks, -4 * beat - 0.1);
    this.stopRec = this.mic.record(() => this.player.heard);
    this.stopPitch = this.mic.pitch((midi, level) => {
      this.levels.push(level);
      if (this.levels.length > 75) this.levels.shift();
      const floor = Math.min(...this.levels);
      const voiced = midi !== null && level >= Math.max(0.1, 2.5 * floor);
      this.level = level;
      this.note = voiced ? noteName(Math.round(midi)) : null;
      if (voiced && this.player.heard - MIC_DELAY >= 0) this.heard += 0.04;
    }, 40);
    this.timer = window.setInterval(() => this.tick(), 40);
  }

  private tick() {
    const beat = 60 / this.bpm;
    const now = this.player.heard;
    this.onView({
      phase: now < 0 ? "countin" : "humming",
      beat: Math.floor(now / beat) + 4,
      level: this.level,
      note: this.note,
      heard: this.heard,
    });
  }

  /**
   * Stop now. `tune` transcribes the humming (slow, so call it after a repaint);
   * `audio` is the recording itself, to listen back to.
   */
  stop(): { tune: () => Note[]; audio: AudioBuffer } {
    clearInterval(this.timer);
    this.stopPitch();
    const cap = this.stopRec();
    this.player.stop();
    this.mic.close();
    // Bar 1 is song time 0, which is -t0 into the recording.
    return { tune: () => transcribe(cap.samples, cap.sampleRate, -cap.t0, this.bpm), audio: toAudioBuffer(cap) };
  }

  /** Stop without keeping anything. */
  cancel() {
    clearInterval(this.timer);
    this.stopPitch();
    this.stopRec();
    this.player.stop();
    this.mic.close();
  }
}
