"""How pop melodies sit on chords, and how pop chords move, from the POP909 dataset.

Source: Z. Wang et al., "POP909: A Pop-song Dataset for Music Arrangement Generation", ISMIR 2020.
909 Chinese pop songs, each with a separate MELODY track and beat-aligned chord labels. MIT license:
https://github.com/music-x-lab/POP909-Dataset

Usage (needs mido):
    curl -L -o pop.zip https://github.com/music-x-lab/POP909-Dataset/raw/master/POP909.zip && unzip pop.zip
    python3 pop909_stats.py POP909 ../site/src/engine/billboardStats.ts > ../site/src/engine/melodyStats.ts

Writes, for the harmonizer:
  - maj/min: share of melody time (beats; each note counted up to two beats) at each interval
    0–11 semitones above the root of a major or minor chord
  - majorNextHalf/minorNextHalf: half-bar to half-bar chord transitions over the six diatonic triads
and prints on stderr how often the harmonizer's model picks the annotated chord on songs it
did not learn from (every other song held out), next to simpler baselines.
"""

import json
import math
import sys
from collections import Counter
from pathlib import Path

import mido

PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
MAJOR = [(0, "maj"), (2, "min"), (4, "min"), (5, "maj"), (7, "maj"), (9, "min")]  # I ii iii IV V vi
MINOR = [(0, "min"), (3, "maj"), (5, "min"), (7, "maj"), (8, "maj"), (10, "maj")]  # i III iv V VI VII


def pitch_class(name):
    pc = PC[name[0]]
    for a in name[1:]:
        pc += 1 if a == "#" else -1 if a == "b" else 0
    return pc % 12


def simplify(label):
    if ":" not in label:
        return None
    root, q = label.split(":", 1)
    q = q.split("/")[0]
    if q.startswith("min") and not q.startswith("minmaj"):
        return pitch_class(root), "min"
    if q.startswith(("maj", "7", "9", "11", "13", "sus")) or q == "":
        return pitch_class(root), "maj"
    return None  # dim, hdim, aug …


def melody_notes(path):
    """(start s, end s, midi) of the MELODY track, using the file's tempo map."""
    mid = mido.MidiFile(path)
    tempo_events = []
    for tr in mid.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "set_tempo":
                tempo_events.append((t, msg.tempo))
    tempo_events.sort()
    if not tempo_events or tempo_events[0][0] > 0:
        tempo_events.insert(0, (0, 500000))

    def sec(tick):
        s, last_t, last_tempo = 0.0, 0, tempo_events[0][1]
        for t, tempo in tempo_events[1:]:
            if t >= tick:
                break
            s += (t - last_t) * last_tempo / mid.ticks_per_beat / 1e6
            last_t, last_tempo = t, tempo
        return s + (tick - last_t) * last_tempo / mid.ticks_per_beat / 1e6

    for tr in mid.tracks:
        if tr.name.strip().upper() != "MELODY":
            continue
        t, on, out = 0, {}, []
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                on[msg.note] = t
            elif msg.type in ("note_off", "note_on") and msg.note in on:
                out.append((sec(on.pop(msg.note)), sec(t), msg.note))
        return sorted(out)
    return []


def load(folder):
    f = Path(folder)
    name = f.name
    beats = [list(map(float, l.split())) for l in (f / "beat_midi.txt").read_text().splitlines() if l.strip()]
    bar_starts = [b[0] for b in beats if b[2] == 1.0]
    beat_times = [b[0] for b in beats]
    if len(bar_starts) < 8:
        return None
    # keep 4/4 songs only: four beats between downbeats
    idx = [i for i, b in enumerate(beats) if b[2] == 1.0]
    if Counter(j - i for i, j in zip(idx, idx[1:])).most_common(1)[0][0] != 4:
        return None
    chords = []
    for l in (f / "chord_midi.txt").read_text().splitlines():
        p = l.split("\t")
        if len(p) >= 3:
            chords.append((float(p[0]), float(p[1]), simplify(p[2].strip())))
    keys = [l.split("\t")[2].strip() for l in (f / "key_audio.txt").read_text().splitlines() if l.count("\t") >= 2]
    if not keys or ":" not in keys[0]:
        return None
    tonic = pitch_class(keys[0].split(":")[0])
    minor = keys[0].split(":")[1].startswith("min")
    mel = melody_notes(f / f"{name}.mid")
    beat = (beat_times[-1] - beat_times[0]) / max(1, len(beat_times) - 1)
    # half bars from consecutive downbeats
    halves = []
    for a, b in zip(bar_starts, bar_starts[1:]):
        m = (a + b) / 2
        halves += [(a, m), (m, b)]
    return {"tonic": tonic, "minor": minor, "mel": mel, "chords": chords, "halves": halves, "beat": beat}


def chord_at(chords, t):
    for a, b, c in chords:
        if a <= t + 1e-3 < b:
            return c
    return None


