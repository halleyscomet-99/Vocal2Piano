import { useEffect, useRef } from "react";
import { carriagePosAt } from "../engine/planner";
import { CARRIAGES, type CarriageId, KEY_HIGH, KEY_LOW, WHITE_FINGERS, WHITE_KEYS, fingerKeys, isBlack, noteName, whiteIndexOf } from "../engine/robot";
import type { Note, Plan } from "../engine/types";

const LOOKAHEAD = 3; // seconds of falling notes visible

export const CARRIAGE_COLOR: Record<CarriageId, string> = { treble: "#ffff55", bass: "#55ffff" };

interface Props {
  plan: Plan;
  getTime: () => number;
  /** The sung tune (song time, transposed), drawn as outlines falling with the piano. */
  melody?: Note[];
}

function keyGeom(midi: number, ww: number) {
  if (!isBlack(midi)) return { x: whiteIndexOf(midi)! * ww, w: ww, black: false };
  const bw = ww * 0.58;
  return { x: (whiteIndexOf(midi - 1)! + 1) * ww - bw / 2, w: bw, black: true };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export function Stage({ plan, getTime, melody }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  const melodyRef = useRef(melody);
  melodyRef.current = melody;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const g = canvas.getContext("2d")!;
    let raf = 0;
    let W = 0;
    let H = 0;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      W = r.width;
      H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const p = planRef.current;
      const now = getTime();
      const ww = W / WHITE_KEYS.length;
      const kbH = Math.min(150, Math.max(70, ww * 6.2));
      const kbY = H - kbH - 6;
      const fallH = kbY - 26;
      const pps = fallH / LOOKAHEAD;
      const pos: Record<CarriageId, number> = { bass: carriagePosAt(p, "bass", now), treble: carriagePosAt(p, "treble", now) };

      g.clearRect(0, 0, W, H);

      // Octave grid
      g.lineWidth = 1;
      for (let m = KEY_LOW; m <= KEY_HIGH; m++) {
        if (m % 12 !== 0) continue;
        const x = Math.round(whiteIndexOf(m)! * ww) + 0.5;
        g.strokeStyle = "rgba(255,255,255,0.08)";
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, kbY);
        g.stroke();
        g.fillStyle = "rgba(255,255,255,0.4)";
        g.font = "10px Tahoma, Geneva, sans-serif, monospace";
        g.fillText(noteName(m), x + 3, 12);
      }

      // Reach columns: what each carriage can hit right now
      for (const c of CARRIAGES) {
        const x = pos[c] * ww;
        const grad = g.createLinearGradient(0, 0, 0, kbY);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, c === "treble" ? "rgba(255,255,85,0.12)" : "rgba(85,255,255,0.12)");
        g.fillStyle = grad;
        g.fillRect(x, 0, WHITE_FINGERS * ww, kbY);
      }

      // Moves in progress: ghost of the destination
      for (const m of p.moves) {
        if (now < m.t0 - 0.4 || now > m.t1) continue;
        g.setLineDash([4, 4]);
        g.strokeStyle = CARRIAGE_COLOR[m.carriage];
        g.globalAlpha = 0.6;
        g.strokeRect(m.to * ww + 1, kbY - 22, WHITE_FINGERS * ww - 2, kbH + 20);
        g.setLineDash([]);
        g.globalAlpha = 1;
      }

      // Dropped notes: hollow red outlines with a cross
      for (const n of p.dropped) {
        if (n.time > now + LOOKAHEAD || n.time + n.duration < now) continue;
        const k = keyGeom(n.midi, ww);
        const y1 = kbY - (n.time - now) * pps;
        const y0 = kbY - (n.time + n.duration - now) * pps;
        g.strokeStyle = "rgba(255,85,85,0.95)";
        g.setLineDash([3, 3]);
        g.strokeRect(k.x + 1.5, y0, k.w - 3, Math.max(4, y1 - y0));
        g.setLineDash([]);
        g.beginPath();
        g.moveTo(k.x + 2, y1 - 2);
        g.lineTo(k.x + k.w - 2, y1 - k.w + 2);
        g.moveTo(k.x + k.w - 2, y1 - 2);
        g.lineTo(k.x + 2, y1 - k.w + 2);
        g.stroke();
      }

      // The sung tune: outlines, so they read as the singer's, not the robot's
      g.strokeStyle = "rgba(255,255,255,0.85)";
      g.lineWidth = 1.5;
      g.setLineDash([]);
      for (const n of melodyRef.current ?? []) {
        if (n.time > now + LOOKAHEAD) break;
        if (n.time + n.duration < now || n.midi < KEY_LOW || n.midi > KEY_HIGH) continue;
        const k = keyGeom(n.midi, ww);
        const y1 = Math.min(kbY, kbY - (n.time - now) * pps);
        const y0 = kbY - (n.time + n.duration - now) * pps;
        if (y1 > y0) {
          roundRect(g, k.x + 0.5, y0, k.w - 1, y1 - y0, 3);
          g.stroke();
        }
      }
      g.lineWidth = 1;

      // Falling strikes
      const active = new Map<string, { carriage: CarriageId; finger: string }>();
      for (const s of p.strikes) {
        if (s.time > now + LOOKAHEAD) break;
        const end = s.time + s.duration;
        if (end < now - 0.05) continue;
        if (s.time <= now && now < end) active.set(`${s.carriage}:${s.finger}`, s);
        const k = keyGeom(s.midi, ww);
        const y1 = Math.min(kbY, kbY - (s.time - now) * pps);
        const y0 = kbY - (end - now) * pps;
        if (y1 <= y0) continue;
        const col = CARRIAGE_COLOR[s.carriage];
        roundRect(g, k.x + 1.5, y0, k.w - 3, y1 - y0, 3);
        g.fillStyle = col;
        g.globalAlpha = k.black ? 0.8 : 0.95;
        g.fill();
        g.globalAlpha = 1;
        if (s.folded) {
          g.strokeStyle = "#ffffff";
          g.setLineDash([2, 3]);
          g.stroke();
          g.setLineDash([]);
        }
        if (s.truncated) {
          g.fillStyle = "rgba(0,0,0,0.75)";
          g.fillRect(k.x + 3, y0 + 1, k.w - 6, 2);
        }
      }

      // Hit line
      const hit = g.createLinearGradient(0, kbY - 18, 0, kbY);
      hit.addColorStop(0, "rgba(255,255,255,0)");
      hit.addColorStop(1, "rgba(255,255,255,0.12)");
      g.fillStyle = hit;
      g.fillRect(0, kbY - 18, W, 18);

      // Keyboard (top-down)
      const lit = new Map<number, CarriageId>();
      for (const s of p.strikes) {
        if (s.time > now) break;
        if (now < s.time + s.duration) lit.set(s.midi, s.carriage);
      }
      for (const m of WHITE_KEYS) {
        const k = keyGeom(m, ww);
        const c = lit.get(m);
        g.fillStyle = c ? CARRIAGE_COLOR[c] : "#ffffff";
        roundRect(g, k.x + 0.75, kbY, k.w - 1.5, kbH, 2.5);
        g.fill();
      }
      const bh = kbH * 0.62;
      for (let m = KEY_LOW; m <= KEY_HIGH; m++) {
        if (!isBlack(m)) continue;
        const k = keyGeom(m, ww);
        const c = lit.get(m);
        g.fillStyle = c ? CARRIAGE_COLOR[c] : "#000000";
        roundRect(g, k.x, kbY, k.w, bh, 2);
        g.fill();
      }

      // Carriages with finger LEDs
      for (const c of CARRIAGES) {
        const x = pos[c] * ww;
        const w = WHITE_FINGERS * ww;
        const col = CARRIAGE_COLOR[c];
        g.strokeStyle = col;
        g.lineWidth = 2;
        roundRect(g, x + 1, kbY - 4, w - 2, kbH + 8, 5);
        g.stroke();
        g.lineWidth = 1;
        g.font = "600 10px Tahoma, Geneva, sans-serif, monospace";
        const label = c === "treble" ? "Right hand" : "Left hand";
        const lw = g.measureText(label).width + 10;
        g.fillStyle = "#000000";
        roundRect(g, x + 1, kbY - 21, lw, 15, 3);
        g.fill();
        g.stroke();
        g.fillStyle = col;
        g.fillText(label, x + 6, kbY - 10);

        const keys = fingerKeys(Math.round(pos[c]));
        const r = Math.max(2.5, Math.min(5, ww * 0.2));
        const drawLed = (cx: number, cy: number, on: boolean, dead: boolean) => {
          g.beginPath();
          g.arc(cx, cy, r, 0, Math.PI * 2);
          if (dead) {
            g.strokeStyle = "rgba(160,160,160,0.6)";
            g.stroke();
            return;
          }
          if (on) {
            g.shadowColor = CARRIAGE_COLOR[c];
            g.shadowBlur = 12;
          }
          g.fillStyle = on ? "#ff5555" : "#404040";
          g.fill();
          g.shadowBlur = 0;
        };
        for (let i = 0; i < WHITE_FINGERS; i++) {
          drawLed(x + (i + 0.5) * ww, kbY + kbH * 0.83, active.has(`${c}:W${i + 1}`), false);
        }
        for (let i = 0; i < keys.black.length; i++) {
          drawLed(x + (i + 1) * ww, kbY + bh * 0.62, active.has(`${c}:B${i + 1}`), keys.black[i] === null);
        }
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [getTime]);

  return <canvas ref={canvasRef} className="stage-canvas" aria-label="Top-down rehearsal view of the robot over the keyboard" />;
}
