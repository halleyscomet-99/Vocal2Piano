// Music-player style timeline: the playhead stays put and the tracks scroll past it.
// Drag the tracks to scrub, drag across the bar numbers to pick a part, click a note on
// the Piano track to change just that note, use the overview bar below to jump anywhere.

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "../audio";
import type { SungFrame } from "../engine/pitchCheck";
import { STYLES } from "../engine/arranger";
import type { BarMark } from "../engine/parts";
import { MAX_POS, WHITE_FINGERS } from "../engine/robot";
import type { Note, Plan } from "../engine/types";
import { pcDiff } from "../engine/voice";
import { CARRIAGE_COLOR } from "./Stage";
import { SEVERE } from "./problems";

const ROW = { ruler: 22, hands: 30, piano: 90, tune: 46, take: 46 };
const PLAYHEAD = 0.25; // fraction of the width
const BIN = 0.01; // waveform resolution, s

type LaneId = keyof typeof ROW;

const peakCache = new WeakMap<AudioBuffer, Float32Array>();
function peaks(buffer: AudioBuffer) {
  const hit = peakCache.get(buffer);
  if (hit) return hit;
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.round(buffer.sampleRate * BIN));
  const out = new Float32Array(Math.ceil(data.length / step));
  let max = 1e-6;
  for (let i = 0; i < out.length; i++) {
    let p = 0;
    for (let j = i * step, e = Math.min(data.length, j + step); j < e; j++) p = Math.max(p, Math.abs(data[j]));
    out[i] = p;
    max = Math.max(max, p);
  }
  for (let i = 0; i < out.length; i++) out[i] /= max;
  peakCache.set(buffer, out);
  return out;
}

interface Props {
  plan: Plan;
  bars: BarMark[]; // on the rehearsal clock (speed and part changes applied)
  selection: [number, number] | null; // picked bars (original numbering)
  onSelect: (s: [number, number] | null) => void;
  onUncut: (bar: number) => void;
  muted: Note[]; // left-out notes (rehearsal clock), drawn as outlines
  picked: string | null; // id of the note being changed
  onPick: (id: string | null) => void;
  duration: number;
  getTime: () => number;
  onSeek: (t: number) => void;
  melody?: Note[];
  sung?: SungFrame[]; // from a recording
  /** Heard live with Listen on (grows during singing). */
  live?: { current: SungFrame[] };
  take?: Track;
  levels: Record<string, number>;
  onLevel: (id: string, g: number) => void;
  takeTools?: ReactNode;
}

function Level({ id, levels, onLevel }: { id: string; levels: Record<string, number>; onLevel: (id: string, g: number) => void }) {
  const v = levels[id] ?? 1;
  const last = useRef(v || 1);
  if (v > 0) last.current = v;
  return (
    <>
      <button className={`btn ${v === 0 ? "pressed" : ""}`} onClick={() => onLevel(id, v === 0 ? last.current : 0)} title={v === 0 ? "Unmute" : "Mute"}>
        M
      </button>
      <input type="range" min={0} max={100} value={Math.round(v * 100)} onChange={(e) => onLevel(id, Number(e.target.value) / 100)} aria-label="Volume" />
    </>
  );
}

/** Off by default: the piano plays the tune only when asked, e.g. to check the key. */
function TunePlay({ levels, onLevel }: { levels: Record<string, number>; onLevel: (id: string, g: number) => void }) {
  const on = (levels.tune ?? 0) > 0;
  return (
    <button className={`btn ${on ? "pressed" : ""}`} onClick={() => onLevel("tune", on ? 0 : 0.8)} title="The piano plays the sung tune (the white outlines), to hear the key and learn it">
      ♪ Play
    </button>
  );
}

const STYLE_SHORT = Object.fromEntries(STYLES.map((s) => [s.id, s.label.split(" ")[0]]));

function editLabel(m: BarMark) {
  const e = m.edit;
  if (!e) return "";
  return [e.speed && e.speed !== 1 ? `${Math.round(e.speed * 100)}%` : "", e.style ? STYLE_SHORT[e.style] : ""].filter(Boolean).join(" ");
}

