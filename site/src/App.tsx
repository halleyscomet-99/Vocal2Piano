import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player, type AudioEvent, type PlayOptions, type RobotOut, type Track } from "./audio";
import { type ChordChart, PROGRESSIONS, type Style, arrangeChart, progressionChart } from "./engine/arranger";
import { DEFAULT_MELODY_WEIGHT, type Harmonized, harmonize } from "./engine/harmonize";
import { type Action, DEFAULT_LISTEN, type ListenOptions, Listener } from "./engine/listen";
import { exportPlan, readMidiScore } from "./engine/midi";
import { readMusicXml } from "./engine/musicxml";
import { type BarEdit, type BarEdits, type NoteEdit, type NoteEdits, barLength, editSong, isPlain, restyler } from "./engine/parts";
import { type SungFrame, checkFrames, checkPitch } from "./engine/pitchCheck";
import { DEFAULT_OPTIONS, type PlanOptions, carriagePosAt, plan as makePlan } from "./engine/planner";
import { noteName } from "./engine/robot";
import { type Role, type Score, type ScoreSongOptions, guessRoles, songFromScore } from "./engine/score";
import type { Note, Song } from "./engine/types";
import { type VoiceProfile, melodyCenter, suggestTranspose } from "./engine/voice";
import { type Mic, openMic, toAudioBuffer } from "./mic";
import { type HumView, HumSession } from "./humSession";
import { RobotLink } from "./robotLink";
import { applyScheme, loadScheme } from "./themes";
import { ChordsWindow } from "./components/ChordsWindow";
import { type AppEntry, DesktopIcons, Taskbar, Window, type WinState, useWindows } from "./components/Desktop";
import type { IconName } from "./components/Icons";
import { PartBar } from "./components/PartBar";
import { RobotWindow } from "./components/RobotWindow";
import { MessageBox, ReportWindow, SettingsWindow, WelcomeWindow } from "./components/SmallWindows";
import { type LocalDemo, type SourceKind, SongsWindow } from "./components/SongsWindow";
import { Stage } from "./components/Stage";
import { TrackView } from "./components/TrackView";
import { VoiceWindow, loadProfile } from "./components/VoiceWindow";

