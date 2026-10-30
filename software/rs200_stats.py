"""How melodies sit on chords, from the Rolling Stone 200 rock corpus.

Source: T. de Clercq & D. Temperley, "A corpus analysis of rock harmony", Popular Music 30(1), 2011,
and D. Temperley & T. de Clercq, "Statistical analysis of harmony and melody in rock music",
Journal of New Music Research 42(3), 2013. Data (v2.1) CC BY 4.0: https://rockcorpus.midside.com/

Usage:
    curl -L -o rc.zip https://rockcorpus.midside.com/versions/rock_corpus_v2-1.zip && unzip rc.zip
    python3 rs200_stats.py rock_corpus_v2-1 > ../site/src/engine/melodyStats.ts

Output: for major and minor chords, the share of melody time (in beats, each note counted up to
two beats) at each interval above the chord root, 0–11 semitones. The harmonizer uses these as
the probability of hearing a melody pitch over a chord. It also reports, on stderr, how often a
Viterbi harmonizer with these tables and the Billboard transition table picks the annotated chord.
"""

import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
SCALE = [0, 2, 4, 5, 7, 9, 11]
NUMERAL = {"I": 0, "II": 2, "III": 4, "IV": 5, "V": 7, "VI": 9, "VII": 11}
RN = r"(b|#)?(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)"


def key_pc(tok):
    pc = NOTE[tok[0]]
    for a in tok[1:]:
        pc += 1 if a == "#" else -1 if a == "b" else 0
    return pc % 12


def meter_beats(tok):
    n, d = tok.split("/")
    return int(n) * 4 / int(d)


def strip(line):
    return line.split("%", 1)[0]


# ---------------- harmony ----------------


def parse_chord(sym, key):
    """Roman numeral → (absolute root pc, 'maj'|'min'|None)."""
    m = re.fullmatch(RN + r"([^/]*)(?:/" + RN + r")?", sym)
    if not m:
        return None
    acc, num, suffix, acc2, num2 = m.groups()
    root = NUMERAL[num.upper()] + (1 if acc == "#" else -1 if acc == "b" else 0)
    if num2:
        root += NUMERAL[num2.upper()] + (1 if acc2 == "#" else -1 if acc2 == "b" else 0)
    if any(c in suffix for c in "oxha"):
        q = None  # diminished, half-diminished, augmented: outside the maj/min model
    else:
        q = "maj" if num.isupper() else "min"
    return (key + root) % 12, q


def expand_har(path):
    rules = {}
    for line in path.read_text(errors="replace").splitlines():
        line = strip(line)
        if ":" in line:
            name, rhs = line.split(":", 1)
            rules[name.strip()] = rhs
    measures = []  # list of (beats, [(pos fraction, chord or None)])
    pending = []
    state = {"last": None}

    def emit(beats, key):
        nonlocal pending
        syms = pending
        pending = []
        if not syms:  # empty measure: previous chord continues
            measures.append((beats, [(0.0, state["last"])]))
            return
        out = []
        for i, s in enumerate(syms):
            if s in (".", "R"):
                continue
            c = parse_chord(s, key)
            state["last"] = c
            out.append((i / len(syms), c))
        if not out:
            out = [(0.0, state["last"])]
        elif out[0][0] > 0:
            out.insert(0, (0.0, measures[-1][1][-1][1] if measures else None))
        measures.append((beats, out))

    def run(name, key, beats, depth=0):
        if depth > 40 or name not in rules:
            return
        for tok in rules[name].split():
            if tok.startswith("[") and tok.endswith("]"):
                body = tok[1:-1]
                if "/" in body:
                    beats = meter_beats(body)
                elif body == "0":
                    beats = 4
                elif re.fullmatch(r"[A-G][#b]?", body):
                    key = key_pc(body)
                continue
            m = re.fullmatch(r"\$([^*]+)(?:\*(\d+))?", tok)
            if m:
                for _ in range(int(m.group(2) or 1)):
                    run(m.group(1), key, beats, depth + 1)
                continue
            m = re.fullmatch(r"\|(?:\*(\d+))?", tok)
            if m:
                for k in range(int(m.group(1) or 1)):
                    emit(beats, key)
                continue
            pending.append(tok)

    run("S", 0, 4)
    return measures


