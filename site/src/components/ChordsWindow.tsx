import { useState } from "react";
import { type BarDynamic, type ChordChart, QUALITY_SUFFIX, parseChord } from "../engine/arranger";

const ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const TYPES: [string, string][] = [
  ["maj", "Major"],
  ["min", "Minor"],
  ["7", "7"],
  ["maj7", "maj7"],
  ["m7", "m7"],
  ["sus4", "sus4"],
  ["dim", "dim"],
];

interface Props {
  chart: ChordChart;
  onChange: (c: ChordChart) => void;
  onReset: () => void;
  /** Bars are tied to a hummed melody: chords can change, bars can't be added or removed. */
  fixedLength?: boolean;
}

export function ChordsWindow({ chart, onChange, onReset, fixedLength }: Props) {
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, chart.chords.length - 1);
  const halves = chart.chords[i].split(" ");
  const parse = (h: string | undefined) => (!h || h === "N" ? null : parseChord(h));
  const rootIdx = (c: ReturnType<typeof parse>) => (c ? ROOTS.findIndex((r) => parseChord(r).root === c.root) : -1);
  const dyn = chart.chords.map((_, k) => chart.dyn?.[k] ?? null);

  // Write one half (0 or 1) of the selected bar; a bar whose halves match is stored as one chord.
  const setHalf = (h: number, sym: string) => {
    const next = [...halves];
    next[h] = sym;
    if (next.length === 1 && h === 1) next.unshift(halves[0]);
    const bar = next[1] === undefined || next[1] === next[0] ? next[0] : `${next[0]} ${next[1]}`;
    onChange({ ...chart, chords: chart.chords.map((c, k) => (k === i ? bar : c)) });
  };
  const setRoot = (h: number, r: number) => setHalf(h, ROOTS[r] + QUALITY_SUFFIX[parse(halves[h])?.quality ?? "maj"]);
  const setType = (h: number, q: string) => {
    const r = rootIdx(parse(halves[h]));
    setHalf(h, q === "N" ? "N" : ROOTS[r < 0 ? 0 : r] + QUALITY_SUFFIX[q]);
  };
  const split = (on: boolean) =>
    onChange({ ...chart, chords: chart.chords.map((c, k) => (k === i ? (on ? `${halves[0]} ${halves[0] === "N" ? "C" : halves[0]}` : halves[0]) : c)) });

  const half = (h: number) => {
    const cur = parse(halves[h]);
    return (
      <div className="row" key={h}>
        {halves.length > 1 && <span className="dim">{h === 0 ? "1st half" : "2nd half"}</span>}
        <select value={rootIdx(cur) < 0 ? "" : rootIdx(cur)} onChange={(e) => setRoot(h, Number(e.target.value))} disabled={!cur} aria-label="Root">
          {ROOTS.map((r, k) => (
            <option key={r} value={k}>
              {r}
            </option>
          ))}
        </select>
        <select value={cur?.quality ?? "N"} onChange={(e) => setType(h, e.target.value)} aria-label="Chord type">
          {TYPES.map(([q, label]) => (
            <option key={q} value={q}>
              {label}
            </option>
          ))}
          <option value="N">Rest</option>
        </select>
      </div>
    );
  };
  const sym = chart.chords[i];
  const setDyn = (d: BarDynamic) => onChange({ ...chart, dyn: dyn.map((x, k) => (k === i ? d : x)) });
  const insert = () => {
    const chords = [...chart.chords];
    chords.splice(i + 1, 0, sym);
    const d = [...dyn];
    d.splice(i + 1, 0, dyn[i]);
    onChange({ ...chart, chords, dyn: d });
    setSel(i + 1);
  };
  const remove = () => {
    if (chart.chords.length <= 1) return;
    onChange({ ...chart, chords: chart.chords.filter((_, k) => k !== i), dyn: dyn.filter((_, k) => k !== i) });
    setSel(Math.max(0, i - 1));
  };

  return (
    <div className="win-body">
      <div className="bars sunken">
        {chart.chords.map((c, k) => (
          <button key={k} className={`btn ${k === i ? "pressed" : ""} ${dyn[k] ?? ""}`} onClick={() => setSel(k)} title={`Bar ${k + 1}`}>
            <small>{k + 1}</small>
            {c === "N" ? "–" : c}
          </button>
        ))}
      </div>

      <fieldset className="group">
        <legend>Bar {i + 1}</legend>
        {half(0)}
        {halves.length > 1 && half(1)}
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={halves.length > 1} onChange={(e) => split(e.target.checked)} />
            <span>Change halfway</span>
          </label>
          <span className="grow" />
          <select value={dyn[i] ?? ""} onChange={(e) => setDyn((e.target.value || null) as BarDynamic)} aria-label="Loudness">
            <option value="soft">Soft</option>
            <option value="">Normal</option>
            <option value="full">Full</option>
          </select>
        </div>
        {!fixedLength && (
          <div className="row">
            <button className="btn" onClick={insert}>
              + Bar
            </button>
            <button className="btn" onClick={remove} disabled={chart.chords.length <= 1}>
              − Bar
            </button>
          </div>
        )}
      </fieldset>

      <div className="row">
        <label className="check">
          <input type="checkbox" checked={!!chart.intro} onChange={(e) => onChange({ ...chart, intro: e.target.checked })} />
          <span>Intro</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={!!chart.outro} onChange={(e) => onChange({ ...chart, outro: e.target.checked })} />
          <span>Rolled ending</span>
        </label>
        <span className="grow" />
        <button className="btn" onClick={onReset}>
          Reset
        </button>
      </div>
    </div>
  );
}
