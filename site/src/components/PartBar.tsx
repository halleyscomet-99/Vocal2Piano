// Strip above the timeline for changing one part of the song: the bars picked by
// dragging across the bar numbers get their own speed, piano style, or are cut; a
// note clicked on the Piano track can be left out or held longer or shorter.

import { STYLES, type Style } from "../engine/arranger";
import { type BarEdit, type BarEdits, isPlain } from "../engine/parts";

export interface PickedNote {
  name: string;
  bar: number;
  beat: number;
  beats: number; // length
  muted: boolean;
  changed: boolean;
}

export type NotePatch = { mute: boolean } | { beats: number };

interface Props {
  sel: [number, number] | null;
  edits: BarEdits;
  note: PickedNote | null;
  onNote: (p: NotePatch | null) => void;
  onNoteClose: () => void;
  noteChanges: number;
  /** What "no style change" means here: "As written" for song files, "Song style" for chord charts. */
  styleNote: string;
  onChange: (patch: BarEdit | null) => void;
  onClose: () => void;
  onResetAll: () => void;
}

const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5];

const beatsText = (b: number) => {
  const r = Math.round(b * 4) / 4;
  const whole = Math.floor(r);
  const frac = ["", "¼", "½", "¾"][Math.round((r - whole) * 4)];
  return `${whole || frac ? `${whole || ""}${frac}` : "0"} ${r === 1 ? "beat" : "beats"}`;
};

function NoteBar({ note, onNote, onClose }: { note: PickedNote; onNote: Props["onNote"]; onClose: () => void }) {
  return (
    <div className="toolbar partbar on">
      <b>
        {note.name} · bar {note.bar}, beat {note.beat}
      </b>
      <span className="divider" />
      <span className="tl">
        Length
        <span className="spin" title="How long the key is held">
          <button className="btn" onClick={() => onNote({ beats: note.beats - 0.25 })} disabled={note.beats <= 0.25 + 1e-6} aria-label="Shorter">
            −
          </button>
          <output className="sunken">{beatsText(note.beats)}</output>
          <button className="btn" onClick={() => onNote({ beats: note.beats + 0.25 })} aria-label="Longer">
            +
          </button>
        </span>
      </span>
      <button className={`btn ${note.muted ? "pressed" : ""}`} onClick={() => onNote({ mute: !note.muted })} title="Leave this note out (Delete key)">
        {note.muted ? "♪ Play it again" : "🔇 Don't play"}
      </button>
      <button className="btn" onClick={() => onNote(null)} disabled={!note.changed} title="Back to the note as written">
        ↺ Reset
      </button>
      <span className="grow" />
      <button className="btn icon" onClick={onClose} title="Done (Esc)" aria-label="Done">
        ✕
      </button>
    </div>
  );
}

export function PartBar({ sel, edits, note, onNote, onNoteClose, noteChanges, styleNote, onChange, onClose, onResetAll }: Props) {
  if (note) return <NoteBar note={note} onNote={onNote} onClose={onNoteClose} />;
  const changed = Object.values(edits).filter((e) => !isPlain(e)).length;
  if (!sel) {
    const parts = [changed && `${changed} ${changed === 1 ? "bar" : "bars"}`, noteChanges && `${noteChanges} ${noteChanges === 1 ? "note" : "notes"}`].filter(Boolean).join(", ");
    return (
      <div className="toolbar partbar">
        <span className="dim grow">Drag across the bar numbers to change a part · click a note on the Piano track to change just that note.</span>
        {parts && (
          <button className="btn" onClick={onResetAll} title="Undo every part and note change">
            ↺ Reset all ({parts})
          </button>
        )}
      </div>
    );
  }
  const [a, b] = sel;
  const bars = Array.from({ length: b - a + 1 }, (_, i) => edits[a + i]);
  const same = <T,>(f: (e: BarEdit | undefined) => T) => (bars.every((e) => f(e) === f(bars[0])) ? f(bars[0]) : undefined);
  const speed = same((e) => e?.speed ?? 1);
  const style = same((e) => e?.style ?? "");
  const step = (d: number) => {
    const cur = speed ?? 1;
    const i = SPEEDS.findIndex((s) => s >= cur - 1e-6);
    onChange({ speed: SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.length - 1 : i) + d))] });
  };
  return (
    <div className="toolbar partbar on">
      <b>{a === b ? `Bar ${a + 1}` : `Bars ${a + 1}–${b + 1}`}</b>
      <span className="divider" />
      <span className="tl">
        Speed
        <span className="spin" title="Speed of these bars only">
          <button className="btn" onClick={() => step(-1)} aria-label="Slower">
            −
          </button>
          <output className="sunken">{speed === undefined ? "mixed" : `${Math.round(speed * 100)}%`}</output>
          <button className="btn" onClick={() => step(1)} aria-label="Faster">
            +
          </button>
        </span>
      </span>
      <span className="tl">
        Play as
        <select value={style ?? "mixed"} onChange={(e) => onChange({ style: (e.target.value || undefined) as Style | undefined })} aria-label="Piano style for these bars">
          {style === undefined && (
            <option value="mixed" disabled>
              mixed
            </option>
          )}
          <option value="">{styleNote}</option>
          {STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </span>
      <span className="divider" />
      <button className="btn" onClick={() => onChange({ cut: true })} title="Leave these bars out (click ✂ on the ruler to bring them back)">
        ✂ Cut
      </button>
      <button className="btn" onClick={() => onChange(null)} title="Back to how the whole song is set">
        ↺ Reset
      </button>
      <span className="grow" />
      <button className="btn icon" onClick={onClose} title="Done" aria-label="Done">
        ✕
      </button>
    </div>
  );
}
