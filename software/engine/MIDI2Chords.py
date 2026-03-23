"""
Voice2Piano -- MIDI2Chords.py
==============================
Layer 2a: Melody MIDI → Accompaniment Chords

Reads from layer2_queue (populated by Vocal2MIDI_live.py).
Outputs chord events to harmony_queue for MIDI2Piano.py to consume.

PIPELINE
--------
  melody note (MIDI)
      │
      ▼
  Key Tracker          sliding 16-note window + Krumhansl-Kessler profiles
      │
      ▼
  Chord Sequencer      Markov chain over Roman numerals
      │
      ▼
  Voicing Engine       choose specific MIDI notes for each board
      │
      ▼
  harmony_queue        consumed by MIDI2Piano.py

WHAT IS HAND-WRITTEN vs TRAINABLE
----------------------------------
  HAND-WRITTEN (marked with # [RULE]):
    - Markov transition probabilities
    - Chord voicing octave choices
    - Chord duration formula

  TRAINABLE (marked with # [TRAIN]):
    - Transition weights (can be replaced by corpus statistics)
    - Key detection thresholds
    - Melody-chord affinity boost factor

  TO TRAIN:
    python MIDI2Chords.py --train software/files/input/
    This reads MIDI files, extracts chord progressions, and
    saves learned_transitions.json to replace the hand-written ones.
"""

import time
import queue
import threading
import math
import json
import random
import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger("V2P-CHORDS")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(threadName)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)

# Output queue consumed by MIDI2Piano.py
harmony_queue: queue.Queue = queue.Queue(maxsize=50)


# =============================================================================
# KEY DETECTION  (Krumhansl-Kessler, 1990)
# =============================================================================

# [RULE] These profiles are from Krumhansl's empirical study.
# They represent how strongly each pitch class belongs to a key.
MAJOR_PROFILE = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88
]
MINOR_PROFILE = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17
]

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def detect_key(pitch_counts: list[float]) -> tuple[int, str]:
    """
    Krumhansl-Kessler key-finding.

    Parameters
    ----------
    pitch_counts : 12-element list, index 0 = C

    Returns
    -------
    (root_pitch_class, mode)   root 0-11, mode 'major'|'minor'
    """
    best_key, best_mode, best_r = 0, "major", -2.0

    for root in range(12):
        rotated = [pitch_counts[(i + root) % 12] for i in range(12)]
        mean_r = sum(rotated) / 12

        def pearson(prof):
            mp = sum(prof) / 12
            num = sum(
                (rotated[i] - mean_r) * (prof[i] - mp) for i in range(12)
            )
            dx = math.sqrt(
                sum((rotated[i] - mean_r) ** 2 for i in range(12)) + 1e-9
            )
            dy = math.sqrt(
                sum((prof[i] - mp) ** 2 for i in range(12)) + 1e-9
            )
            return num / (dx * dy)

        r_maj = pearson(MAJOR_PROFILE)
        r_min = pearson(MINOR_PROFILE)

        if r_maj > best_r:
            best_r, best_key, best_mode = r_maj, root, "major"
        if r_min > best_r:
            best_r, best_key, best_mode = r_min, root, "minor"

    return best_key, best_mode


# =============================================================================
# CHORD DEFINITIONS
# =============================================================================

# [RULE] Standard Western chord interval definitions
CHORD_INTERVALS = {
    "major": [0, 4, 7],
    "minor": [0, 3, 7],
    "dom7": [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11],
    "min7": [0, 3, 7, 10],
    "dim": [0, 3, 6],
    "sus4": [0, 5, 7],
}

# [RULE] Scale degree → (semitone offset from root, chord type)
MAJOR_DEGREES = {
    "I": (0, "major"),
    "ii": (2, "minor"),
    "iii": (4, "minor"),
    "IV": (5, "major"),
    "V": (7, "dom7"),
    "vi": (9, "minor"),
    "vii": (11, "dim"),
}

MINOR_DEGREES = {
    "i": (0, "minor"),
    "ii": (2, "dim"),
    "III": (3, "major"),
    "iv": (5, "minor"),
    "V": (7, "dom7"),  # harmonic minor
    "VI": (8, "major"),
    "VII": (10, "major"),
}


def roman_to_midi(roman: str, key_root: int, key_mode: str) -> tuple[int, str]:
    """Roman numeral → (midi_pitch_class, chord_type)."""
    table = MAJOR_DEGREES if key_mode == "major" else MINOR_DEGREES
    if roman not in table:
        roman = "I" if key_mode == "major" else "i"
    offset, ctype = table[roman]
    return (key_root + offset) % 12, ctype


