import * as Tone from "tone";
import { CARRIAGES, type CarriageId, MAX_POS, moveTime } from "./engine/robot";
import type { Move, Strike } from "./engine/types";
import type { RobotLink } from "./robotLink";

export interface AudioEvent {
  midi: number;
  time: number;
  duration: number;
  velocity: number;
  /** "tune" = the sung melody, on its own volume ("tune" level); "click" = a metronome tick; otherwise the piano part. */
  part?: "tune" | "click";
}

/** A recording laid on the song clock: buffer time b plays at song time start + b / rate. */
export interface Track {
  id: string;
  buffer: AudioBuffer;
  rate: number;
  start: number;
}

/** What the real robot should play, streamed over USB as the song goes. */
export interface RobotOut {
  link: RobotLink;
  strikes: Strike[];
  moves: Move[];
  posAt: (c: CarriageId, t: number) => number;
}

export interface PlayOptions {
  tracks?: Track[];
  robot?: RobotOut;
  /** Also sound the piano notes already ringing at the start point (picking up mid-chord). */
  ring?: boolean;
  /**
   * The singer was heard at song time `time`, audio time `at`: start from wherever the singer
   * is by the time the piano can come in, so it lands together with the voice.
   */
  align?: { time: number; at: number };
}

type RobotEvent = { time: number; strike?: Strike; move?: Move };

const LOOKAHEAD = 0.25; // s of song scheduled ahead at fixed tempo
const ROBOT_LOOKAHEAD = 0.3; // serial commands go out a little earlier still
const LEAD_IN = 0.05;
const TOO_LATE = 0.2; // drop events we'd play more than this late

function salamanderUrls() {
  const urls: Record<string, string> = { A0: "A0.mp3", C8: "C8.mp3" };
  for (let o = 1; o <= 7; o++) {
    for (const [n, f] of [["C", "C"], ["D#", "Ds"], ["F#", "Fs"], ["A", "A"]]) urls[`${n}${o}`] = `${f}${o}.mp3`;
  }
  return urls;
}

const db = (g: number) => (g <= 0.001 ? -Infinity : 20 * Math.log10(g));
const raw = () => Tone.getContext().rawContext as unknown as AudioContext;
const latency = () => (raw().outputLatency || 0) + (raw().baseLatency || 0);

/** Piano, recordings and the robot on one clock, with our own lookahead scheduler so pause/seek are instant. */
export class Player {
  private sampler: Tone.Sampler | null = null;
  private synth: Tone.PolySynth | null = null;
  private pianoBus: Tone.Gain | null = null;
  private tune: Tone.Sampler | Tone.PolySynth | null = null; // plays the melody, on its own bus
  private tuneBus: Tone.Gain | null = null;
  private events: AudioEvent[] = [];
  private robotEvents: RobotEvent[] = [];
  private origin = 0; // context time of song t=0 (fixed tempo)
  private from = 0;
  private cursor = 0;
  private rcursor = 0;
  private timer: number | null = null;
  private robot: RobotOut | null = null;
  private tracks = new Map<string, { player: Tone.Player; buffer: AudioBuffer }>();
  private levels = new Map<string, number>();
  private click: Tone.Synth | null = null;
  private gate = Infinity; // nothing at or after this song time is scheduled
  private gain = 1; // piano loudness, following the voice
  private held: number | null = null; // song time we're stopped at, waiting for the singer
  ready = false;

  async init() {
    await Tone.start();
    if (this.sampler || this.synth) return;
    const reverb = new Tone.Reverb({ decay: 2.4, wet: 0.18 }).toDestination();
    this.pianoBus = new Tone.Gain(this.levels.get("piano") ?? 1).connect(reverb);
    const tuneBus = new Tone.Gain(this.levels.get("tune") ?? 0).connect(reverb);
    this.tuneBus = tuneBus;
    const sampler = (bus: Tone.Gain) =>
      new Promise<Tone.Sampler>((resolve, reject) => {
        const s: Tone.Sampler = new Tone.Sampler({
          urls: salamanderUrls(),
          baseUrl: "https://tonejs.github.io/audio/salamander/",
          release: 0.8,
          onload: () => resolve(s),
          onerror: reject,
        }).connect(bus);
      });
    try {
      [this.sampler, this.tune] = await Promise.all([sampler(this.pianoBus), sampler(tuneBus)]);
    } catch {
      this.sampler = null;
      this.synth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" } }).connect(this.pianoBus);
      this.synth.volume.value = -10;
      const tune = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" } }).connect(tuneBus);
      tune.volume.value = -10;
      this.tune = tune;
    }
    this.click = new Tone.Synth({ oscillator: { type: "sine" }, envelope: { attack: 0.002, decay: 0.04, sustain: 0, release: 0.01 } }).toDestination();
    this.click.volume.value = -8;
    this.ready = true;
  }

