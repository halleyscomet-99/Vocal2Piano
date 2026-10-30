import type { ListenOptions } from "../engine/listen";
import type { PitchReport } from "../engine/pitchCheck";
import { noteName } from "../engine/robot";
import { SCHEMES } from "../themes";
import { Icon, type IconName } from "./Icons";

const fmt = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, "0")}`;
const cents = (c: number) => (Math.abs(c) < 10 ? "on pitch" : `${Math.abs(c)}¢ ${c > 0 ? "sharp" : "flat"}`);

/** After a recording, or singing with Listen on: how it went, and which lines to practise. */
export function ReportWindow({ report, onSeek }: { report: PitchReport; onSeek: (t: number) => void }) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const timing = report.timingMs;
  return (
    <div className="win-body">
      {report.notes.length === 0 ? (
        <span>The singing doesn't overlap the tune. Sing while the song plays.</span>
      ) : (
        <>
          <div className="stats">
            <div className={`sunken ${report.inTune < 0.7 ? "bad" : ""}`}>
              <b>{pct(report.inTune)}</b>
              <span>in tune</span>
            </div>
            <div className={`sunken ${report.heard < 0.8 ? "bad" : ""}`}>
              <b>{pct(report.heard)}</b>
              <span>notes sung</span>
            </div>
            <div className="sunken">
              <b>{Math.abs(report.meanCents) < 10 ? "✓" : `${report.meanCents > 0 ? "+" : "−"}${Math.abs(report.meanCents)}¢`}</b>
              <span>{cents(report.meanCents)}</span>
            </div>
            {timing !== null && (
              <div className={`sunken ${Math.abs(timing) > 120 ? "bad" : ""}`}>
                <b>{Math.abs(timing) < 40 ? "✓" : `${timing > 0 ? "+" : "−"}${Math.abs(timing)}`}</b>
                <span>{Math.abs(timing) < 40 ? "on the beat" : `ms ${timing > 0 ? "late" : "early"}`}</span>
              </div>
            )}
          </div>
          <ul className="list sunken phrases">
            <li className="head">
              <span>Time</span>
              <span>Line</span>
              <span>Pitch</span>
            </li>
            {report.phrases.map((ph, i) => {
              const bad = ph.meanAbsCents > 50 || ph.missed > ph.notes / 3;
              return (
                <li key={i} className="click" onClick={() => onSeek(Math.max(0, ph.start - 0.5))}>
                  <time>{fmt(ph.start)}</time>
                  <span className={bad ? "bad" : ""}>{bad ? "✗ Practise" : "✓ Good"}</span>
                  <span>{ph.notes > ph.missed ? `${ph.meanAbsCents}¢ off · mostly ${cents(ph.meanCents)}` : "not heard"}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

interface SettingsProps {
  split: number;
  onSplit: (n: number) => void;
  maxVoices: number;
  onMaxVoices: (n: number) => void;
  fold: boolean;
  onFold: (b: boolean) => void;
  listen: ListenOptions;
  onListen: (o: ListenOptions) => void;
  scheme: string;
  onScheme: (id: string) => void;
}

export function SettingsWindow(p: SettingsProps) {
  return (
    <div className="win-body">
      <fieldset className="group">
        <legend>Appearance</legend>
        <div className="row">
          <span className="grow">Color scheme</span>
          <select value={p.scheme} onChange={(e) => p.onScheme(e.target.value)} aria-label="Color scheme">
            {Object.entries(SCHEMES).map(([id, s]) => (
              <option key={id} value={id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <fieldset className="group">
        <legend>Listening (👂 Listen in Rehearsal)</legend>
        {(
          [
            ["wait", "Wait for me to come in, and when I stop", "At the start of each line it waits for the voice. When the singing stops mid-line it stops too, then carries on from where the singing picks up."],
            ["loudness", "Play as loud as I sing", "Louder singing than usual makes the piano louder; softer singing makes it softer."],
            ["key", "Move to the key I sing in", "When a whole line is sung higher or lower than written, the piano moves there after that line."],
          ] as [keyof ListenOptions, string, string][]
        ).map(([k, label, tip]) => (
          <label key={k} className="check" title={tip}>
            <input type="checkbox" checked={p.listen[k]} onChange={(e) => p.onListen({ ...p.listen, [k]: e.target.checked })} />
            <span>{label}</span>
          </label>
        ))}
        <span className="dim">Works best with headphones, or a microphone close to the mouth, so it doesn't take the piano for the voice.</span>
      </fieldset>
      <fieldset className="group">
        <legend>Robot</legend>
        <div className="row">
          <span className="grow">Left / right hand split</span>
          <span className="spin">
            <button className="btn" onClick={() => p.onSplit(Math.max(36, p.split - 1))} aria-label="Split lower">
              ◀
            </button>
            <output className="sunken">{noteName(p.split)}</output>
            <button className="btn" onClick={() => p.onSplit(Math.min(84, p.split + 1))} aria-label="Split higher">
              ▶
            </button>
          </span>
        </div>
        <div className="row">
          <span className="grow">Most notes per hand</span>
          <select value={p.maxVoices} onChange={(e) => p.onMaxVoices(Number(e.target.value))} aria-label="Most notes per hand">
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={0}>No limit</option>
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={p.fold} onChange={(e) => p.onFold(e.target.checked)} />
          <span>Out-of-reach notes move an octave</span>
        </label>
      </fieldset>
    </div>
  );
}

const STEPS: { icon: IconName; id: string; title: string; text: string }[] = [
  { icon: "songs", id: "songs", title: "1. Songs", text: "Open a song, or hum one." },
  { icon: "mic", id: "voice", title: "2. My Voice", text: "Find the key that fits the voice." },
  { icon: "player", id: "player", title: "3. Rehearsal", text: "Press ▶ and sing." },
  { icon: "robot", id: "robot", title: "4. Robot", text: "Send it to the real piano." },
];

export function WelcomeWindow({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  return (
    <div className="win-body welcome">
      <b>Sing, and a robot piano plays along.</b>
      <ol>
        {STEPS.map((s) => (
          <li key={s.id}>
            <Icon name={s.icon} />
            <div className="grow">
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
            <button className="btn" onClick={() => onOpen(s.id)}>
              Open
            </button>
          </li>
        ))}
      </ol>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}

export function MessageBox({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="win-body">
      <div className="msgbox">
        <Icon name="warn" />
        <span>{message}</span>
      </div>
      <div className="row end">
        <button className="btn" onClick={onClose} autoFocus>
          OK
        </button>
      </div>
    </div>
  );
}
