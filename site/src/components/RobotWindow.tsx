import { useMemo, useState } from "react";
import { ROBOT } from "../engine/robot";
import type { Plan, WarningKind } from "../engine/types";
import { RobotLink } from "../robotLink";
import { PROBLEM_LABEL, SEVERE } from "./problems";

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

interface Props {
  plan: Plan;
  link: RobotLink;
  live: boolean;
  onLive: (on: boolean) => void;
  onExport: () => void;
  onSeek: (t: number) => void;
}

export function RobotWindow({ plan, link, live, onLive, onExport, onSeek }: Props) {
  const [tab, setTab] = useState<"robot" | "problems">("robot");
  const [onlyBad, setOnlyBad] = useState(true);
  const playable = plan.stats.notes ? Math.round((plan.stats.played / plan.stats.notes) * 100) : 100;
  const severe = plan.warnings.filter((w) => SEVERE.has(w.kind));
  const shown = (onlyBad ? severe : plan.warnings).slice(0, 300);
  const counts = useMemo(() => {
    const c = new Map<WarningKind, number>();
    for (const w of plan.warnings) c.set(w.kind, (c.get(w.kind) ?? 0) + 1);
    return c;
  }, [plan]);
  const connected = link.status === "connected";

  return (
    <div className="win-body">
      <div className="stats">
        <div className={`sunken ${playable < 100 ? "bad" : ""}`}>
          <b>{playable}%</b>
          <span>playable</span>
        </div>
        <div className={`sunken ${severe.length ? "bad" : ""}`}>
          <b>{severe.length}</b>
          <span>problems</span>
        </div>
        <div className={`sunken ${plan.stats.peakAmps > ROBOT.solenoidBudgetAmps ? "bad" : ""}`}>
          <b>{plan.stats.peakAmps.toFixed(1)}A</b>
          <span>of {ROBOT.solenoidBudgetAmps}A</span>
        </div>
      </div>

      <div>
        <div className="tabs" role="tablist">
          <button role="tab" className={tab === "robot" ? "on" : ""} onClick={() => setTab("robot")}>
            Connect
          </button>
          <button role="tab" className={tab === "problems" ? "on" : ""} onClick={() => setTab("problems")}>
            Problems ({plan.warnings.length})
          </button>
        </div>
        <div className="tab-page">
          {tab === "robot" &&
            (!RobotLink.supported() ? (
              <span className="dim">USB needs Chrome or Edge on a computer.</span>
            ) : (
              <>
                <div className="row">
                  {connected ? (
                    <button className="btn" onClick={() => void link.disconnect()}>
                      Disconnect
                    </button>
                  ) : (
                    <button className="btn" onClick={() => void link.connect()} disabled={link.status === "connecting"}>
                      {link.status === "connecting" ? "Connecting…" : "Connect…"}
                    </button>
                  )}
                  <button className="btn" onClick={() => link.home()} disabled={!connected} title="Move both hands to their end stops">
                    Home
                  </button>
                  <span className="dim">{connected ? (link.device ?? "waiting for robot…") + (link.homed ? " · homed" : "") : "not connected"}</span>
                </div>
                <label className="check">
                  <input type="checkbox" checked={live} disabled={!connected} onChange={(e) => onLive(e.target.checked)} />
                  <span>Play on the real robot</span>
                </label>
                <pre className="serial-log sunken" aria-label="Robot messages">
                  {link.log.slice(-8).join("\n") || " "}
                </pre>
              </>
            ))}
          {tab === "problems" && (
            <>
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} />
                  <span>Only real problems</span>
                </label>
                <span className="dim">
                  {[...counts].map(([k, n]) => `${PROBLEM_LABEL[k]} ${n}`).join(" · ") || "none"}
                </span>
              </div>
              <ul className="list sunken problems">
                {shown.length === 0 && <li>Nothing to fix.</li>}
                {shown.map((w, i) => (
                  <li key={i} className="click" onClick={() => onSeek(Math.max(0, w.time - 1))} title={w.message}>
                    <time>{fmt(w.time)}</time>
                    <span className={SEVERE.has(w.kind) ? "bad" : ""}>{PROBLEM_LABEL[w.kind]}</span>
                    <span>{w.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="row end">
        <button className="btn" onClick={onExport}>
          Save performance file…
        </button>
      </div>
    </div>
  );
}