const fmt = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, "0")}`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** s from a sound reaching the microphone to its pitch reading (analysis window and input latency). */
const MIC_DELAY = 0.05;

/** What the listening piano is doing, for the status bar. */
interface Ear {
  voiced: boolean;
  waiting: "entrance" | "stopped" | null;
}
type Monitor = "robot" | "source";
type WinId = "welcome" | "songs" | "chords" | "voice" | "player" | "robot" | "report" | "settings" | "msg";

/** The take, placed on the song clock: `start` is in song seconds at the tempo it was recorded at. */
interface Take {
  buffer: AudioBuffer;
  start: number;
  tempo: number;
  nudge: number;
}

const APPS: (AppEntry & { id: WinId })[] = [
  { id: "songs", label: "Songs", icon: "songs" },
  { id: "voice", label: "My Voice", icon: "mic" },
  { id: "player", label: "Rehearsal", icon: "player" },
  { id: "chords", label: "Chords", icon: "chords" },
  { id: "report", label: "How I Sang", icon: "report" },
  { id: "robot", label: "Robot", icon: "robot" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "welcome", label: "Help", icon: "help" },
];
const TITLE: Record<WinId, [string, IconName]> = {
  welcome: ["Welcome", "help"],
  songs: ["Songs", "songs"],
  chords: ["Chords", "chords"],
  voice: ["My Voice", "mic"],
  player: ["Rehearsal", "player"],
  robot: ["Robot", "robot"],
  report: ["How I Sang", "report"],
  settings: ["Settings", "settings"],
  msg: ["Vocal2Piano", "warn"],
};

function firstVisit() {
  try {
    if (localStorage.getItem("v2p.seen")) return false;
    localStorage.setItem("v2p.seen", "1");
  } catch {
    /* storage unavailable: show the welcome every time */
  }
  return true;
}

const FIRST_VISIT = firstVisit();

function initialWindows(): Record<WinId, WinState> {
  const W = window.innerWidth;
  const H = window.innerHeight - 30;
  const wide = W >= 1200;
  const side = 96;
  const w = (x: number, y: number, width: number, open = false, z = 1, h?: number): WinState => ({ open, min: false, max: false, z, x, y, w: width, h });
  return {
    player: w(wide ? 500 : side, 8, wide ? W - 508 : Math.min(W - side - 8, 960), true, 1, H - 16),
    songs: w(side, 8, 392, true, 3),
    voice: w(side, 400, 392, true, 2),
    chords: w(side + 30, 60, 380),
    robot: w(Math.max(side, W - 480), 50, 450),
    report: w(Math.max(side, W / 2 - 220), 70, 440),
    settings: w(side + 60, 110, 330),
    welcome: w(Math.max(0, W / 2 - 190), Math.max(0, H / 2 - 170), 380, FIRST_VISIT, 5),
    msg: w(Math.max(0, W / 2 - 170), Math.max(0, H / 2 - 80), 340),
  };
}

function wavBlob(buffer: AudioBuffer) {
  const data = buffer.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + data.length * 2));
  const str = (o: number, t: string) => [...t].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + data.length * 2, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, data.length * 2, true);
  data.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([out], { type: "audio/wav" });
}

function Spin({ value, onDec, onInc, name }: { value: string; onDec: () => void; onInc: () => void; name: string }) {
  return (
    <span className="spin" title={name}>
      <button className="btn" onClick={onDec} aria-label={`${name} down`}>
        −
      </button>
      <output className="sunken">{value}</output>
      <button className="btn" onClick={onInc} aria-label={`${name} up`}>
        +
      </button>
    </span>
  );
}

export default function App() {
  const wm = useWindows<WinId>(initialWindows);
  const [kind, setKind] = useState<SourceKind>("demo");
  const [score, setScore] = useState<Score | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [scoreOpts, setScoreOpts] = useState<ScoreSongOptions>({ topLine: true, guide: false });
  const [prog, setProg] = useState(PROGRESSIONS[0].id);
  const [demoChart, setDemoChart] = useState<ChordChart>(() => progressionChart(PROGRESSIONS[0].id));
  const [hum, setHum] = useState<{ base: Harmonized; chart: ChordChart; notes: Note[]; bpm: number } | null>(null);
  const [humWeight, setHumWeight] = useState(DEFAULT_MELODY_WEIGHT);
  const [style, setStyle] = useState<Style>("block");
  const [flourish, setFlourish] = useState(1);
  const [opts, setOpts] = useState<PlanOptions>(DEFAULT_OPTIONS);
  const [monitor, setMonitor] = useState<Monitor>("robot");
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clock, setClock] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceProfile | null>(loadProfile);
  const [take, setTake] = useState<Take | null>(null);
  const [recording, setRecording] = useState(false);
  const [levels, setLevels] = useState<Record<string, number>>({ piano: 1, take: 1, tune: 0 });
  const [edits, setEdits] = useState<BarEdits>({});
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [noteEdits, setNoteEdits] = useState<NoteEdits>({});
  const [picked, setPicked] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [listenOpts, setListenOpts] = useState<ListenOptions>(DEFAULT_LISTEN);
  const [ear, setEar] = useState<Ear>({ voiced: false, waiting: null });
  const [earNote, setEarNote] = useState<string | null>(null);
  const [liveRev, setLiveRev] = useState(0);
  const [humView, setHumView] = useState<HumView | "working" | null>(null);
  const [humAudio, setHumAudio] = useState<string | null>(null); // the last humming, as a .wav URL
  const [robotLive, setRobotLive] = useState(false);
  const [scheme, setScheme] = useState(loadScheme);
  const [, setLinkTick] = useState(0);

  const player = useRef(new Player());
  const link = useRef(new RobotLink());
  const takeSession = useRef<{ mic: Mic; stop: () => ReturnType<ReturnType<Mic["record"]>> } | null>(null);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const listener = useRef<Listener | null>(null);
  // What was sung with Listen on: original song time and pitch in the song's own key, so it
  // stays put when the key or speed changes; `liveView` is the same on the rehearsal clock.
  const live = useRef<SungFrame[]>([]);
  const liveView = useRef<SungFrame[]>([]);

  const { focus } = wm;
  const say = useCallback(
    (m: string) => {
      setMessage(m);
      focus("msg");
    },
    [focus],
  );

  useEffect(() => {
    link.current.onChange = () => setLinkTick((n) => n + 1);
  }, []);

  // Local demo files in site/local/ (dev server only, never published).
  const [localDemos, setLocalDemos] = useState<LocalDemo[]>([]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch("local/demos.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: LocalDemo[]) => setLocalDemos(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  // ---------- What's playing ----------

  const chart = kind === "hum" && hum ? hum.chart : demoChart;
  const usesChart = kind === "demo" || (kind === "hum" && !!hum);
  const base = useMemo<Song>(
    () => (kind === "file" && score ? songFromScore(score, roles, scoreOpts) : arrangeChart(chart, style, flourish)),
    [kind, score, roles, scoreOpts, chart, style, flourish],
  );
  // Changes to single parts (speed, style, cuts) on top of the whole-song settings.
  const edited = useMemo(
    () => editSong(base, edits, noteEdits, restyler(base, kind === "file" ? null : chart, flourish)),
    [base, edits, noteEdits, kind, chart, flourish],
  );
  const song = edited.song;
  // Rehearsal clock ↔ original song time, so the current place survives speed and part changes.
  const timeline = useMemo(
    () => ({ toOrig: (t: number) => edited.toOrig(t * opts.tempo), toPerf: (t: number) => edited.toPerf(t) / opts.tempo }),
    [edited, opts.tempo],
  );
  const bars = useMemo(() => edited.marks.map((m) => ({ ...m, time: m.time / opts.tempo, end: m.end / opts.tempo })), [edited, opts.tempo]);

  // A new song starts with no part changes.
  useEffect(() => {
    setEdits({});
    setSel(null);
    setNoteEdits({});
    setPicked(null);
  }, [kind, score, prog, hum?.notes]);
  // Left-out notes, drawn as outlines on the timeline so a click brings them back.
  const muted = useMemo(
    () => edited.muted.map((n) => ({ ...n, midi: n.midi + opts.transpose, time: n.time / opts.tempo, duration: n.duration / opts.tempo })),
    [edited, opts.transpose, opts.tempo],
  );

  const plan = useMemo(() => makePlan(song, opts), [song, opts]);

  // The tune on the performance clock: tempo and key applied, like the plan.
  const melody = useMemo<Note[] | undefined>(
    () =>
      song.melody
        ?.map((n) => ({ ...n, midi: n.midi + opts.transpose, time: n.time / opts.tempo, duration: n.duration / opts.tempo }))
        .sort((a, b) => a.time - b.time),
    [song, opts.transpose, opts.tempo],
  );

  const suggestion = useMemo(() => {
    if (!voice) return null;
    if (base.melody?.length) return suggestTranspose(voice, { melodyCenter: median(base.melody.map((n) => n.midi)) });
    if (kind === "file") return suggestTranspose(voice, { melodyCenter: melodyCenter(base.notes, opts.split) });
    return suggestTranspose(voice, { tonic: chart.tonic ?? 0 });
  }, [voice, kind, base, opts.split, chart]);

  // The piano part, plus the tune on its own volume (silent unless "Play" is on in My tune).
  const events = useMemo<AudioEvent[]>(
    () => [
      ...(monitor === "robot"
        ? plan.strikes
        : song.notes.map((n) => ({ ...n, midi: n.midi + opts.transpose, time: n.time / opts.tempo, duration: n.duration / opts.tempo }))),
      ...(melody ?? []).map((n) => ({ ...n, velocity: 0.8, part: "tune" as const })),
    ],
    [monitor, plan, song, opts.transpose, opts.tempo, melody],
  );

  // The recording on the song clock. Tempo changes speed it up or slow it down (pitch follows).
  const takeTrack = useMemo<Track | null>(
    () => (take ? { id: "take", buffer: take.buffer, rate: opts.tempo / take.tempo, start: ((take.start + take.nudge) * take.tempo) / opts.tempo } : null),
    [take, opts.tempo],
  );
  const tracks = useMemo(() => (takeTrack ? [takeTrack] : []), [takeTrack]);
  const total = Math.max(plan.duration, ...tracks.map((t) => t.start + t.buffer.duration / t.rate));
  // Singing heard live, on the rehearsal clock.
  useEffect(() => {
    liveView.current = live.current.map((f) => ({ t: timeline.toPerf(f.t), midi: f.midi + opts.transpose }));
  }, [timeline, opts.transpose, liveRev]);
  const report = useMemo(() => {
    if (!melody?.length) return null;
    if (takeTrack) return checkPitch(takeTrack.buffer, takeTrack.start, takeTrack.rate, melody);
    const fr = live.current.map((f) => ({ t: timeline.toPerf(f.t), midi: f.midi + opts.transpose })).sort((a, b) => a.t - b.t);
    return fr.length >= 25 ? checkFrames(fr, fr[0].t, fr[fr.length - 1].t, melody) : null;
    // liveRev: a run with Listen on has ended (live is a ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeTrack, melody, liveRev, timeline, opts.transpose]);

  const linkUp = link.current.status === "connected";
  const robotOut = useMemo<RobotOut | undefined>(
    () => (robotLive && linkUp ? { link: link.current, strikes: plan.strikes, moves: plan.moves, posAt: (c, t) => carriagePosAt(plan, c, t) } : undefined),
    [robotLive, linkUp, plan],
  );

  // ---------- Transport ----------

  // Levels apply live; the old recording stays silent while a new one is recorded.
  useEffect(() => {
    for (const [id, g] of Object.entries(levels)) player.current.setLevel(id, id === "take" && recording ? 0 : g);
  }, [levels, recording]);

  const getTime = useCallback(() => (playingRef.current ? player.current.now : timeRef.current), []);

  const applyRef = useRef<(as: Action[]) => void>(() => {});
  const startAt = useCallback(
    (t: number, extra: PlayOptions = {}) => {
      player.current.play(events, t, { tracks, robot: robotOut, ...extra });
      // Starting (not picking up with the singer): the listener aims at the next line from here.
      if (!extra.align && listener.current) applyRef.current(listener.current.reset(t));
    },
    [events, tracks, robotOut],
  );

  const seek = useCallback(
    (t: number) => {
      timeRef.current = Math.max(0, t);
      if (playingRef.current) startAt(timeRef.current);
      setClock(timeRef.current);
    },
    [startAt],
  );

  const pause = useCallback(() => {
    timeRef.current = player.current.now;
    player.current.stop();
    playingRef.current = false;
    setPlaying(false);
    if (listener.current) setLiveRev((n) => n + 1);
  }, []);

  const play = useCallback(async () => {
    if (humSession.current) return; // the Hum tab has the piano until Done
    if (!player.current.ready) {
      setLoading(true);
      await player.current.init();
      setLoading(false);
    }
    if (timeRef.current >= total) timeRef.current = 0;
    // Singing again from here replaces what was heard from here on.
    const from = timeline.toOrig(timeRef.current);
    live.current = live.current.filter((f) => f.t < from);
    startAt(timeRef.current);
    playingRef.current = true;
    setPlaying(true);
  }, [startAt, total, timeline]);

  // Re-schedule whenever what we hear changes mid-play, staying at the same place in the
  // song when the speed or a part's length changed.
  const prevTimeline = useRef(timeline);
  useEffect(() => {
    const prev = prevTimeline.current;
    prevTimeline.current = timeline;
    const now = playingRef.current ? player.current.now : timeRef.current;
    const t = prev === timeline ? now : Math.max(0, timeline.toPerf(prev.toOrig(now)));
    timeRef.current = t;
    setClock(t);
    // Waiting for the singer: picking up again uses the new notes.
    if (playingRef.current && !player.current.waiting) startAt(t);
  }, [startAt, timeline]);

  // Clock readout, auto-stop at the end.
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = getTime();
      setClock(t);
      if (playingRef.current && t > total + 1 && !takeSession.current) {
        pause();
        timeRef.current = 0;
      }
    }, 100);
    return () => clearInterval(id);
  }, [getTime, pause, total]);

  const set = <K extends keyof PlanOptions>(k: K, v: PlanOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const keyUp = (d: number) => set("transpose", Math.max(-12, Math.min(12, opts.transpose + d)));
  const speedUp = (d: number) => set("tempo", Math.max(0.5, Math.min(1.5, Math.round((opts.tempo + d) * 100) / 100)));

  // ---------- Listening: the piano reacts to the voice as it plays ----------

  // While recording, the piano keeps time (the recording is one continuous take).
  const earOpts = useMemo(() => ({ ...listenOpts, wait: listenOpts.wait && !recording }), [listenOpts, recording]);
  const beatNow = 60 / song.bpm / opts.tempo;
  useEffect(() => {
    const L = listener.current;
    if (!L) return;
    L.setSong(melody ?? [], plan.strikes, beatNow);
    L.opts = earOpts;
    if (!earOpts.wait) player.current.setGate(Infinity);
    if (!earOpts.loudness) player.current.setGain(1);
  }, [melody, plan, beatNow, earOpts]);

  applyRef.current = (acts) => {
    const p = player.current;
    for (const a of acts) {
      if (a.type === "gate") p.setGate(a.time);
      else if (a.type === "loudness") p.setGain(a.gain);
      else if (a.type === "hold") {
        p.hold(a.time);
        timeRef.current = a.time;
      } else if (a.type === "resume") startAt(a.time, { ring: true, align: { time: a.time, at: a.at } });
      else if (a.type === "key") {
        keyUp(a.shift);
        setEarNote(`Moved to the sung key (${a.shift > 0 ? "+" : "−"}${Math.abs(a.shift)})`);
      }
    }
  };
  const onFrame = useRef<(midi: number | null, level: number) => void>(() => {});
  onFrame.current = (midi, level) => {
    const L = listener.current;
    if (!L) return;
    const p = player.current;
    if (playingRef.current) {
      const t = p.heard - MIC_DELAY;
      applyRef.current(L.hear({ t, at: p.ctxTime - MIC_DELAY, midi, level }));
      if (L.voiced && L.state === "playing" && !p.waiting) {
        live.current.push({ t: timeline.toOrig(t), midi: midi! - opts.transpose });
        liveView.current.push({ t, midi: midi! });
      }
    } else L.voiced = midi !== null && level > 0.1;
    const next: Ear = { voiced: L.voiced, waiting: playingRef.current && p.waiting ? L.reason : null };
    setEar((e) => (e.voiced === next.voiced && e.waiting === next.waiting ? e : next));
  };
  useEffect(() => {
    if (!earNote) return;
    const id = window.setTimeout(() => setEarNote(null), 5000);
    return () => clearTimeout(id);
  }, [earNote]);
  useEffect(() => {
    if (!listening) return;
    const p = player.current;
    listener.current = new Listener(earOpts, melody ?? [], plan.strikes, beatNow);
    if (playingRef.current) applyRef.current(listener.current.reset(p.now));
    let mic: Mic | null = null;
    let stop = () => {};
    let gone = false;
    // Echo cancellation keeps the speakers out of what we hear.
    openMic(true)
      .then((m) => {
        if (gone) return m.close();
        mic = m;
        stop = m.pitch((midi, level) => onFrame.current(midi, level), 40);
      })
      .catch((e: Error) => {
        say(e.message);
        setListening(false);
      });
    return () => {
      gone = true;
      stop();
      mic?.close();
      listener.current = null;
      p.setGate(Infinity);
      p.setGain(1);
      // Stopped while waiting for the singer: carry on from there.
      if (playingRef.current && p.waiting) startAtRef.current(p.now);
      setEar({ voiced: false, waiting: null });
      setLiveRev((n) => n + 1);
    };
    // Only when Listen is turned on or off; the effect above keeps it up to date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, say]);
  const startAtRef = useRef(startAt);
  startAtRef.current = startAt;
  /** Stop waiting for the singer and carry on. */
  const goOn = () => startAt(player.current.now);

  const goOnRef = useRef(goOn);
  goOnRef.current = goOn;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const toggleMute = useRef(() => {});
  toggleMute.current = () => changeNote({ mute: !noteEdits[picked!]?.mute });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (playingRef.current && player.current.waiting) goOnRef.current();
        else playingRef.current ? pause() : play();
      } else if (e.code === "Home") seek(0);
      else if ((e.code === "Delete" || e.code === "Backspace") && pickedRef.current) toggleMute.current();
      else if (e.code === "Escape") {
        setPicked(null);
        setSel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play, pause, seek]);

  // ---------- Sources ----------

  const humSession = useRef<HumSession | null>(null);
  const resetTo = (k: SourceKind) => {
    humSession.current?.cancel();
    humSession.current = null;
    setHumView(null);
    pause();
    timeRef.current = 0;
    setClock(0);
    setKind(k);
  };

  const loadScore = async (file: File, name?: string) => {
    try {
      const s = /\.(mid|midi)$/i.test(file.name) ? await readMidiScore(file) : await readMusicXml(file);
      if (name) s.name = name;
      setScore(s);
      setRoles(guessRoles(s));
      resetTo("file");
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };

  const onLocalDemo = async (d: LocalDemo) => {
    try {
      const r = await fetch(`local/${d.file}`);
      if (!r.ok) throw new Error(`Couldn't open local/${d.file}`);
      // A piano accompaniment: the robot plays all of it, and the singer brings the tune.
      setScoreOpts((o) => ({ ...o, topLine: false }));
      await loadScore(new File([await r.blob()], d.file), d.name);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };

  const onHummed = (notes: Note[], bpm: number) => {
    const h = harmonize(notes, bpm, humWeight);
    setHum({ base: h, chart: h.chart, notes, bpm });
    resetTo("hum");
  };
  const startHum = async (bpm: number, click: boolean) => {
    pause();
    let mic: Mic;
    try {
      mic = await openMic(true);
    } catch (e) {
      return say((e as Error).message);
    }
    if (!player.current.ready) {
      setLoading(true);
      await player.current.init();
      setLoading(false);
    }
    const s = new HumSession(player.current, mic, bpm, click, setHumView);
    humSession.current = s;
    s.start();
  };
  const stopHum = () => {
    const s = humSession.current;
    if (!s) return;
    humSession.current = null;
    setHumView("working");
    const { tune, audio } = s.stop();
    setHumAudio((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(wavBlob(audio));
    });
    setTimeout(() => {
      const notes = tune();
      setHumView(null);
      if (notes.length < 3) say('I couldn\'t hear a tune. Hum or sing on "la" a little louder.');
      else onHummed(notes, s.bpm);
    }, 30);
  };
  useEffect(() => () => humSession.current?.cancel(), []);

  const onHumWeight = (w: number) => {
    setHumWeight(w);
    if (!hum) return;
    const h = harmonize(hum.notes, hum.bpm, w);
    setHum({ ...hum, base: h, chart: { ...h.chart, intro: hum.chart.intro, outro: hum.chart.outro } });
  };

  // ---------- Recording ----------

  const startTake = async () => {
    let mic: Mic;
    try {
      // Echo cancellation keeps the piano coming out of the speakers off the recording.
      mic = await openMic(true);
    } catch (e) {
      return say((e as Error).message);
    }
    setRecording(true);
    if (!playingRef.current) await play();
    takeSession.current = { mic, stop: mic.record(() => (playingRef.current ? player.current.heard : timeRef.current)) };
  };

  const stopTake = () => {
    const s = takeSession.current;
    takeSession.current = null;
    setRecording(false);
    pause();
    if (!s) return;
    const cap = s.stop();
    s.mic.close();
    if (cap.samples.length < cap.sampleRate) return;
    setTake({ buffer: toAudioBuffer(cap), start: cap.t0, tempo: opts.tempo, nudge: 0 });
    if (melody?.length) wm.focus("report");
  };

  const nudge = (ms: number) => setTake((t) => (t ? { ...t, nudge: Math.round((t.nudge + ms / 1000) * 1000) / 1000 } : t));
  const downloadTake = () => {
    if (!take) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(wavBlob(take.buffer));
    a.download = `${song.name} recording.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const setLevel = useCallback((id: string, g: number) => setLevels((l) => ({ ...l, [id]: g })), []);

  // ---------- View ----------

  const openApp = (id: string) => {
    if (id === "report" && !report) return say("Sing a song with a tune first: turn on 👂 Listen or ● Rec in Rehearsal.");
    if (id === "chords" && !usesChart) return say("Chords can be edited for hummed tunes and demos. Pick one in Songs.");
    wm.focus(id as WinId);
  };

  const playable = plan.stats.notes ? Math.round((plan.stats.played / plan.stats.notes) * 100) : 100;
  const melodyName = kind === "file" && score ? score.tracks.find((_, i) => roles[i] === "melody")?.name : undefined;
  const caption =
    kind === "file" && score
      ? melodyName
        ? `white outlines = sung part (${melodyName})`
        : song.melody
          ? "white outlines = sung part (top line)"
          : "robot plays everything"
      : kind === "hum" && hum
        ? `${hum.base.key} · hummed tune`
        : kind === "demo"
          ? PROGRESSIONS.find((p) => p.id === prog)!.chords.join(" – ")
          : "demo (nothing loaded yet)";
  const status = ear.waiting
    ? ear.waiting === "entrance"
      ? "👂 Waiting for the voice to come in. Sing, or press ▶ Go on."
      : "👂 Singing stopped. Sing to go on: from that note, the start of the line, or the next line."
    : earNote
      ? `👂 ${earNote}`
      : recording
        ? `● Recording… press ■ Stop when done${listening ? " (the piano keeps time while recording)" : ""}`
        : listening
          ? `👂 Listening${ear.voiced ? " · hearing a voice" : ""}${melody?.length ? "" : " · no tune here, so it only follows the loudness"}`
          : "Space = play · drag the tracks to scrub";

  // Part editing: what the picked bars share, and changes applied to all of them.
  const changePart = (patch: BarEdit | null) => {
    if (!sel) return;
    setEdits((e) => {
      const next = { ...e };
      for (let k = sel[0]; k <= sel[1]; k++) {
        const v = patch ? { ...next[k], ...patch } : undefined;
        if (isPlain(v)) delete next[k];
        else next[k] = v!;
      }
      return next;
    });
    if (patch?.cut) setSel(null);
  };
  const pickBars = (s: [number, number] | null) => {
    setSel(s);
    if (s) setPicked(null);
  };
  const pickNote = (id: string | null) => {
    setPicked(id);
    if (id) setSel(null);
  };
  const changeNote = (patch: NoteEdit | null) => {
    if (!picked) return;
    setNoteEdits((e) => {
      const next = { ...e };
      const v = patch ? { ...next[picked], ...patch } : undefined;
      if (!v || (!v.mute && v.duration === undefined)) delete next[picked];
      else next[picked] = v;
      return next;
    });
  };
  const pickedNote = picked ? edited.source.get(picked) : undefined;
  const beat = barLength(base.bpm) / 4;
  const noteInfo = pickedNote && {
    name: noteName(pickedNote.midi + opts.transpose),
    bar: Math.floor(pickedNote.time / (beat * 4) + 1e-6) + 1,
    beat: Math.round(((pickedNote.time / beat) % 4) * 4) / 4 + 1,
    beats: pickedNote.duration / beat,
    muted: !!noteEdits[picked!]?.mute,
    changed: !!noteEdits[picked!],
  };
  const uncut = (bar: number) =>
    setEdits((e) => {
      const next = { ...e, [bar]: { ...e[bar], cut: false } };
      if (isPlain(next[bar])) delete next[bar];
      return next;
    });

  const win = (id: WinId, body: React.ReactNode, o: { resize?: boolean; max?: boolean; min?: boolean; title?: string; className?: string } = {}) => {
    const [title, icon] = TITLE[id];
    return (
      <Window
        key={id}
        title={o.title ?? title}
        icon={icon}
        state={wm.wins[id]}
        focused={wm.top === id}
        onFocus={() => wm.top !== id && wm.focus(id)}
        onClose={() => wm.close(id)}
        onMinimize={o.min === false ? undefined : () => wm.minimize(id)}
        onMaximize={o.max ? () => wm.toggleMax(id) : undefined}
        onMove={(x, y) => wm.patch(id, { x, y })}
        onResize={o.resize ? (w, h) => wm.patch(id, { w, h }) : undefined}
        className={o.className}
      >
        {body}
      </Window>
    );
  };

  const openIds = (Object.keys(wm.wins) as WinId[]).filter((id) => wm.wins[id].open && id !== "msg");

  return (
    <>
      <main className="desktop">
        <DesktopIcons apps={APPS.filter((a) => a.id !== "chords" || usesChart).filter((a) => a.id !== "report" || report)} onOpen={openApp} />

        {win(
          "player",
          <div className="win-body">
            <div className="toolbar">
              <button className="btn icon" onClick={() => seek(0)} title="Back to start (Home)" aria-label="Back to start">
                ⏮
              </button>
              <button
                className="btn big"
                onClick={() => (playing ? (ear.waiting ? goOn() : recording ? stopTake() : pause()) : play())}
                disabled={loading}
                title={ear.waiting ? "Stop waiting and carry on (Space)" : "Play / pause (Space)"}
              >
                {loading ? "Loading…" : playing ? (ear.waiting ? "▶ Go on" : "❚❚ Pause") : "▶ Play"}
              </button>
              <output className="lcd time">
                {fmt(clock)} <span>/ {fmt(total)}</span>
              </output>
              <span className="divider" />
              <span className="tl">
                Key
                <Spin name="Key" value={`${opts.transpose > 0 ? "+" : ""}${opts.transpose}`} onDec={() => keyUp(-1)} onInc={() => keyUp(1)} />
              </span>
              <span className="tl">
                Speed
                <Spin name="Speed" value={`${Math.round(opts.tempo * 100)}%`} onDec={() => speedUp(-0.05)} onInc={() => speedUp(0.05)} />
              </span>
              <span className="divider" />
              {recording ? (
                <button className="btn big" onClick={stopTake}>
                  ■ Stop
                </button>
              ) : (
                <button className="btn big rec" onClick={startTake} title="Sing along and record the take">
                  ● Rec
                </button>
              )}
              <button
                className={`btn big ear-btn ${listening ? "pressed" : ""}`}
                onClick={() => setListening((l) => !l)}
                aria-pressed={listening}
                title="The piano listens to the singing: it waits for each entrance, stops when the singing stops, plays as loud as the voice and moves to the sung key (Settings → Listening)"
              >
                <i className={`led ${listening && ear.voiced ? "on" : ""}`} />
                Listen
              </button>
              <span className="grow" />
              <select value={monitor} onChange={(e) => setMonitor(e.target.value as Monitor)} title="What plays on the speakers" aria-label="What plays on the speakers">
                <option value="robot">Hear: robot</option>
                <option value="source">Hear: original</option>
              </select>
            </div>
            <div className="stage-box">
              <span className="stage-caption">
                <b>{song.name}</b> · {caption}
              </span>
              <Stage plan={plan} getTime={getTime} melody={melody} />
            </div>
            <PartBar
              sel={sel}
              edits={edits}
              note={noteInfo || null}
              onNote={(p) => changeNote(p === null ? null : "beats" in p ? { duration: Math.max(0.25, p.beats) * beat } : { mute: p.mute })}
              onNoteClose={() => setPicked(null)}
              noteChanges={Object.keys(noteEdits).length}
              styleNote={kind === "file" ? "As written" : "Song style"}
              onChange={changePart}
              onClose={() => setSel(null)}
              onResetAll={() => {
                setEdits({});
                setSel(null);
                setNoteEdits({});
                setPicked(null);
              }}
            />
            <TrackView
              plan={plan}
              bars={bars}
              selection={sel}
              onSelect={pickBars}
              onUncut={uncut}
              muted={muted}
              picked={picked}
              onPick={pickNote}
              duration={total}
              getTime={getTime}
              onSeek={seek}
              melody={melody}
              sung={take ? report?.frames : undefined}
              live={listening || !take ? liveView : undefined}
              take={takeTrack ?? undefined}
              levels={levels}
              onLevel={setLevel}
              takeTools={
                take && (
                  <>
                    <button className="btn" onClick={() => nudge(-10)} title="Recording 10 ms earlier">
                      ◀
                    </button>
                    <output>{`${take.nudge >= 0 ? "+" : ""}${Math.round(take.nudge * 1000)}`}</output>
                    <button className="btn" onClick={() => nudge(10)} title="Recording 10 ms later">
                      ▶
                    </button>
                    <button className="btn" onClick={downloadTake} title="Save as .wav">
                      ⤓
                    </button>
                    <button className="btn" onClick={() => setTake(null)} title="Delete recording">
                      ✕
                    </button>
                  </>
                )
              }
            />
            <div className="statusbar">
              <span>{status}</span>
              <span className="fit">{playable}% playable</span>
              <span className="fit">{linkUp ? (robotLive ? "🤖 Robot: live" : "🤖 Robot: connected") : "Robot: offline"}</span>
            </div>
          </div>,
          { resize: true, max: true, className: "player" },
        )}

        {win(
          "songs",
          <SongsWindow
            kind={kind}
            onKind={resetTo}
            score={score}
            roles={roles}
            onRoles={setRoles}
            scoreOpts={scoreOpts}
            onScoreOpts={setScoreOpts}
            onFile={loadScore}
            onHumStart={startHum}
            onHumStop={stopHum}
            humView={humView}
            humAudio={humAudio}
            hummed={hum ? { notes: hum.notes.length, key: hum.base.key } : null}
            humWeight={humWeight}
            onHumWeight={onHumWeight}
            prog={prog}
            onProg={(id) => {
              setProg(id);
              setDemoChart(progressionChart(id));
            }}
            style={style}
            onStyle={setStyle}
            flourish={flourish}
            onFlourish={setFlourish}
            onChords={() => wm.focus("chords")}
            localDemos={localDemos}
            onLocalDemo={onLocalDemo}
          />,
        )}

        {win("voice", <VoiceWindow profile={voice} onProfile={setVoice} suggestion={suggestion} onApply={() => suggestion !== null && set("transpose", suggestion)} onError={say} />)}

        {usesChart &&
          win(
            "chords",
            kind === "hum" && hum ? (
              <ChordsWindow chart={hum.chart} onChange={(c) => setHum({ ...hum, chart: c })} onReset={() => setHum({ ...hum, chart: hum.base.chart })} fixedLength />
            ) : (
              <ChordsWindow chart={demoChart} onChange={setDemoChart} onReset={() => setDemoChart(progressionChart(prog))} />
            ),
            { title: `Chords – ${chart.name}` },
          )}

        {win("robot", <RobotWindow plan={plan} link={link.current} live={robotLive} onLive={setRobotLive} onExport={() => exportPlan(plan, song.name)} onSeek={seek} />)}

        {report && win("report", <ReportWindow report={report} onSeek={seek} />)}

        {win(
          "settings",
          <SettingsWindow
            split={opts.split}
            onSplit={(n) => set("split", n)}
            maxVoices={opts.maxVoices}
            onMaxVoices={(n) => set("maxVoices", n)}
            fold={opts.fold}
            onFold={(b) => set("fold", b)}
            listen={listenOpts}
            onListen={setListenOpts}
            scheme={scheme}
            onScheme={(id) => {
              setScheme(id);
              applyScheme(id);
            }}
          />,
        )}

        {win("welcome", <WelcomeWindow onOpen={(id) => openApp(id)} onClose={() => wm.close("welcome")} />, { min: false })}

        {message && win("msg", <MessageBox message={message} onClose={() => { setMessage(null); wm.close("msg"); }} />, { min: false })}
      </main>

      <Taskbar
        apps={APPS}
        openIds={openIds}
        focused={wm.top}
        onTask={(id) => (wm.top === id ? wm.minimize(id as WinId) : wm.focus(id as WinId))}
        onStart={openApp}
        tray={
          <>
            {(recording || listening) && <span className="live" title="Microphone in use">● mic</span>}
            {linkUp && <span title="Robot connected">🤖</span>}
          </>
        }
      />
    </>
  );
}