# ---------------- melody ----------------

NOTE_RE = re.compile(r"([\^v]*)([#bn]?)([1-7])")


def expand_mel(path):
    text = " ".join(strip(l) for l in path.read_text(errors="replace").splitlines())
    key, beats, flats, prev = 0, 4, set(), None
    notes = []  # (measure index, pos fraction, pc, midi)
    pieces = text.split("|")
    m_idx = 0
    for raw in pieces[:-1]:
        s = raw.replace(" ", "")
        # directives anywhere in the measure text
        for d in re.findall(r"\[([^\]]*)\]", s):
            if d.startswith("OCT="):
                prev = None
                oct_ = int(d[4:])
            elif "/" in d:
                beats = meter_beats(d)
            elif re.fullmatch(r"[A-G][#b]?", d):
                key, flats = key_pc(d), set()
            elif re.fullmatch(r"[.bn]{7}", d):
                flats = {i for i, c in enumerate(d) if c == "b"}
        s = re.sub(r"\[[^\]]*\]", "", s)
        mr = re.fullmatch(r"R\*(\d+)", s)
        if mr:
            m_idx += int(mr.group(1))
            continue
        s = s.replace("-", "...").replace("_", "....").replace("=", "......")
        positions = []
        i = 0
        while i < len(s):
            if s[i] in ".R":
                positions.append(s[i])
                i += 1
                continue
            m = NOTE_RE.match(s, i)
            if not m:
                i += 1
                continue
            positions.append(m.groups())
            i = m.end()
        for k, p in enumerate(positions):
            if p == ".":
                continue
            if p == "R":
                notes.append((m_idx, k / len(positions), None, None))
                continue
            jumps, acc, deg = p
            d = int(deg) - 1
            pc = key + SCALE[d] + (-1 if d in flats and acc != "n" else 0) + (1 if acc == "#" else -1 if acc == "b" else 0)
            if prev is None:
                midi = 12 * ((locals().get("oct_", 4)) + 1) + (pc % 12)
            else:
                midi = prev + ((pc - prev + 6) % 12) - 6  # closest; tritone goes up
                if (pc - prev) % 12 == 6:
                    midi = prev + 6
            midi += 12 * (jumps.count("^") - jumps.count("v"))
            prev = midi
            notes.append((m_idx, k / len(positions), pc % 12, midi))
        m_idx += 1
    return notes, m_idx


# ---------------- statistics ----------------


def songs(root):
    root = Path(root)
    for mel in sorted((root / "rs200_melody").glob("*.mel")):
        har = root / "rs200_harmony" / (mel.stem + ".har")
        if har.exists():
            yield mel.stem, mel, har


def timeline(mel_path, har_path):
    """Melody notes and chord spans on a common beat axis."""
    measures = expand_har(har_path)
    notes, n_mel = expand_mel(mel_path)
    if abs(len(measures) - n_mel) > 2:
        return None
    starts, t = [], 0.0
    for beats, _ in measures:
        starts.append(t)
        t += beats
    chords = []
    for mi, (beats, segs) in enumerate(measures):
        for j, (pos, c) in enumerate(segs):
            end = segs[j + 1][0] if j + 1 < len(segs) else 1.0
            chords.append((starts[mi] + pos * beats, starts[mi] + end * beats, c, mi))
    timed = []
    for mi, pos, pc, midi in notes:
        if mi >= len(measures):
            continue
        timed.append((starts[mi] + pos * measures[mi][0], pc))
    mel = []
    for k, (t0, pc) in enumerate(timed):
        t1 = timed[k + 1][0] if k + 1 < len(timed) else t0 + 1
        if pc is not None:
            mel.append((t0, min(t1, t0 + 2), pc))
    return measures, starts, chords, mel


