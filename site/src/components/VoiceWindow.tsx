import { useEffect, useRef, useState } from "react";
import { noteName } from "../engine/robot";
import { type VoiceProfile, profileFrom } from "../engine/voice";
import { type Mic, openMic } from "../mic";

const STORE = "v2p.voice";
const RANGE_LO = 36; // C2
const RANGE_HI = 84; // C6

export function loadProfile(): VoiceProfile | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as VoiceProfile) : null;
  } catch {
    return null;
  }
}

function saveProfile(p: VoiceProfile) {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch {
    /* storage unavailable: profile lasts for this visit only */
  }
}

interface Props {
  profile: VoiceProfile | null;
  onProfile: (p: VoiceProfile) => void;
  suggestion: number | null;
  onApply: () => void;
  onError: (msg: string) => void;
}

export function VoiceWindow({ profile, onProfile, suggestion, onApply, onError }: Props) {
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const mic = useRef<Mic | null>(null);
  const pitches = useRef<number[]>([]);

  useEffect(() => () => mic.current?.close(), []);

  const start = async () => {
    try {
      mic.current = await openMic(false);
    } catch (e) {
      onError((e as Error).message);
      return;
    }
    pitches.current = [];
    let last: number | null = null;
    mic.current.pitch((m, lv) => {
      setLevel(lv);
      // Keep a pitch only when two frames in a row agree (filters octave glitches).
      if (m !== null && m > RANGE_LO - 6 && m < RANGE_HI + 6) {
        if (last !== null && Math.abs(m - last) < 0.7) pitches.current.push(m);
        setLive(m);
      } else setLive(null);
      last = m;
    });
    setRecording(true);
  };

  const stop = () => {
    mic.current?.close();
    mic.current = null;
    setRecording(false);
    setLive(null);
    setLevel(0);
    const p = profileFrom(pitches.current);
    if (!p) return onError("Not enough singing picked up. Sing a few long notes, low to high.");
    saveProfile(p);
    onProfile(p);
  };

  const x = (m: number) => `${((Math.min(RANGE_HI, Math.max(RANGE_LO, m)) - RANGE_LO) / (RANGE_HI - RANGE_LO)) * 100}%`;
  const shown = recording ? profileFrom(pitches.current) : profile;

  return (
    <div className="win-body">
      <output className="lcd big-lcd">{recording ? (live !== null ? noteName(Math.round(live)) : "…") : shown ? `${noteName(shown.low)} – ${noteName(shown.high)}` : "– – –"}</output>
      <div className="voice-meter sunken" aria-hidden>
        {Array.from({ length: (RANGE_HI - RANGE_LO) / 12 + 1 }, (_, i) => (
          <span key={i} className="oct" style={{ left: x(RANGE_LO + i * 12) }}>
            C{i + 2}
          </span>
        ))}
        {shown && <i className="band" style={{ left: x(shown.low), width: `calc(${x(shown.high)} - ${x(shown.low)})` }} />}
        {recording && live !== null && <i className="needle" style={{ left: x(live) }} />}
        {recording && <i className="vu" style={{ transform: `scaleX(${level})` }} />}
      </div>
      <span className="dim">{recording ? "Sing slowly from the lowest to the highest comfortable note." : "Sing low to high, and the song moves to the right key."}</span>
      <div className="row">
        {recording ? (
          <button className="btn big" onClick={stop}>
            ■ Done
          </button>
        ) : (
          <button className="btn big rec" onClick={start}>
            ● Measure
          </button>
        )}
        {profile && !recording && suggestion !== null && (
          <button className="btn big" onClick={onApply}>
            Fit song to me ({suggestion > 0 ? "+" : ""}
            {suggestion})
          </button>
        )}
      </div>
    </div>
  );
}
