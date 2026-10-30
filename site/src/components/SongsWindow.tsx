import { useState } from "react";
import { CORPUS_SONGS, PROGRESSIONS, STYLES, type Style } from "../engine/arranger";
import { type Role, type Score, type ScoreSongOptions, trackSummary } from "../engine/score";
import type { HumView } from "../humSession";
import { Icon } from "./Icons";

export type SourceKind = "file" | "hum" | "demo";

export interface LocalDemo {
  name: string;
  file: string; // path under /local/
  bpm?: number;
  bars?: number;
  source?: "score" | "recording";
}

interface Props {
  kind: SourceKind;
  onKind: (k: SourceKind) => void;
  score: Score | null;
  roles: Role[];
  onRoles: (r: Role[]) => void;
  scoreOpts: ScoreSongOptions;
  onScoreOpts: (o: ScoreSongOptions) => void;
  onFile: (f: File) => void;
  /** Start humming: four clicks, then hum. */
  onHumStart: (bpm: number, click: boolean) => void;
  onHumStop: () => void;
  /** While humming; "working" while the tune is turned into a song. */
  humView: HumView | "working" | null;
  /** The last humming as audio, to check it was heard. */
  humAudio: string | null;
  hummed: { notes: number; key: string } | null;
  /** How much the chords follow the tune (HMM melody weight). */
  humWeight: number;
  onHumWeight: (w: number) => void;
  prog: string;
  onProg: (id: string) => void;
  style: Style;
  onStyle: (s: Style) => void;
  flourish: number;
  onFlourish: (n: number) => void;
  onChords: () => void;
  /** MIDI demos kept in site/local/ on this computer (dev server only). */
  localDemos: LocalDemo[];
  onLocalDemo: (d: LocalDemo) => void;
}

const ROLE_LABEL: Record<Role, string> = { melody: "Me", piano: "Robot", off: "Off" };