def chord_midi_notes(root_pc: int, ctype: str, octave: int = 4) -> list[int]:
    """Build MIDI note list for a chord."""
    base = root_pc + (octave + 1) * 12
    return [base + i for i in CHORD_INTERVALS.get(ctype, [0, 4, 7])]


# =============================================================================
# MARKOV CHORD SEQUENCER
# =============================================================================

# [TRAIN] These transition probabilities are hand-estimated from common
# Western pop/classical harmony. Replace with corpus-learned values by
# running: python MIDI2Chords.py --train <midi_folder>
# Each entry: chord → [(next_chord, weight), ...]
MAJOR_TRANSITIONS: dict[str, list[tuple[str, float]]] = {
    "I": [
        ("I", 0.25),
        ("IV", 0.25),
        ("V", 0.20),
        ("vi", 0.15),
        ("ii", 0.10),
        ("iii", 0.05),
    ],
    "ii": [
        ("V", 0.50),
        ("IV", 0.25),
        ("I", 0.10),
        ("vii", 0.10),
        ("vi", 0.05),
    ],
    "iii": [
        ("vi", 0.40),
        ("IV", 0.30),
        ("I", 0.15),
        ("ii", 0.10),
        ("V", 0.05),
    ],
    "IV": [("V", 0.35), ("I", 0.30), ("ii", 0.20), ("vi", 0.10), ("IV", 0.05)],
    "V": [("I", 0.55), ("vi", 0.20), ("IV", 0.10), ("ii", 0.10), ("V", 0.05)],
    "vi": [
        ("IV", 0.35),
        ("ii", 0.25),
        ("V", 0.20),
        ("I", 0.15),
        ("iii", 0.05),
    ],
    "vii": [("I", 0.65), ("V", 0.20), ("iii", 0.10), ("vi", 0.05)],
}

MINOR_TRANSITIONS: dict[str, list[tuple[str, float]]] = {
    "i": [
        ("i", 0.25),
        ("iv", 0.25),
        ("V", 0.20),
        ("VI", 0.15),
        ("ii", 0.10),
        ("VII", 0.05),
    ],
    "ii": [
        ("V", 0.45),
        ("iv", 0.25),
        ("i", 0.15),
        ("VII", 0.10),
        ("VI", 0.05),
    ],
    "III": [
        ("VI", 0.40),
        ("iv", 0.25),
        ("i", 0.20),
        ("VII", 0.15),
    ],
    "iv": [
        ("V", 0.35),
        ("i", 0.30),
        ("ii", 0.20),
        ("VI", 0.10),
        ("iv", 0.05),
    ],
    "V": [("i", 0.55), ("VI", 0.20), ("iv", 0.15), ("ii", 0.10)],
    "VI": [
        ("iv", 0.35),
        ("ii", 0.25),
        ("V", 0.20),
        ("i", 0.15),
        ("III", 0.05),
    ],
    "VII": [("i", 0.50), ("III", 0.25), ("V", 0.15), ("iv", 0.10)],
}

# [TRAIN] How much to boost a chord that contains the melody note.
# 1.0 = no boost, 3.0 = strong pull toward consonant chords.
MELODY_AFFINITY_BOOST = 2.5  # [TRAIN]


def load_learned_transitions(path: str = "learned_transitions.json"):
    """
    Load Markov weights from corpus training if available.
    Falls back to hand-written weights silently.
    """
    global MAJOR_TRANSITIONS, MINOR_TRANSITIONS
    try:
        with open(path) as f:
            data = json.load(f)
        if "major" in data:
            MAJOR_TRANSITIONS = {
                k: [tuple(x) for x in v] for k, v in data["major"].items()
            }
        if "minor" in data:
            MINOR_TRANSITIONS = {
                k: [tuple(x) for x in v] for k, v in data["minor"].items()
            }
        log.info("Loaded learned transitions from %s", path)
    except FileNotFoundError:
        log.debug("No learned_transitions.json -- using hand-written rules")
    except Exception as exc:
        log.warning("Could not load transitions: %s", exc)


def next_chord(current: str, mode: str, melody_pc: int, key_root: int) -> str:
    """
    Sample next chord from Markov chain, biased toward
    chords that contain the current melody pitch class.
    """
    table = MAJOR_TRANSITIONS if mode == "major" else MINOR_TRANSITIONS
    if current not in table:
        current = "I" if mode == "major" else "i"

    boosted = []
    for name, w in table[current]:
        root_pc, ctype = roman_to_midi(name, key_root, mode)
        default_intervals = [0, 4, 7]
        intervals = CHORD_INTERVALS.get(ctype, default_intervals)
        pcs = set((root_pc + i) % 12 for i in intervals)
        # [TRAIN] MELODY_AFFINITY_BOOST applied here
        bonus = MELODY_AFFINITY_BOOST if melody_pc in pcs else 1.0
        boosted.append((name, w * bonus))

    total = sum(w for _, w in boosted)
    r = random.random() * total
    acc = 0.0
    for name, w in boosted:
        acc += w
        if r <= acc:
            return name
    return boosted[-1][0]


