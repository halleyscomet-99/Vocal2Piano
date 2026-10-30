"""Turn a score in numbered musical notation (scale degrees 1–7) into a MIDI demo for the site.

Type the score into a text file, one line per part, and run:
    python3 numbered_to_midi.py input/song.txt

No packages needed. Writes site/local/<title>.mid and lists it in site/local/demos.json,
so it shows up under Songs → Demo while the dev server runs (git-ignored, never built).

File format
    title: Song name        key: F   (1 = F4; Bb, F# etc. also work)
    bpm: 123                time: 4/4
    # a comment line
    Melody | 0 1 5,_ 5,_ 4,_ 4,_ | ...    one line per part; repeat the label to continue
    Piano  | [6,13] - - - | 0 0 0 0 |

Each label becomes a MIDI track of that name. Put the sung tune under "Melody" and
what the robot plays under "Piano", even when the sheet moves the tune between the hands:
the site picks the sung part by track name.

Notes and rests
    1–7, 0     a quarter note (scale degree), or a quarter rest
    #4  b7     sharp, flat
    6,  6,,    one / two octaves down (dots below the digit)
    1'  1''    one / two octaves up (dots above the digit)
    _   __     eighth, sixteenth (one / two underlines)
    .          dotted (after the underlines: 2_.)
    -          hold the previous note one more beat
    ~          tie into the next note of the same pitch (2_~ 2_)
    [6,13]     chord, notes low to high      {6,13}  rolled (arpeggiated) chord
    ( 3_ 3_ 1_ )   triplet: three notes in the time of two
"""

import argparse
import re
import struct
import sys
from pathlib import Path

from local_demos import add_demo, demo_file

PPQ = 480
MAJOR = [0, 2, 4, 5, 7, 9, 11]
KEYS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NOTE = re.compile(r"([#b]?)([0-7])([,']*)")
TOKEN = re.compile(r"^(?:([\[{])((?:[#b]?[1-7][,']*)+)[\]}]|([#b]?[0-7][,']*))(_*)(\.?)(~?)$")
ROLL = PPQ // 16  # gap between the notes of a rolled chord (about 30 ms at 123 bpm)


def tonic_midi(key: str) -> int:
    m = re.fullmatch(r"([A-G])([#b]?)", key.strip())
    if not m:
        sys.exit(f"key: expected something like F, Bb or F#, got {key!r}")
    return 60 + KEYS[m[1]] + {"#": 1, "b": -1, "": 0}[m[2]]


def pitch(tonic: int, acc: str, deg: str, octs: str) -> int:
    return tonic + MAJOR[int(deg) - 1] + {"#": 1, "b": -1, "": 0}[acc] + 12 * (octs.count("'") - octs.count(","))


def parse_staff(bars: list[str], tonic: int, bar_ticks: int, label: str):
    """Return notes as (start_tick, length_ticks, midi) for one staff."""
    notes: list[list[int]] = []
    t = 0
    last: list[int] = []  # indices of the notes the previous event started (for "-")
    ties: dict[int, int] = {}  # midi → index of a note waiting to be continued
    for b, bar in enumerate(bars, 1):
        bar_start = t
        scale = 1.0
        for tok in bar.split():
            if tok == "(":
                scale = 2 / 3
                continue
            if tok == ")":
                scale = 1.0
                continue
            if tok == "-":
                for i in last:
                    notes[i][1] += PPQ
                t += PPQ
                continue
            m = TOKEN.match(tok)
            if not m:
                sys.exit(f"{label} bar {b}: can't read {tok!r}")
            bracket, chord, single, unders, dot, tie = m.groups()
            length = round(PPQ / 2 ** len(unders) * (1.5 if dot else 1) * scale)
            body = chord if chord else single
            pitches = [pitch(tonic, *n) for n in NOTE.findall(body) if n[1] != "0"]
            held, last = ties, []
            ties = {}
            for k, p in enumerate(pitches):
                if p in held:  # continuation of a tied note
                    i = held[p]
                    notes[i][1] += length
                else:
                    off = k * ROLL if bracket == "{" else 0
                    notes.append([t + off, length - off, p])
                    i = len(notes) - 1
                last.append(i)
                if tie:
                    ties[p] = i
            t += length
        if t - bar_start != bar_ticks:
            print(f"warning: {label} bar {b} has {(t - bar_start) / PPQ:g} beats", file=sys.stderr)
            t = bar_start + bar_ticks
    return notes


def read_score(text: str):
    meta = {"key": "C", "bpm": "120", "time": "4/4", "title": "Untitled"}
    staves: dict[str, list[str]] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or re.match(r"#(?![1-7])", line):  # comment (a sharp is # plus a digit)
            continue
        if "|" in line:
            label, rest = line.split("|", 1)
            bars = [b for b in rest.split("|") if b.strip()]
            staves.setdefault(label.strip(), []).extend(bars)
        elif ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip().lower()] = v.strip()
    return meta, staves


def vlq(n: int) -> bytes:
    out = [n & 0x7F]
    while n > 0x7F:
        n >>= 7
        out.append(0x80 | (n & 0x7F))
    return bytes(reversed(out))


def track(events: list[tuple[int, bytes]]) -> bytes:
    data, now = b"", 0
    for tick, msg in sorted(events, key=lambda e: (e[0], e[1][0] & 0xF0 != 0x80)):
        data += vlq(tick - now) + msg
        now = tick
    data += b"\x00\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(data)) + data


def meta_text(kind: int, s: str) -> bytes:
    b = s.encode()
    return bytes([0xFF, kind]) + vlq(len(b)) + b


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("score")
    a = ap.parse_args()

    meta, staves = read_score(Path(a.score).read_text())
    tonic = tonic_midi(meta["key"])
    beats, unit = (int(x) for x in meta["time"].split("/"))
    bar_ticks = PPQ * 4 * beats // unit
    bpm = float(meta["bpm"])

    head = [
        (0, meta_text(0x03, meta["title"])),
        (0, b"\xff\x51\x03" + round(60_000_000 / bpm).to_bytes(3, "big")),
        (0, bytes([0xFF, 0x58, 4, beats, unit.bit_length() - 1, 24, 8])),
    ]
    tracks = [track(head)]
    total = 0
    for label, bars in staves.items():
        ev = [(0, meta_text(0x03, label))]
        for start, length, p in parse_staff(bars, tonic, bar_ticks, label):
            ev.append((start, bytes([0x90, p, 80])))
            ev.append((start + length, bytes([0x80, p, 0])))
            total += 1
        tracks.append(track(ev))
        print(f"{label}: {len(bars)} bars")

    out = demo_file(meta["title"])
    out.write_bytes(b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), PPQ) + b"".join(tracks))
    bars = max(len(b) for b in staves.values())
    add_demo(meta["title"], out, bpm=bpm, bars=bars, source="score")
    print(f"wrote {out} ({total} notes)")


if __name__ == "__main__":
    main()