function FileTab({ score, roles, onRoles, scoreOpts, onScoreOpts, onFile }: Pick<Props, "score" | "roles" | "onRoles" | "scoreOpts" | "onScoreOpts" | "onFile">) {
  const [over, setOver] = useState(false);
  const setRole = (i: number, r: Role) => onRoles(roles.map((old, j) => (j === i ? r : r === "melody" && old === "melody" ? "piano" : old)));
  return (
    <>
      <label
        className={`drop sunken ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
        }}
      >
        <input type="file" accept=".mid,.midi,.musicxml,.xml,.mxl" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <Icon name="songs" />
        <span>{score ? <b>{score.name}</b> : "Open a song (.mid, .musicxml, .mxl)"}</span>
      </label>

      {score && (
        <>
          <ul className="list sunken parts">
            <li className="head">
              <span>Part</span>
              <span>Notes</span>
              <span>Who plays</span>
            </li>
            {score.tracks.map((t, i) => (
              <li key={i}>
                <span title={t.name}>{t.name}</span>
                <span>{t.drum ? "drums" : trackSummary(t).count}</span>
                <select value={roles[i]} disabled={t.drum} onChange={(e) => setRole(i, e.target.value as Role)} aria-label={`Who plays ${t.name}`}>
                  {(["melody", "piano", "off"] as Role[]).map((r) => (
                    <option key={r} value={r}>
                      {r === "melody" ? "🎤 " : r === "piano" ? "🤖 " : ""}
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          {!roles.includes("melody") && (
            <label className="check">
              <input type="checkbox" checked={scoreOpts.topLine} onChange={(e) => onScoreOpts({ ...scoreOpts, topLine: e.target.checked })} />
              <span>I sing the top line of the piano</span>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={scoreOpts.guide} onChange={(e) => onScoreOpts({ ...scoreOpts, guide: e.target.checked })} />
            <span>Robot plays my tune too (to learn it)</span>
          </label>
        </>
      )}
    </>
  );
}

function HumTab({ onHumStart, onHumStop, humView, humAudio, hummed, humWeight, onHumWeight }: Pick<Props, "onHumStart" | "onHumStop" | "humView" | "humAudio" | "hummed" | "humWeight" | "onHumWeight">) {
  const [bpm, setBpm] = useState(90);
  const [clickOn, setClickOn] = useState(true);
  const v = humView === "working" ? null : humView;
  const busy = humView !== null;
  return (
    <>
      <div className="row">
        <span>Tempo</span>
        <span className="spin">
          <button className="btn" disabled={busy} onClick={() => setBpm((b) => Math.max(50, b - 5))} aria-label="Slower">
            ◀
          </button>
          <output className="sunken">{bpm}</output>
          <button className="btn" disabled={busy} onClick={() => setBpm((b) => Math.min(160, b + 5))} aria-label="Faster">
            ▶
          </button>
        </span>
        <span className="dim">bpm</span>
        <span className="grow" />
        <label className="check">
          <input type="checkbox" checked={clickOn} disabled={busy} onChange={(e) => setClickOn(e.target.checked)} />
          <span>Click</span>
        </label>
      </div>
      <div className="hum-state lcd">
        {humView === "working"
          ? "listening…"
          : v
            ? v.phase === "countin"
              ? `${Math.min(4, Math.max(1, v.beat + 1))}…`
              : `● bar ${Math.floor((v.beat - 4) / 4) + 1}`
            : hummed
              ? `${hummed.notes} notes · ${hummed.key}`
              : "ready"}
      </div>
      {v && (
        <div className="row" title="What the microphone hears. The lamp lights and a note shows when it hears humming.">
          <i className={`led ${v.note ? "on" : ""}`} />
          <span className="hum-meter sunken">
            <i style={{ transform: `scaleX(${v.level})` }} className={v.note ? "on" : ""} />
          </span>
          <output className="hum-note">{v.note ?? "—"}</output>
          <span className="dim">{v.heard.toFixed(0)} s heard</span>
        </div>
      )}
      {!busy && humAudio && (
        <div className="row">
          <span className="dim grow">What the microphone recorded:</span>
          <audio src={humAudio} controls aria-label="Recorded humming" />
        </div>
      )}
      {!busy || humView === "working" ? (
        <button className="btn big rec" onClick={() => onHumStart(bpm, clickOn)} disabled={humView === "working"}>
          ● Record
        </button>
      ) : (
        <button className="btn big" onClick={onHumStop}>
          ■ Done
        </button>
      )}
      <span className="dim">4 clicks, then hum. Chords are added automatically.</span>
      {hummed && (
        <div className="row" title="How closely the chords follow the tune. The middle is what matched real pop songs best.">
          <span>Chord changes</span>
          <span className="dim">fewer</span>
          <input type="range" className="grow" min={1} max={6} step={0.5} value={humWeight} onChange={(e) => onHumWeight(Number(e.target.value))} aria-label="Chord changes" />
          <span className="dim">more</span>
        </div>
      )}
    </>
  );
}

export function SongsWindow(p: Props) {
  const usesChart = p.kind === "demo" || (p.kind === "hum" && p.hummed);
  return (
    <div className="win-body songs">
      <div>
        <div className="tabs" role="tablist">
          {(
            [
              ["file", "Song file"],
              ["hum", "Hum"],
              ["demo", "Demo"],
            ] as [SourceKind, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={p.kind === k} className={p.kind === k ? "on" : ""} onClick={() => p.onKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="tab-page">
          {p.kind === "file" && <FileTab {...p} />}
          {p.kind === "hum" && <HumTab {...p} />}
          {p.kind === "demo" && (
            <>
              <ul className="list sunken demo-list">
                <li className="head">
                  <span />
                  <span>Loop</span>
                  <span>Chords</span>
                  <span title="Share of songs in the McGill Billboard corpus that use this loop">Hits</span>
                </li>
                {PROGRESSIONS.map((g) => (
                  <li key={g.id} className={`click ${p.prog === g.id ? "sel" : ""}`} onClick={() => p.onProg(g.id)}>
                    <span>{p.prog === g.id ? "▶" : ""}</span>
                    <b>{g.name}</b>
                    <span>{g.chords.join(" ")}</span>
                    <span>{Math.round(g.share * 100)}%</span>
                  </li>
                ))}
              </ul>
              <span className="dim">
                The most common chord loops in {CORPUS_SONGS.major + CORPUS_SONGS.minor} Billboard hits, 1958–91 (McGill Billboard corpus).
              </span>
              {p.localDemos.length > 0 && (
                <>
                  <ul className="list sunken demo-list">
                    <li className="head">
                      <span />
                      <span>My songs</span>
                      <span>From</span>
                      <span>Bars</span>
                    </li>
                    {p.localDemos.map((d) => (
                      <li key={d.file} className="click" onClick={() => p.onLocalDemo(d)} title="Opens it as a song file">
                        <span>♫</span>
                        <b>{d.name}</b>
                        <span>
                          {d.source === "recording" ? "Recording" : d.source === "score" ? "Sheet music" : "MIDI"}
                          {d.bpm ? ` · ${d.bpm} bpm` : ""}
                        </span>
                        <span>{d.bars ?? ""}</span>
                      </li>
                    ))}
                  </ul>
                  <span className="dim">Local files in site/local. They stay on this computer.</span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {usesChart && (
        <div className="row">
          <select value={p.style} onChange={(e) => p.onStyle(e.target.value as Style)} aria-label="Piano style" title="Piano style">
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <select value={p.flourish} onChange={(e) => p.onFlourish(Number(e.target.value))} aria-label="Extra notes" title="Extra notes">
            <option value={0}>Plain</option>
            <option value={1}>Pickups</option>
            <option value={2}>Ornate</option>
          </select>
          <span className="grow" />
          <button className="btn" onClick={p.onChords}>
            Chords…
          </button>
        </div>
      )}
    </div>
  );
}