# =============================================================================
# VOICING ENGINE
# =============================================================================

# [RULE] Left board plays bass in octave 3 (MIDI 36-47 range)
# [RULE] Right board plays chord tones in octave 4 (MIDI 48-71 range)
BASS_OCTAVE = 3  # [RULE]
CHORD_OCTAVE = 4  # [RULE]


def voice_chord(
    root_pc: int, ctype: str, melody_midi: int
) -> tuple[list[int], list[int]]:
    """
    Build right-board (chord) and left-board (bass) note lists.

    Avoids doubling the melody note.
    Right board: root + 3rd + 5th + 7th in CHORD_OCTAVE
    Left board:  root only in BASS_OCTAVE

    Returns
    -------
    (right_notes, left_notes)
    """
    # [RULE] Bass = root in octave 3
    bass = root_pc + (BASS_OCTAVE + 1) * 12
    left_notes = [bass]

    # [RULE] Chord tones in octave 4
    chord_base = root_pc + (CHORD_OCTAVE + 1) * 12
    default_intervals = [0, 4, 7]
    intervals = CHORD_INTERVALS.get(ctype, default_intervals)
    right_notes = [chord_base + i for i in intervals]

    # Remove collision with melody
    right_notes = [n for n in right_notes if n != melody_midi]
    left_notes = [n for n in left_notes if n != melody_midi]

    return right_notes, left_notes


# =============================================================================
# CORPUS TRAINING  (replaces hand-written Markov weights)
# =============================================================================


def train_from_corpus(
    midi_folder: str, output_path: str = "learned_transitions.json"
):
    """
    Parse MIDI files in folder, extract chord progressions,
    build Markov transition counts, save as JSON.

    Requires: pip install music21
    """
    try:
        import music21  # noqa: PLC0415
    except ImportError:
        print("pip install music21")
        return

    from collections import defaultdict  # noqa: PLC0415

    counts_major: dict = defaultdict(lambda: defaultdict(float))
    counts_minor: dict = defaultdict(lambda: defaultdict(float))

    files = list(Path(midi_folder).rglob("*.mid")) + list(
        Path(midi_folder).rglob("*.midi")
    )
    print(f"Training on {len(files)} MIDI files...")

    for f in files:
        try:
            score = music21.converter.parse(str(f))
            key = score.analyze("key")
            chords = score.chordify()

            prev = None
            for c in chords.flat.getElementsByClass("Chord"):
                rn = music21.roman.romanNumeralFromChord(c, key)
                symbol = rn.figure
                if prev is not None:
                    if key.mode == "major":
                        counts_major[prev][symbol] += 1.0
                    else:
                        counts_minor[prev][symbol] += 1.0
                prev = symbol
        except Exception:
            pass

    def normalize(counts):
        result = {}
        for src, targets in counts.items():
            total = sum(targets.values())
            if total > 0:
                sorted_targets = sorted(
                    targets.items(), key=lambda x: -x[1]
                )[:8]
                result[src] = [[k, v / total] for k, v in sorted_targets]
        return result

    data = {
        "major": normalize(counts_major),
        "minor": normalize(counts_minor),
    }

    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Saved to {output_path}")
    print(f"  Major: {len(data['major'])} source chords")
    print(f"  Minor: {len(data['minor'])} source chords")


# =============================================================================
# CHORD GENERATOR  (main class)
# =============================================================================