def emission(data):
    hist = {"maj": [0.0] * 12, "min": [0.0] * 12}
    for _, (_, _, chords, mel) in data:
        for t0, t1, c, _ in chords:
            if not c or c[1] is None:
                continue
            for a, b, pc in mel:
                ov = min(b, t1) - max(a, t0)
                if ov > 0:
                    hist[c[1]][(pc - c[0]) % 12] += ov
    out = {}
    for q, h in hist.items():
        s = sum(h) + 12 * 0.5
        out[q] = [round((x + 0.5) / s, 4) for x in h]  # light smoothing
    return out


def evaluate(data, emit, bb):
    """Half-bar accuracy of the harmonizer's model on songs it didn't learn from."""
    MAJ = [(0, "maj"), (2, "min"), (4, "min"), (5, "maj"), (7, "maj"), (9, "min")]
    MIN = [(0, "min"), (3, "maj"), (5, "min"), (7, "maj"), (8, "maj"), (10, "maj")]
    hit = tot = 0
    for _, (measures, starts, chords, mel) in data:
        # song key = most common tonic in the bar chords is complex; use bar-start chords relative to key 0
        bars = []  # half bars: the unit the harmonizer chooses chords for
        for mi, (beats, segs) in enumerate(measures):
            for h in (0.0, 0.5):
                c = [c for pos, c in segs if pos <= h + 1e-9][-1]
                bars.append((starts[mi] + h * beats, starts[mi] + (h + 0.5) * beats, c))
        roots = [c for _, _, c in bars if c and c[1]]
        if not roots:
            continue
        # tonic = annotated key (relative degree 0 in our absolute pcs is the first key); take most frequent root
        tonic = max(set(r[0] for r in roots), key=lambda p: sum(1 for r in roots if r[0] == p))
        minor = sum(1 for r in roots if r == (tonic, "min")) > sum(1 for r in roots if r == (tonic, "maj"))
        S = MIN if minor else MAJ
        T = bb["minorNextHalf" if minor else "majorNextHalf"]
        chordset = [((tonic + o) % 12, q) for o, q in S]

        def em(b0, b1, c):
            s = 0.0
            for a, b, pc in mel:
                ov = min(b, b1) - max(a, b0)
                if ov > 0:
                    s += ov * math.log(emit[c[1]][(pc - c[0]) % 12])
            return s

        score = [em(bars[0][0], bars[0][1], c) for c in chordset]
        back = []
        for b0, b1, _ in bars[1:]:
            ptr, ns = [], []
            for j, c in enumerate(chordset):
                best = max(range(6), key=lambda i: score[i] + math.log(T[i][j]))
                ptr.append(best)
                ns.append(score[best] + math.log(T[best][j]) + em(b0, b1, c))
            back.append(ptr)
            score = ns
        c = max(range(6), key=lambda i: score[i])
        path = [c]
        for ptr in reversed(back):
            c = ptr[c]
            path.insert(0, c)
        for (b0, b1, truth), p in zip(bars, path):
            has_mel = any(min(b, b1) > max(a, b0) for a, b, _ in mel)
            if truth in chordset and has_mel:
                tot += 1
                hit += chordset[p] == truth
    return hit, tot


def main(root, billboard_ts=None):
    data = []
    for name, mel, har in songs(root):
        t = timeline(mel, har)
        if t:
            data.append((name, t))
    emit = emission(data)
    if billboard_ts:
        s = Path(billboard_ts).read_text()
        bb = json.loads(s[s.index("{") : s.rindex("}") + 1])
        train, test = data[::2], data[1::2]
        e_train = emission(train)
        hit, tot = evaluate(test, e_train, bb)
        print(f"songs used: {len(data)}; held-out half-bar accuracy: {hit}/{tot} = {hit / max(1, tot):.1%}", file=sys.stderr)
    print("// Generated by software/rs200_stats.py from the Rolling Stone 200 rock corpus")
    print("// (de Clercq & Temperley 2011; Temperley & de Clercq 2013; data CC BY 4.0). Do not edit by hand.")
    print("// Share of melody time at each interval (0-11 semitones) above the root of a major or minor chord.")
    print(f"export const MELODY_OVER_CHORD = {json.dumps({'songs': len(data), **emit}, indent=2)} as const;")


if __name__ == "__main__":
    main(*sys.argv[1:3])