  /** Song time being heard right now (output latency included, so visuals match the speakers). */
  get now() {
    if (this.held !== null) return this.held;
    const t = raw().currentTime - latency();
    return Math.max(this.from, t - this.origin);
  }

  /** The audio clock (s). */
  get ctxTime() {
    return raw().currentTime;
  }

  /** Like `now` but not held at the start point during the lead-in; use it to timestamp recordings. */
  get heard() {
    return this.held ?? raw().currentTime - this.origin - latency();
  }

  /** Stopped at a point in the song, waiting for the singer. */
  get waiting() {
    return this.held !== null;
  }

  /** Don't play anything at or after song time t until the gate moves on (Infinity = no gate). */
  setGate(t: number) {
    this.gate = t;
  }

  /** Piano loudness, applied to notes as they are scheduled (1 = as written). */
  setGain(g: number) {
    this.gain = g;
  }

  /** Stop at song time t and wait, letting what is already sounding ring out. */
  hold(t: number) {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const { player } of this.tracks.values()) if (player.state === "started") player.stop();
    this.robot?.link.stop();
    this.held = t;
  }

  /** 0..1, applied live without rescheduling. "piano" and "tune" are the two piano buses, anything else a track id. */
  setLevel(id: string, g: number) {
    this.levels.set(id, g);
    if (id === "piano") this.pianoBus?.gain.rampTo(g, 0.03);
    else if (id === "tune") this.tuneBus?.gain.rampTo(g, 0.03);
    else this.tracks.get(id)?.player.volume.rampTo(db(g), 0.03);
  }

  play(events: AudioEvent[], from: number, o: PlayOptions = {}) {
    this.stop(!!o.ring);
    const ctxNow = raw().currentTime;
    let lead = LEAD_IN;

    this.robot = o.robot ?? null;
    if (this.robot) {
      // Restart the device clock, then send both carriages to where the song starts.
      const { link, posAt } = this.robot;
      const prepFor = (t: number) =>
        Math.max(0, ...CARRIAGES.map((c) => {
          const cur = link.pos[c];
          const target = Math.round(posAt(c, t));
          return cur === target ? 0 : moveTime(cur === undefined ? MAX_POS : Math.abs(target - cur));
        }));
      // Coming in with the singer: by the time the carriages are in place the singer is further on.
      if (o.align) from = o.align.time + ctxNow + Math.max(LEAD_IN, prepFor(o.align.time) + 0.1) + latency() - o.align.at;
      link.zero();
      for (const c of CARRIAGES) {
        const target = Math.round(posAt(c, from));
        if (link.pos[c] !== target) link.move(c, target, performance.now());
      }
      lead = Math.max(lead, prepFor(from) + 0.1);
      this.robotEvents = [
        ...this.robot.strikes.map((s) => ({ time: s.time, strike: s })),
        ...this.robot.moves.map((m) => ({ time: m.t0, move: m })),
      ].sort((a, b) => a.time - b.time);
    } else {
      this.robotEvents = [];
      if (o.align) from = o.align.time + ctxNow + lead + latency() - o.align.at;
    }

    this.from = from;
    this.origin = ctxNow - from + lead;
    for (const t of o.tracks ?? []) {
      let slot = this.tracks.get(t.id);
      if (!slot || slot.buffer !== t.buffer) {
        slot?.player.dispose();
        slot = { player: new Tone.Player(new Tone.ToneAudioBuffer(t.buffer)).toDestination(), buffer: t.buffer };
        this.tracks.set(t.id, slot);
      }
      const p = slot.player;
      p.volume.value = db(this.levels.get(t.id) ?? 1);
      p.playbackRate = t.rate;
      const offset = (from - t.start) * t.rate;
      if (offset >= t.buffer.duration) continue;
      if (offset >= 0) p.start(this.origin + from, offset);
      else p.start(this.origin + t.start, 0);
    }

    this.events = [...events].sort((a, b) => a.time - b.time);
    this.seekCursors(from);
    if (o.ring) this.ringOn(from);
    this.timer = window.setInterval(() => this.pump(), 50);
    this.pump();
  }

  /** Piano notes that started before `from` and are still meant to sound, struck at the start. */
  private ringOn(from: number) {
    const inst = this.sampler ?? this.synth;
    const at = this.origin + from;
    for (const e of this.events.slice(0, this.cursor)) {
      if (e.part || e.time + e.duration <= from + 0.15) continue;
      inst?.triggerAttackRelease(Tone.Frequency(e.midi, "midi").toNote(), e.time + e.duration - from, at, (0.25 + 0.75 * e.velocity) * 0.8 * this.gain);
    }
    if (!this.robot) return;
    const lat = latency();
    for (const s of this.robot.strikes) {
      if (s.time >= from || s.time + s.duration <= from + 0.15) continue;
      const moving = this.robot.moves.some((m) => m.carriage === s.carriage && m.t0 < from && m.t1 > from);
      if (moving) continue;
      const perf = performance.now() + (at - raw().currentTime + lat) * 1000;
      this.robot.link.strike(s.carriage, s.channel, perf, (s.time + s.duration - from) * 1000, s.pwm);
    }
  }

  /** Add notes while playing (live accompaniment). They must be later than what is already scheduled. */
  append(events: AudioEvent[], strikes: Strike[] = []) {
    this.events.push(...events);
    this.events.sort((a, b) => a.time - b.time);
    if (this.robot && strikes.length) {
      this.robotEvents.push(...strikes.map((s) => ({ time: s.time, strike: s })));
      this.robotEvents.sort((a, b) => a.time - b.time);
    }
  }

  private seekCursors(t: number) {
    const i = this.events.findIndex((e) => e.time >= t);
    this.cursor = i < 0 ? this.events.length : i;
    const j = this.robotEvents.findIndex((e) => e.time >= t);
    this.rcursor = j < 0 ? this.robotEvents.length : j;
  }

  private pump() {
    const ctxNow = raw().currentTime;
    const pos = ctxNow - this.origin;
    const audioAt = (t: number) => ctxNow + (t - pos);

    const inst = this.sampler ?? this.synth;
    const horizon = Math.min(pos + LOOKAHEAD, this.gate);
    while (inst && this.cursor < this.events.length && this.events[this.cursor].time < horizon) {
      const e = this.events[this.cursor++];
      const at = audioAt(e.time);
      if (at < ctxNow - TOO_LATE) continue;
      const when = Math.max(at, ctxNow + 0.005);
      if (e.part === "click") {
        this.click?.triggerAttackRelease(Tone.Frequency(e.midi, "midi").toFrequency(), 0.03, when, e.velocity);
        continue;
      }
      const note = Tone.Frequency(e.midi, "midi").toNote();
      const vel = 0.25 + 0.75 * Math.min(1, e.velocity * (e.part === "tune" ? 1 : this.gain));
      (e.part === "tune" ? (this.tune ?? inst) : inst).triggerAttackRelease(note, Math.max(0.05, e.duration), when, vel);
    }

    if (this.robot) {
      const rh = Math.min(pos + ROBOT_LOOKAHEAD, this.gate);
      const perfNow = performance.now();
      const lat = latency();
      while (this.rcursor < this.robotEvents.length && this.robotEvents[this.rcursor].time < rh) {
        const e = this.robotEvents[this.rcursor++];
        const at = audioAt(e.time);
        if (at < ctxNow - TOO_LATE) continue;
        // Same moment it is heard from the speakers.
        const perf = perfNow + (Math.max(at, ctxNow) - ctxNow + lat) * 1000;
        if (e.strike) {
          const v = Math.min(1, e.strike.velocity * this.gain);
          this.robot.link.strike(e.strike.carriage, e.strike.channel, perf, e.strike.duration * 1000, this.gain === 1 ? e.strike.pwm : Math.round(4095 * (0.6 + 0.4 * v)));
        }
        if (e.move) this.robot.link.move(e.move.carriage, e.move.to, perf);
      }
    }
  }

  /** `ring` lets notes already sounding finish (picking up again after a wait). */
  stop(ring = false) {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.held = null;
    for (const { player } of this.tracks.values()) if (player.state === "started") player.stop();
    if (!ring) {
      this.sampler?.releaseAll();
      this.synth?.releaseAll();
      this.tune?.releaseAll();
    }
    this.robot?.link.stop();
  }
}