class ChordGenerator:
    """
    Reads melody events from input_queue.
    Pushes chord voicing events to harmony_queue.

    Event format pushed to harmony_queue:
    {
        'right_notes': [60, 64, 67],   # MIDI notes for right solenoid board
        'left_notes':  [48],            # MIDI notes for left solenoid board
        'chord': 'V',                   # Roman numeral
        'chord_type': 'dom7',
        'key': 'G major',
        'bpm': 120.0,
        'timestamp': 1234567.89,
    }
    """

    def __init__(
        self,
        input_queue: queue.Queue,
        output_queue: queue.Queue,
        shutdown: threading.Event,
    ):
        self.iq = input_queue
        self.oq = output_queue
        self.shutdown = shutdown

        # Music state
        self._pitch_counts = [0.0] * 12
        self._note_buf: list[int] = []
        self._key_root = 0
        self._key_mode = "major"
        self._chord = "I"
        self._last_chord_t = 0.0

        # [TRAIN] Chord duration in beats (4 = one bar)
        self._chord_beats = 4.0  # [RULE]
        self._bpm = 120.0

        self._thread: Optional[threading.Thread] = None
        load_learned_transitions()

    @property
    def _chord_duration_sec(self) -> float:
        # [RULE] one chord per bar
        return self._chord_beats * 60.0 / max(self._bpm, 40.0)

    def start(self):
        self._thread = threading.Thread(
            target=self._run, name="ChordGen", daemon=True
        )
        self._thread.start()
        log.info("ChordGenerator started")

    def _update_key(self, midi: int):
        pc = midi % 12
        self._pitch_counts[pc] += 1.0
        self._pitch_counts = [c * 0.98 for c in self._pitch_counts]
        self._note_buf.append(midi)
        if len(self._note_buf) >= 8:
            self._key_root, self._key_mode = detect_key(self._pitch_counts)
            self._note_buf = self._note_buf[-16:]

    def _maybe_advance(self, melody_midi: int):
        now = time.time()
        if now - self._last_chord_t >= self._chord_duration_sec:
            new = next_chord(
                self._chord, self._key_mode, melody_midi % 12, self._key_root
            )
            self._chord = new
            self._last_chord_t = now
            key_str = f"{NOTE_NAMES[self._key_root]} {self._key_mode}"
            log.info("Key: %-10s  Chord: %s", key_str, self._chord)

    def _run(self):
        while not self.shutdown.is_set():
            try:
                evt = self.iq.get(timeout=0.3)
            except queue.Empty:
                continue

            midi = evt.get("midi_note", -1)
            if midi < 0:
                continue

            bpm = evt.get("bpm", 120.0)
            if bpm > 0:
                self._bpm = bpm

            self._update_key(midi)
            self._maybe_advance(midi)

            root_pc, ctype = roman_to_midi(
                self._chord, self._key_root, self._key_mode
            )
            right_notes, left_notes = voice_chord(root_pc, ctype, midi)

            out_evt = {
                "right_notes": right_notes,
                "left_notes": left_notes,
                "chord": self._chord,
                "chord_type": ctype,
                "key": f"{NOTE_NAMES[self._key_root]} {self._key_mode}",
                "bpm": self._bpm,
                "timestamp": time.time(),
            }

            try:
                self.oq.put_nowait(out_evt)
            except queue.Full:
                try:
                    self.oq.get_nowait()
                except queue.Empty:
                    pass
                self.oq.put_nowait(out_evt)


# =============================================================================
# CLI
# =============================================================================


def main():
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        description="MIDI2Chords -- melody to chord accompaniment"
    )
    parser.add_argument(
        "--train",
        metavar="FOLDER",
        help="Train Markov weights from MIDI corpus",
    )
    args = parser.parse_args()

    if args.train:
        train_from_corpus(args.train)
        return

    # Run standalone with test melody
    import queue as _q  # noqa: PLC0415

    shutdown = threading.Event()
    iq = _q.Queue()
    oq = _q.Queue()

    gen = ChordGenerator(iq, oq, shutdown)
    gen.start()

    test = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60]
    print("Test melody: C major scale. Ctrl+C to stop.\n")

    def _feed():
        while not shutdown.is_set():
            for n in test:
                if shutdown.is_set():
                    break
                iq.put(
                    {
                        "midi_note": n,
                        "bpm": 120.0,
                        "is_beat": True,
                        "conf": 0.9,
                        "timestamp": time.time(),
                    }
                )
                time.sleep(0.5)

    threading.Thread(target=_feed, daemon=True).start()

    try:
        while True:
            try:
                evt = oq.get(timeout=0.5)
                r = [
                    f"{'C C# D Eb E F F# G Ab A Bb B'.split()[n%12]}{n//12-1}"
                    for n in evt["right_notes"]
                ]
                left_note_names = [
                    f"{'C C# D Eb E F F# G Ab A Bb B'.split()[n%12]}{n//12-1}"
                    for n in evt["left_notes"]
                ]
                print(
                    f"  {evt['key']:<12}  {evt['chord']:<5} "
                    f"({evt['chord_type']:<6})  "
                    f"R: {' '.join(r):<20}  L: {' '.join(left_note_names)}"
                )
            except queue.Empty:
                pass
    except KeyboardInterrupt:
        shutdown.set()
        print("\nStopped.")


if __name__ == "__main__":
    main()
