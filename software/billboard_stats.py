"""Chord statistics from the McGill Billboard corpus, for the hum-to-chords harmonizer.

Source: J. A. Burgoyne, J. Wild, I. Fujinaga, "An Expert Ground Truth Set for Audio Chord
Recognition and Music Analysis", ISMIR 2011. Annotations released under CC0:
https://ddmal.music.mcgill.ca/research/The_McGill_Billboard_Project_(Chord_Analysis_Dataset)

Usage:
    curl -L -o bb.tar.gz "https://www.dropbox.com/s/2lvny9ves8kns4o/billboard-2.0-salami_chords.tar.gz?dl=1"
    tar xzf bb.tar.gz          # md5 6954a6fad962a111e69c9c80cb87d3a5
    python3 billboard_stats.py McGill-Billboard > ../site/src/engine/billboardStats.ts

What it counts: the chord sounding at the start of each bar, and of each half bar, as a scale
degree relative to the annotated tonic. A song is treated as minor when its tonic chord is
mostly minor. Bars on chords outside the six diatonic triads of the key break the chain.
4-bar loops need at least three different chords; a loop and its rotations count as one,
written from the tonic, and each loop counts once per song.
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Diatonic triads as (degree, quality). Order matches site/src/engine/harmonize.ts.
MAJOR = [(0, "maj"), (2, "min"), (4, "min"), (5, "maj"), (7, "maj"), (9, "min")]  # I ii iii IV V vi
MINOR = [(0, "min"), (3, "maj"), (5, "min"), (7, "maj"), (8, "maj"), (10, "maj")]  # i III iv V VI VII
MAJOR_NAMES = ["I", "ii", "iii", "IV", "V", "vi"]
MINOR_NAMES = ["i", "III", "iv", "V", "VI", "VII"]


def pitch_class(name: str) -> int:
    pc = PC[name[0]]
    for acc in name[1:]:
        pc += 1 if acc == "#" else -1 if acc == "b" else 0
    return pc % 12


def simplify(sym: str):
    """'D:min7/5' -> (2, 'min'); returns None for N, X, power chords and the like."""
    if ":" not in sym:
        return None
    root, qual = sym.split(":", 1)
    qual = qual.split("/")[0]
    if qual.startswith(("min", "hdim")) and not qual.startswith("hdim"):
        q = "min"
    elif qual.startswith(("maj", "7", "9", "11", "13", "sus", "aug")) or qual == "":
        q = "maj"
    else:
        return None  # dim, hdim, 1, 5 (power chord) …
    return pitch_class(root), q


def canonical(w):
    """A loop and its rotations are the same loop: start it on the tonic (or its smallest rotation)."""
    rots = [tuple(w[i:] + w[:i]) for i in range(len(w))]
    on_tonic = [r for r in rots if r[0] == 0]
    return min(on_tonic or rots)


def bars(path: Path):
    """Chord at the start of each bar, and at the start of each half bar (None = no usable chord)."""
    tonic = None
    out, halves = [], []
    cur = None
    for line in path.read_text(errors="replace").splitlines():
        if line.startswith("# tonic:"):
            tonic = pitch_class(line.split(":", 1)[1].strip())
            continue
        if line.startswith("#") or "|" not in line:
            continue
        for bar in re.findall(r"\|([^|]*)(?=\|)", line):
            toks = bar.split()
            if not toks:
                continue
            # positions divide the bar evenly; "." continues the chord before it
            at = []
            for t in toks:
                if t != ".":
                    cur = simplify(t)
                at.append(cur)
            out.append(at[0])
            halves += [at[0], at[len(at) // 2]]
    return tonic, out, halves


def main(root: str):
    files = sorted(Path(root).rglob("salami_chords.txt"))
    trans = {"major": Counter(), "minor": Counter()}
    half = {"major": Counter(), "minor": Counter()}  # half bar to half bar
    start = {"major": Counter(), "minor": Counter()}
    end = {"major": Counter(), "minor": Counter()}
    loops = {"major": Counter(), "minor": Counter()}
    songs = {"major": 0, "minor": 0}
    seen_titles = set()

    for f in files:
        # The corpus has some songs twice (charted in two years); count each once.
        head = f.read_text(errors="replace")[:400]
        key = re.findall(r"# (title|artist): (.*)", head)
        if tuple(key) in seen_titles:
            continue
        seen_titles.add(tuple(key))

        tonic, seq, halves = bars(f)
        if tonic is None or not seq:
            continue
        rel = [None if c is None else ((c[0] - tonic) % 12, c[1]) for c in seq]
        tonic_q = Counter(c[1] for c in rel if c and c[0] == 0)
        mode = "minor" if tonic_q["min"] > tonic_q["maj"] else "major"
        chords = MINOR if mode == "minor" else MAJOR
        idx = [chords.index(c) if c in chords else None for c in rel]
        songs[mode] += 1

        firsts = [i for i in idx if i is not None]
        if firsts:
            start[mode][firsts[0]] += 1
            end[mode][firsts[-1]] += 1
        for a, b in zip(idx, idx[1:]):
            if a is not None and b is not None:
                trans[mode][(a, b)] += 1
        hidx = [None if c is None else ((c[0] - tonic) % 12, c[1]) for c in halves]
        hidx = [chords.index(c) if c in chords else None for c in hidx]
        for a, b in zip(hidx, hidx[1:]):
            if a is not None and b is not None:
                half[mode][(a, b)] += 1
        # 4-bar loops with at least three different chords, counted once per song.
        song_loops = set()
        for k in range(len(idx) - 3):
            w = idx[k : k + 4]
            if None not in w and len(set(w)) >= 3:
                song_loops.add(canonical(w))
        for w in song_loops:
            loops[mode][w] += 1

    def matrix(mode, table=None):
        table = table or trans
        n = 6
        rows = []
        for a in range(n):
            counts = [table[mode][(a, b)] + 1 for b in range(n)]  # add-one smoothing
            s = sum(counts)
            rows.append([round(c / s, 4) for c in counts])
        return rows

    def dist(c):
        counts = [c[i] + 1 for i in range(6)]
        s = sum(counts)
        return [round(x / s, 4) for x in counts]

    def top(mode, names):
        total = songs[mode]
        return [
            {"loop": [names[i] for i in w], "songs": n, "share": round(n / total, 4)}
            for w, n in loops[mode].most_common(12)
        ]

    stats = {
        "songs": songs,
        "majorNext": matrix("major"),
        "minorNext": matrix("minor"),
        "majorNextHalf": matrix("major", half),
        "minorNextHalf": matrix("minor", half),
        "majorStart": dist(start["major"]),
        "minorStart": dist(start["minor"]),
        "majorEnd": dist(end["major"]),
        "minorEnd": dist(end["minor"]),
        "majorLoops": top("major", MAJOR_NAMES),
        "minorLoops": top("minor", MINOR_NAMES),
    }
    print("// Generated by software/billboard_stats.py from the McGill Billboard corpus")
    print("// (Burgoyne, Wild & Fujinaga, ISMIR 2011; annotations CC0). Do not edit by hand.")
    print("// One chord per bar, as diatonic degrees: major I ii iii IV V vi, minor i III iv V VI VII.")
    print(f"export const BILLBOARD = {json.dumps(stats, indent=2)} as const;")


if __name__ == "__main__":
    main(sys.argv[1])