def emission(songs):
    hist = {"maj": [0.0] * 12, "min": [0.0] * 12}
    for s in songs:
        for a, b, c in s["chords"]:
            if not c:
                continue
            for n0, n1, m in s["mel"]:
                n1 = min(n1, n0 + 2 * s["beat"])
                ov = min(b, n1) - max(a, n0)
                if ov > 0:
                    hist[c[1]][(m - c[0]) % 12] += ov / s["beat"]
    out = {}
    for q, h in hist.items():
        tot = sum(h) + 12 * 0.5
        out[q] = [round((x + 0.5) / tot, 4) for x in h]
    return out


def degrees(s):
    S = MINOR if s["minor"] else MAJOR
    out = []
    for a, b in s["halves"]:
        c = chord_at(s["chords"], a)
        rel = None if c is None else ((c[0] - s["tonic"]) % 12, c[1])
        out.append(S.index(rel) if rel in S else None)
    return out


def transitions(songs):
    t = {"major": Counter(), "minor": Counter()}
    for s in songs:
        d = degrees(s)
        mode = "minor" if s["minor"] else "major"
        for a, b in zip(d, d[1:]):
            if a is not None and b is not None:
                t[mode][(a, b)] += 1
    out = {}
    for mode in ("major", "minor"):
        rows = []
        for a in range(6):
            counts = [t[mode][(a, b)] + 1 for b in range(6)]
            tot = sum(counts)
            rows.append([round(c / tot, 4) for c in counts])
        out[mode + "NextHalf"] = rows
    return out


def evaluate(songs, emit, trans, w=1.0):
    hit = tot = 0
    for s in songs:
        S = MINOR if s["minor"] else MAJOR
        T = trans["minorNextHalf" if s["minor"] else "majorNextHalf"]
        chordset = [((s["tonic"] + o) % 12, q) for o, q in S]

        def em(a, b, c):
            v = 0.0
            for n0, n1, m in s["mel"]:
                n1 = min(n1, n0 + 2 * s["beat"])
                ov = min(b, n1) - max(a, n0)
                if ov > 0:
                    v += (ov / s["beat"]) * math.log(emit[c[1]][(m - c[0]) % 12])
            return w * v

        H = s["halves"]
        score = [em(*H[0], c) for c in chordset]
        back = []
        for a, b in H[1:]:
            ptr, ns = [], []
            for j, c in enumerate(chordset):
                i = max(range(6), key=lambda i: score[i] + math.log(T[i][j]))
                ptr.append(i)
                ns.append(score[i] + math.log(T[i][j]) + em(a, b, c))
            back.append(ptr)
            score = ns
        c = max(range(6), key=lambda i: score[i])
        path = [c]
        for ptr in reversed(back):
            c = ptr[c]
            path.insert(0, c)
        truth = degrees(s)
        for (a, b), p, t in zip(H, path, truth):
            if t is None or not any(min(n1, b) > max(n0, a) for n0, n1, _ in s["mel"]):
                continue
            tot += 1
            hit += p == t
    return hit / max(1, tot), tot


def main(root, billboard_ts):
    songs = [s for f in sorted(Path(root).iterdir()) if f.is_dir() and (s := load(f))]
    train, test = songs[::2], songs[1::2]
    bbs = Path(billboard_ts).read_text()
    bb = json.loads(bbs[bbs.index("{") : bbs.rindex("}") + 1])
    e_tr, t_tr = emission(train), transitions(train)
    flat = {k: [[1 / 6] * 6 for _ in range(6)] for k in ("majorNextHalf", "minorNextHalf")}
    uni = {"maj": [1 / 12] * 12, "min": [1 / 12] * 12}
    log = sys.stderr
    print(f"songs: {len(songs)} (train {len(train)}, test {len(test)}); accuracy per half bar on test songs:", file=log)
    print(f"  transitions only (ignore melody): {evaluate(test, uni, t_tr)[0]:.1%}", file=log)
    print(f"  melody only (no transitions):     {evaluate(test, e_tr, flat)[0]:.1%}", file=log)
    print(f"  melody + Billboard transitions:   {evaluate(test, e_tr, bb)[0]:.1%}", file=log)
    for w in (0.5, 1, 1.5, 2, 3):
        print(f"  melody x{w} + POP909 transitions:  train {evaluate(train, e_tr, t_tr, w)[0]:.1%}  test {evaluate(test, e_tr, t_tr, w)[0]:.1%}", file=log)

    stats = {"songs": len(songs), **emission(songs), **transitions(songs)}
    print("// Generated by software/pop909_stats.py from the POP909 dataset")
    print("// (Wang et al., ISMIR 2020; MIT license). Do not edit by hand.")
    print("// maj/min: share of melody time at each interval (0-11 semitones) above a major or minor chord's root.")
    print("// *NextHalf: half-bar chord transitions over the diatonic triads (major I ii iii IV V vi, minor i III iv V VI VII).")
    print(f"export const POP909 = {json.dumps(stats, indent=2)} as const;")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