export function TrackView({ plan, bars, selection, onSelect, onUncut, muted, picked, onPick, duration, getTime, onSeek, melody, sung, live, take, levels, onLevel, takeTools }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const [pps, setPps] = useState(70); // pixels per second

  const lanes: LaneId[] = ["ruler", "hands", "piano", ...(melody?.length ? (["tune"] as LaneId[]) : []), ...(take ? (["take"] as LaneId[]) : [])];
  const height = lanes.reduce((h, l) => h + ROW[l], 0);

  const strikes = useMemo(() => [...plan.strikes].sort((a, b) => a.time - b.time), [plan]);
  const range = useMemo(() => {
    let lo = 127;
    let hi = 0;
    for (const s of strikes) {
      lo = Math.min(lo, s.midi);
      hi = Math.max(hi, s.midi);
    }
    return { lo: Math.min(lo, hi), hi: Math.max(hi, lo + 12) };
  }, [strikes]);
  const tuneRange = useMemo(() => {
    if (!melody?.length) return { lo: 60, hi: 72 };
    const ps = melody.map((n) => n.midi);
    return { lo: Math.min(...ps) - 2, hi: Math.max(...ps) + 2 };
  }, [melody]);

  // Everything the draw loop reads, kept in a ref so the loop never restarts.
  const data = useRef({ plan, strikes, range, tuneRange, melody, sung, live, take, pps, bars, selection, muted, picked, lanes, duration });
  data.current = { plan, strikes, range, tuneRange, melody, sung, live, take, pps, bars, selection, muted, picked, lanes, duration };

  useEffect(() => {
    const canvas = ref.current!;
    const ov = ovRef.current!;
    const g = canvas.getContext("2d")!;
    const o = ov.getContext("2d")!;
    let raf = 0;

    const fit = (c: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = c.getBoundingClientRect();
      if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { W: width, H: height };
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const d = data.current;
      const now = getTime();
      const { W } = fit(canvas, g);
      const P = W * PLAYHEAD;
      const X = (t: number) => P + (t - now) * d.pps;
      const t0 = now - P / d.pps;
      const t1 = now + (W - P) / d.pps;
      g.fillStyle = "#000";
      g.fillRect(0, 0, W, canvas.height);
      g.font = "10px Tahoma, Geneva, sans-serif";

      let y = 0;
      for (const lane of d.lanes) {
        const h = ROW[lane];
        g.save();
        g.beginPath();
        g.rect(0, y, W, h);
        g.clip();

        if (lane === "ruler") {
          g.fillStyle = "#c0c0c0";
          g.fillRect(0, y, W, h);
          const sel = d.selection;
          for (const m of d.bars) {
            if (m.cut || m.end < t0 || m.time > t1) continue;
            const xa = X(m.time);
            const xb = X(m.end);
            const picked = sel && m.bar >= sel[0] && m.bar <= sel[1];
            const label = editLabel(m);
            if (picked || label) {
              g.fillStyle = picked ? "#000080" : "#e8d8a0";
              g.fillRect(xa, y, xb - xa, h);
            }
            g.fillStyle = picked ? "#fff" : "#000";
            g.fillRect(Math.round(xa) + 0.5, y + 4, 1, h - 4);
            for (let q = 1; q < 4; q++) g.fillRect(Math.round(xa + ((xb - xa) * q) / 4) + 0.5, y + 14, 1, h - 14);
            g.fillText(String(m.bar + 1), xa + 3, y + 12);
            if (label && xb - xa > 40) g.fillText(label, xa + 22, y + 12);
          }
          // Cut bars: a ✂ where they were; click it to bring them back.
          for (const m of d.bars) {
            if (!m.cut || m.time < t0 - 10 || m.time > t1 + 10) continue;
            const x = Math.round(X(m.time));
            g.fillStyle = "#c00000";
            g.fillRect(x - 1, y, 2, h);
            g.fillText("✂", x + 2, y + h - 2);
          }
          for (const w of d.plan.warnings) {
            if (!SEVERE.has(w.kind) || w.time < t0 || w.time > t1) continue;
            const x = X(w.time);
            g.fillStyle = "#c00000";
            g.beginPath();
            g.moveTo(x - 4, y + h);
            g.lineTo(x + 4, y + h);
            g.lineTo(x, y + h - 7);
            g.fill();
          }
        } else {
          // bar lines through every lane, and the picked part
          g.fillStyle = "#1c1c1c";
          for (const m of d.bars) if (!m.cut && m.time >= t0 && m.time <= t1) g.fillRect(Math.round(X(m.time)), y, 1, h);
          if (d.selection) {
            const inSel = d.bars.filter((m) => !m.cut && m.bar >= d.selection![0] && m.bar <= d.selection![1]);
            if (inSel.length) {
              g.fillStyle = "rgba(64,96,255,0.18)";
              g.fillRect(X(inSel[0].time), y, X(inSel.at(-1)!.end) - X(inSel[0].time), h);
            }
          }
        }

        if (lane === "hands") {
          const Y = (pos: number) => y + h - 3 - ((pos + WHITE_FINGERS / 2) / (MAX_POS + WHITE_FINGERS)) * (h - 6);
          for (const c of ["bass", "treble"] as const) {
            g.strokeStyle = CARRIAGE_COLOR[c];
            g.lineWidth = 2;
            g.beginPath();
            let pos = d.plan.start[c];
            g.moveTo(X(0), Y(pos));
            for (const m of d.plan.moves) {
              if (m.carriage !== c) continue;
              g.lineTo(X(m.t0), Y(pos));
              g.lineTo(X(m.t1), Y(m.to));
              pos = m.to;
            }
            g.lineTo(X(d.duration), Y(pos));
            g.stroke();
          }
        }

        if (lane === "piano") {
          const { lo, hi } = d.range;
          const rh = (h - 6) / (hi - lo + 1);
          for (const s of d.strikes) {
            if (s.time > t1) break;
            if (s.time + s.duration < t0) continue;
            g.fillStyle = CARRIAGE_COLOR[s.carriage];
            g.fillRect(X(s.time), y + 3 + (hi - s.midi) * rh, Math.max(2, s.duration * d.pps - 1), Math.max(2, rh));
          }
          g.setLineDash([3, 2]);
          g.strokeStyle = "#888";
          for (const n of d.muted) {
            if (n.time > t1 || n.time + n.duration < t0) continue;
            g.strokeRect(X(n.time) + 0.5, y + 3 + (hi - n.midi) * rh + 0.5, Math.max(3, n.duration * d.pps - 2), Math.max(2, rh));
          }
          g.setLineDash([]);
          if (d.picked) {
            g.strokeStyle = "#fff";
            g.lineWidth = 2;
            for (const n of [...d.strikes, ...d.muted]) {
              if (n.id !== d.picked) continue;
              g.strokeRect(X(n.time) - 1, y + 2 + (hi - n.midi) * rh, Math.max(4, n.duration * d.pps + 1), Math.max(4, rh + 2));
            }
            g.lineWidth = 1;
          }
        }

        if (lane === "tune" && d.melody) {
          const { lo, hi } = d.tuneRange;
          const Y = (m: number) => y + 3 + ((hi - m) / (hi - lo)) * (h - 6);
          const rh = Math.max(3, (h - 6) / (hi - lo));
          g.strokeStyle = "#fff";
          g.lineWidth = 1;
          for (const n of d.melody) {
            if (n.time > t1) break;
            if (n.time + n.duration < t0) continue;
            g.strokeRect(X(n.time) + 0.5, Y(n.midi) - rh / 2 + 0.5, Math.max(2, n.duration * d.pps - 2), rh);
          }
          const mel = d.melody;
          const noteAt = (t: number) => {
            let lo = 0;
            let hi = mel.length;
            while (lo < hi) {
              const m = (lo + hi) >> 1;
              if (mel[m].time <= t) lo = m + 1;
              else hi = m;
            }
            const n = mel[lo - 1];
            return n && t <= n.time + n.duration ? n : null;
          };
          for (const src of [d.sung, d.live?.current]) {
            if (!src) continue;
            for (const f of src) {
              if (f.t < t0 || f.t > t1) continue;
              const n = noteAt(f.t);
              if (!n) continue;
              const diff = pcDiff(f.midi, n.midi);
              const a = Math.abs(diff);
              g.fillStyle = a <= 0.5 ? "#55ff55" : a <= 1 ? "#ffaa00" : "#ff5555";
              g.fillRect(X(f.t) - 1, Y(n.midi + diff) - 1.5, 3, 3);
            }
          }
        }

        if (lane === "take" && d.take) {
          const pk = peaks(d.take.buffer);
          const mid = y + h / 2;
          g.fillStyle = "#55ff55";
          const xa = Math.max(0, Math.floor(X(d.take.start)));
          const xb = Math.min(W, X(d.take.start + d.take.buffer.duration / d.take.rate));
          for (let x = xa; x < xb; x++) {
            const t = now + (x - P) / d.pps;
            const i = Math.floor(((t - d.take.start) * d.take.rate) / BIN);
            const v = pk[Math.min(pk.length - 1, Math.max(0, i))] ?? 0;
            const a = Math.max(1, v * (h / 2 - 3));
            g.fillRect(x, mid - a, 1, a * 2);
          }
        }

        g.restore();
        if (lane !== "ruler") {
          g.fillStyle = "#333";
          g.fillRect(0, y + h - 1, W, 1);
        }
        y += h;
      }

      // Played part dimmed, upcoming part bright; playhead on top.
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fillRect(0, ROW.ruler, P, y - ROW.ruler);
      g.fillStyle = "#ff0000";
      g.fillRect(Math.round(P) - 1, 0, 2, y);
      g.beginPath();
      g.moveTo(P - 6, 0);
      g.lineTo(P + 6, 0);
      g.lineTo(P, 8);
      g.fill();

      // Overview: the whole song as a progress bar.
      const ob = fit(ov, o);
      const dur = Math.max(1, d.duration);
      const OX = (t: number) => (t / dur) * ob.W;
      o.fillStyle = "#fff";
      o.fillRect(0, 0, ob.W, ob.H);
      o.fillStyle = "#000080";
      for (let x = 2; x < OX(now) - 2; x += 10) o.fillRect(x, 3, 8, ob.H - 6);
      o.fillStyle = "rgba(128,128,128,0.6)";
      for (const s of d.strikes) o.fillRect(OX(s.time), ob.H - 4, 1, 2);
      o.fillStyle = "#c00000";
      for (const w of d.plan.warnings) if (SEVERE.has(w.kind)) o.fillRect(OX(w.time) - 1, 0, 2, 5);
      o.strokeStyle = "#000";
      o.strokeRect(OX(t0) + 0.5, 0.5, Math.max(4, OX(t1) - OX(t0)), ob.H - 1);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [getTime]);

  // Ruler: drag across bar numbers to pick a part, click a ✂ to bring cut bars back.
  const barAt = (t: number) => {
    let b = bars.find((m) => !m.cut)?.bar ?? 0;
    for (const m of bars) if (!m.cut && m.time <= t) b = m.bar;
    return b;
  };
  const onRuler = (e: React.PointerEvent<HTMLCanvasElement>, r: DOMRect) => {
    const el = e.currentTarget;
    const at = (cx: number) => getTime() + (cx - r.left - r.width * PLAYHEAD) / pps;
    const t = at(e.clientX);
    const cut = bars.find((m) => m.cut && Math.abs((m.time - t) * pps) < 8);
    if (cut) {
      for (const m of bars) if (m.cut && Math.abs(m.time - cut.time) < 1e-6) onUncut(m.bar);
      return;
    }
    const a = barAt(t);
    onSelect([a, a]);
    const move = (ev: PointerEvent) => {
      const b = barAt(at(ev.clientX));
      onSelect([Math.min(a, b), Math.max(a, b)]);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // The note (played or left out) under a click on the Piano track, if any.
  const noteAt = (cx: number, cy: number, r: DOMRect): string | null => {
    let y = 0;
    for (const l of lanes) {
      if (l === "piano") break;
      y += ROW[l];
    }
    const py = cy - r.top - y;
    if (py < 0 || py > ROW.piano) return null;
    const { lo, hi } = range;
    const rh = (ROW.piano - 6) / (hi - lo + 1);
    const t = getTime() + (cx - r.left - r.width * PLAYHEAD) / pps;
    const slack = 3 / pps;
    let best: { id: string; d: number } | null = null;
    for (const n of [...strikes, ...muted]) {
      if (!n.id || t < n.time - slack || t > n.time + Math.max(n.duration, 4 / pps) + slack) continue;
      const d = Math.abs(py - (3 + (hi - n.midi) * rh + rh / 2));
      if (d <= Math.max(4, rh) && (!best || d < best.d)) best = { id: n.id, d };
    }
    return best?.id ?? null;
  };

  // Scrub: drag the tracks; a click without dragging jumps to that spot.
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    if (e.clientY - r.top < ROW.ruler) return onRuler(e, r);
    const x0 = e.clientX;
    const start = getTime();
    let moved = false;
    const at = (cx: number) => start + (cx - r.left - r.width * PLAYHEAD) / pps;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (moved) onSeek(Math.min(duration, Math.max(0, start - (ev.clientX - x0) / pps)));
    };
    const up = (ev: PointerEvent) => {
      if (!moved) {
        const hit = noteAt(ev.clientX, ev.clientY, r);
        onPick(hit ?? null);
        if (!hit) onSeek(Math.min(duration, Math.max(0, at(ev.clientX))));
      }
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const onOverview = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === "pointermove" && e.buttons !== 1) return;
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };

  // Trackpad / wheel: sideways scrolls through the song, ctrl + wheel (pinch) zooms.
  useEffect(() => {
    const el = ref.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) setPps((p) => Math.min(300, Math.max(15, p * (e.deltaY > 0 ? 0.9 : 1.1))));
      else {
        const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        onSeek(Math.max(0, getTime() + dx / data.current.pps));
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [getTime, onSeek]);

  return (
    <div className="trackview">
      <div className="track-heads">
        <div className="track-head ruler" style={{ height: ROW.ruler }}>
          <span>Bar</span>
          <button className="btn" onClick={() => setPps((p) => Math.max(15, p / 1.4))} title="Zoom out">
            −
          </button>
          <button className="btn" onClick={() => setPps((p) => Math.min(300, p * 1.4))} title="Zoom in">
            +
          </button>
        </div>
        <div className="track-head" style={{ height: ROW.hands }}>
          <i className="swatch" style={{ background: `linear-gradient(90deg, ${CARRIAGE_COLOR.bass} 50%, ${CARRIAGE_COLOR.treble} 50%)` }} />
          <b>Robot hands</b>
        </div>
        <div className="track-head" style={{ height: ROW.piano }}>
          <i className="swatch" style={{ background: CARRIAGE_COLOR.treble }} />
          <b>Piano</b>
          <Level id="piano" levels={levels} onLevel={onLevel} />
        </div>
        {melody?.length ? (
          <div className="track-head" style={{ height: ROW.tune }}>
            <i className="swatch" style={{ background: "#000", boxShadow: "inset 0 0 0 1px #fff, 0 0 0 1px #000" }} />
            <b title="The sung tune. The sung pitch shows on top: live with 👂 Listen, or after a recording (green = in tune, orange = close, red = off).">My tune</b>
            <TunePlay levels={levels} onLevel={onLevel} />
          </div>
        ) : null}
        {take ? (
          <div className="track-head" style={{ height: ROW.take, flexWrap: "wrap", alignContent: "center" }}>
            <i className="swatch" style={{ background: "#55ff55" }} />
            <b>Recording</b>
            <Level id="take" levels={levels} onLevel={onLevel} />
            {takeTools}
          </div>
        ) : null}
      </div>
      <canvas ref={ref} className="track-canvas" style={{ height }} onPointerDown={onDown} aria-label="Song timeline. Drag to scrub." />
      <canvas ref={ovRef} className="overview sunken" onPointerDown={onOverview} onPointerMove={onOverview} aria-label="Whole song. Click to jump." />
    </div>
  );
}
