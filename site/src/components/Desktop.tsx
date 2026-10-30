// A tiny window manager: draggable, resizable windows, a taskbar and a Start menu.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icons";

export interface WinState {
  open: boolean;
  min: boolean;
  max: boolean;
  z: number;
  x: number;
  y: number;
  w: number;
  h?: number; // undefined = fit content
}

export function useWindows<K extends string>(init: () => Record<K, WinState>) {
  const [wins, setWins] = useState(init);
  const zTop = useRef(0);
  zTop.current ||= Math.max(...Object.values<WinState>(wins).map((w) => w.z));

  const patch = useCallback((id: K, p: Partial<WinState>) => setWins((all) => ({ ...all, [id]: { ...all[id], ...p } })), []);
  const focus = useCallback((id: K) => patch(id, { open: true, min: false, z: ++zTop.current }), [patch]);
  const close = useCallback((id: K) => patch(id, { open: false }), [patch]);
  const minimize = useCallback((id: K) => patch(id, { min: true }), [patch]);
  const toggleMax = useCallback((id: K) => setWins((all) => ({ ...all, [id]: { ...all[id], max: !all[id].max } })), []);

  // The focused window is the open, visible one on top.
  let top: K | null = null;
  for (const id of Object.keys(wins) as K[]) {
    const w = wins[id];
    if (w.open && !w.min && (top === null || w.z > wins[top].z)) top = id;
  }
  return { wins, patch, focus, close, minimize, toggleMax, top };
}

interface WindowProps {
  title: string;
  icon: IconName;
  state: WinState;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onMove: (x: number, y: number) => void;
  onResize?: (w: number, h: number) => void;
  className?: string;
  children: ReactNode;
}

export function Window({ title, icon, state, focused, onFocus, onClose, onMinimize, onMaximize, onMove, onResize, className = "", children }: WindowProps) {
  const ref = useRef<HTMLDivElement>(null);
  if (!state.open || state.min) return null;

  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button") || state.max) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX - state.x;
    const sy = e.clientY - state.y;
    const move = (ev: PointerEvent) => {
      const x = Math.min(window.innerWidth - 60, Math.max(-state.w + 80, ev.clientX - sx));
      const y = Math.min(window.innerHeight - 60, Math.max(0, ev.clientY - sy));
      onMove(x, y);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const resize = (e: React.PointerEvent) => {
    if (!onResize) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const box = ref.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => onResize(Math.max(240, ev.clientX - box.left), Math.max(160, ev.clientY - box.top));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const style: React.CSSProperties = state.max
    ? { left: 0, top: 0, width: "100%", height: "100%", zIndex: state.z }
    : { left: state.x, top: state.y, width: state.w, height: state.h, zIndex: state.z };

  return (
    <div ref={ref} className={`window ${focused ? "focused" : ""} ${className}`} style={style} onPointerDown={onFocus} role="dialog" aria-label={title}>
      <div className="titlebar" onPointerDown={drag} onDoubleClick={onMaximize}>
        <Icon name={icon} />
        <span className="title">{title}</span>
        {onMinimize && (
          <button className="btn tbtn" onClick={onMinimize} aria-label="Minimize">
            _
          </button>
        )}
        {onMaximize && (
          <button className="btn tbtn" onClick={onMaximize} aria-label={state.max ? "Restore" : "Maximize"}>
            {state.max ? "❐" : "□"}
          </button>
        )}
        <button className="btn tbtn close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {children}
      {onResize && !state.max && <div className="grip" onPointerDown={resize} />}
    </div>
  );
}

export interface AppEntry {
  id: string;
  label: string;
  icon: IconName;
}

export function DesktopIcons({ apps, onOpen }: { apps: AppEntry[]; onOpen: (id: string) => void }) {
  return (
    <nav className="icons" aria-label="Programs">
      {apps.map((a) => (
        <button key={a.id} className="dicon" onClick={() => onOpen(a.id)} title={`Open ${a.label}`}>
          <Icon name={a.icon} />
          <span>{a.label}</span>
        </button>
      ))}
    </nav>
  );
}

interface TaskbarProps {
  apps: AppEntry[];
  openIds: string[];
  focused: string | null;
  onTask: (id: string) => void;
  onStart: (id: string) => void;
  tray: ReactNode;
}

export function Taskbar({ apps, openIds, focused, onTask, onStart, tray }: TaskbarProps) {
  const [menu, setMenu] = useState(false);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".start-menu, .start")) setMenu(false);
    };
    window.addEventListener("pointerdown", off);
    return () => window.removeEventListener("pointerdown", off);
  }, [menu]);

  const byId = new Map(apps.map((a) => [a.id, a]));
  return (
    <>
      {menu && (
        <div className="start-menu" role="menu">
          <div className="start-band">
            <b>Vocal2Piano</b> 95
          </div>
          <div className="start-items">
            {apps.map((a, i) => (
              <span key={a.id} style={{ display: "contents" }}>
                {i === apps.length - 1 && <hr />}
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onStart(a.id);
                  }}
                >
                  <Icon name={a.icon} />
                  {a.label}
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <footer className="taskbar">
        <button className={`btn start ${menu ? "pressed" : ""}`} onClick={() => setMenu((m) => !m)}>
          <Icon name="logo" />
          Start
        </button>
        <div className="tasks">
          {openIds.map((id) => {
            const a = byId.get(id);
            if (!a) return null;
            return (
              <button key={id} className={`btn ${focused === id ? "pressed" : ""}`} onClick={() => onTask(id)} title={a.label}>
                <Icon name={a.icon} />
                <span>{a.label}</span>
              </button>
            );
          })}
        </div>
        <div className="tray">
          {tray}
          <span>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        </div>
      </footer>
    </>
  );
}
