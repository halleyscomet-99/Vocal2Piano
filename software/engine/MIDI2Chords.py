"""
Voice2Piano -- MIDI2Chords.py
==============================
Layer 2a: Melody MIDI → Accompaniment Chords

Reads from layer2_queue (populated by Vocal2MIDI_live.py).
Pushes chord voicing events to harmony_queue for MIDI2Piano.py.
Sends chord MIDI + CC info to Voice2Piano_Harmony for Max visualization.
Accepts BPM override via CC 16 on Voice2Piano_Sync.

MAX INTEGRATION
---------------
  Voice2Piano_Harmony  output port → Max patch
    note_on  ch1:  chord notes (right + left board voicing)
    CC 80:   chord root pitch class (0-11, C=0)
    CC 81:   chord type (0=maj 1=min 2=dom7 3=maj7 4=m7 5=dim 6=sus4)
    CC 82:   key root pitch class (0-11)
    CC 83:   key mode (0=major 1=minor)
    CC 84:   chord degree (0=I 1=ii 2=iii 3=IV 4=V 5=vi 6=vii)
    CC 85:   right rail offset + 12  (raw 0-36, decode: value-12)
    CC 86:   left  rail offset + 12
    CC 87:   right solenoid mask bits 0-6
    CC 88:   right solenoid mask bits 7-13
    CC 89:   right solenoid mask bit  14
    CC 90:   left  solenoid mask bits 0-6
    CC 91:   left  solenoid mask bits 7-13
    CC 92:   left  solenoid mask bit  14
    CC 93:   commit  (0 = new chord ready, triggers serial send in Max)

  Voice2Piano_Sync     input port ← Max BPM slider
    CC 16:   tempo = value + 60  (0→127 maps to BPM 60→187)

WHAT IS HAND-WRITTEN vs TRAINABLE
-----------------------------------
  [RULE]   Markov weights, voicing octaves, chord duration, K-K profiles
  [TRAIN]  Transition weights, melody affinity boost, BPM source

  TO TRAIN:
    python MIDI2Chords.py --train software/files/input/
"""

import time
import queue
import threading
import math
import json
import random
import logging
from typing import Optional

log = logging.getLogger("V2P-CHORDS")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(threadName)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)

harmony_queue: queue.Queue = queue.Queue(maxsize=50)


# ─────────────────────────────────────────────────────────────────────────────
# RAIL PLANNER  (inline from MIDI2Piano.py to avoid circular import)
# ─────────────────────────────────────────────────────────────────────────────

RAIL_MIN = -12
RAIL_MAX = 24
RIGHT_DEFAULT_ROOT = 60   # C4 at home position
LEFT_DEFAULT_ROOT = 57   # A3 at home position


class BoardState:
    def __init__(self, name: str, default_root: int):
        self.name = name
        self.default_root = default_root
        self.rail_pos = 0

    @property
    def current_root(self) -> int:
        return self.default_root + self.rail_pos

    def reachable(self, midi: int) -> bool:
        return 0 <= (midi - self.current_root) < 15

    def to_solenoid_idx(self, midi: int) -> Optional[int]:
        offset = midi - self.current_root
        return offset if 0 <= offset < 15 else None

    def notes_to_mask(self, midi_notes: list[int]) -> int:
        mask = 0
        for m in midi_notes:
            idx = self.to_solenoid_idx(m)
            if idx is not None:
                mask |= 1 << idx
        return mask


def plan_positions(
    right_targets: list[int],
    left_targets: list[int],
    board_r: BoardState,
    board_l: BoardState,
) -> tuple[int, int]:
    """Try all rail positions, pick the combination covering the most notes."""
    if not right_targets and not left_targets:
        return board_r.rail_pos, board_l.rail_pos

    best_score = -1.0
    best_r, best_l = board_r.rail_pos, board_l.rail_pos
    orig_r, orig_l = board_r.rail_pos, board_l.rail_pos

    for r_off in range(RAIL_MIN, RAIL_MAX + 1):
        board_r.rail_pos = r_off
        r_cov = {n for n in right_targets if board_r.reachable(n)}

        remaining = [n for n in left_targets if n not in r_cov]

        for l_off in range(RAIL_MIN, RAIL_MAX + 1):
            board_l.rail_pos = l_off
            l_cov = sum(1 for n in remaining if board_l.reachable(n))
            total = len(r_cov) + l_cov
            penalty = (abs(r_off - orig_r) + abs(l_off - orig_l)) * 0.01
            score = total - penalty
            if score > best_score:
                best_score = score
                best_r, best_l = r_off, l_off

    board_r.rail_pos = orig_r
    board_l.rail_pos = orig_l
    return best_r, best_l


# ─────────────────────────────────────────────────────────────────────────────
# KEY DETECTION  (Krumhansl-Kessler, 1990)
# ─────────────────────────────────────────────────────────────────────────────

MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09,   # [RULE]
                 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53,   # [RULE]
                 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F",
              "F#", "G", "Ab", "A", "Bb", "B"]


def detect_key(pitch_counts: list[float]) -> tuple[int, str]:
    best_key, best_mode, best_r = 0, "major", -2.0
    for root in range(12):
        rotated = [pitch_counts[(i + root) % 12] for i in range(12)]
        mean_r = sum(rotated) / 12

        def pearson(prof):
            mp = sum(prof) / 12
            num = sum((rotated[i] - mean_r) * (prof[i] - mp)
                      for i in range(12))
            dx = math.sqrt(
                sum((rotated[i] - mean_r)**2 for i in range(12)) + 1e-9)
            dy = math.sqrt(sum((prof[i] - mp)**2 for i in range(12)) + 1e-9)
            return num / (dx * dy)

        for r_val, mode in [(pearson(MAJOR_PROFILE), "major"),
                            (pearson(MINOR_PROFILE), "minor")]:
            if r_val > best_r:
                best_r, best_key, best_mode = r_val, root, mode
    return best_key, best_mode


# ─────────────────────────────────────────────────────────────────────────────
# CHORD DEFINITIONS
# ─────────────────────────────────────────────────────────────────────────────

CHORD_INTERVALS = {                              # [RULE]
    "major": [0, 4, 7],
    "minor": [0, 3, 7],
    "dom7": [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11],
    "min7": [0, 3, 7, 10],
    "dim": [0, 3, 6],
    "sus4": [0, 5, 7],
}

MAJOR_DEGREES = {                                # [RULE]
    "I": (0, "major"),
    "ii": (2, "minor"),
    "iii": (4, "minor"),
    "IV": (5, "major"),
    "V": (7, "dom7"),
    "vi": (9, "minor"),
    "vii": (11, "dim"),
}

MINOR_DEGREES = {                                # [RULE]
    "i": (0, "minor"),
    "ii": (2, "dim"),
    "III": (3, "major"),
    "iv": (5, "minor"),
    "V": (7, "dom7"),
    "VI": (8, "major"),
    "VII": (10, "major"),
}

CHORD_TYPE_CC = {"major": 0, "minor": 1, "dom7": 2,
                 "maj7": 3, "min7": 4, "dim": 5, "sus4": 6}
DEGREE_CC_MAJOR = {
    "I": 0,
    "ii": 1,
    "iii": 2,
    "IV": 3,
    "V": 4,
    "vi": 5,
    "vii": 6}
DEGREE_CC_MINOR = {
    "i": 0,
    "ii": 1,
    "III": 2,
    "iv": 3,
    "V": 4,
    "VI": 5,
    "VII": 6}


def roman_to_midi(roman: str, key_root: int, key_mode: str) -> tuple[int, str]:
    table = MAJOR_DEGREES if key_mode == "major" else MINOR_DEGREES
    if roman not in table:
        roman = "I" if key_mode == "major" else "i"
    offset, ctype = table[roman]
    return (key_root + offset) % 12, ctype


# ─────────────────────────────────────────────────────────────────────────────
# MARKOV CHORD SEQUENCER
# ─────────────────────────────────────────────────────────────────────────────

MAJOR_TRANSITIONS: dict[str, list[tuple[str, float]]] = {  # [TRAIN]
    "I":   [("I", 0.25), ("IV", 0.25), ("V", 0.20),
            ("vi", 0.15), ("ii", 0.10), ("iii", 0.05)],
    "ii":  [("V", 0.50), ("IV", 0.25), ("I", 0.10),
            ("vii", 0.10), ("vi", 0.05)],
    "iii": [("vi", 0.40), ("IV", 0.30), ("I", 0.15),
            ("ii", 0.10), ("V", 0.05)],
    "IV":  [("V", 0.35), ("I", 0.30), ("ii", 0.20),
            ("vi", 0.10), ("IV", 0.05)],
    "V":   [("I", 0.55), ("vi", 0.20), ("IV", 0.10),
            ("ii", 0.10), ("V", 0.05)],
    "vi":  [("IV", 0.35), ("ii", 0.25), ("V", 0.20),
            ("I", 0.15), ("iii", 0.05)],
    "vii": [("I", 0.65), ("V", 0.20), ("iii", 0.10), ("vi", 0.05)],
}

MINOR_TRANSITIONS: dict[str, list[tuple[str, float]]] = {  # [TRAIN]
    "i":   [("i", 0.25), ("iv", 0.25), ("V", 0.20),
            ("VI", 0.15), ("ii", 0.10), ("VII", 0.05)],
    "ii":  [("V", 0.45), ("iv", 0.25), ("i", 0.15),
            ("VII", 0.10), ("VI", 0.05)],
    "III": [("VI", 0.40), ("iv", 0.25), ("i", 0.20), ("VII", 0.15)],
    "iv":  [("V", 0.35), ("i", 0.30), ("ii", 0.20),
            ("VI", 0.10), ("iv", 0.05)],
    "V":   [("i", 0.55), ("VI", 0.20), ("iv", 0.15), ("ii", 0.10)],
    "VI":  [("iv", 0.35), ("ii", 0.25), ("V", 0.20),
            ("i", 0.15), ("III", 0.05)],
    "VII": [("i", 0.50), ("III", 0.25), ("V", 0.15), ("iv", 0.10)],
}

MELODY_AFFINITY_BOOST = 2.5   # [TRAIN]


def load_learned_transitions(path: str = "learned_transitions.json"):
    global MAJOR_TRANSITIONS, MINOR_TRANSITIONS
    try:
        with open(path) as f:
            data = json.load(f)
        if "major" in data:
            MAJOR_TRANSITIONS = {k: [tuple(x) for x in v]
                                 for k, v in data["major"].items()}
        if "minor" in data:
            MINOR_TRANSITIONS = {k: [tuple(x) for x in v]
                                 for k, v in data["minor"].items()}
        log.info("Loaded learned transitions from %s", path)
    except FileNotFoundError:
        pass
    except Exception as exc:
        log.warning("Could not load transitions: %s", exc)


def next_chord(current: str, mode: str, melody_pc: int, key_root: int) -> str:
    table = MAJOR_TRANSITIONS if mode == "major" else MINOR_TRANSITIONS
    if current not in table:
        current = "I" if mode == "major" else "i"
    boosted = []
    for name, w in table[current]:
        root_pc, ctype = roman_to_midi(name, key_root, mode)
        pcs = {(root_pc + i) %
               12 for i in CHORD_INTERVALS.get(ctype, [0, 4, 7])}
        bonus = MELODY_AFFINITY_BOOST if melody_pc in pcs else 1.0   # [TRAIN]
        boosted.append((name, w * bonus))
    total = sum(w for _, w in boosted)
    r = random.random() * total
    acc = 0.0
    for name, w in boosted:
        acc += w
        if r <= acc:
            return name
    return boosted[-1][0]


# ─────────────────────────────────────────────────────────────────────────────
# VOICING ENGINE
# ─────────────────────────────────────────────────────────────────────────────

BASS_OCTAVE = 3   # [RULE]
CHORD_OCTAVE = 4   # [RULE]


def voice_chord(root_pc: int, ctype: str,
                melody_midi: int) -> tuple[list[int], list[int]]:
    bass = root_pc + (BASS_OCTAVE + 1) * 12
    left_notes = [n for n in [bass] if n != melody_midi]
    chord_base = root_pc + (CHORD_OCTAVE + 1) * 12
    intervals = CHORD_INTERVALS.get(ctype, [0, 4, 7])
    right_notes = [
        n for n in [chord_base + i for i in intervals]
        if n != melody_midi
    ]
    return right_notes, left_notes


# ─────────────────────────────────────────────────────────────────────────────
# MAX MIDI INTEGRATION
# ─────────────────────────────────────────────────────────────────────────────

class HarmonyMIDI:
    """
    Voice2Piano_Harmony  (output) → Max patch harmony + serial sections
    Voice2Piano_Sync     (input)  ← Max BPM slider (CC 16)
    """

    def __init__(self, bpm_callback):
        self._bpm_callback = bpm_callback
        self._out = None
        self._in = None
        self._prev_notes: list[int] = []
        self._open_ports()

    def _open_ports(self):
        try:
            import rtmidi                                    # noqa: PLC0415
            mout = rtmidi.MidiOut()
            mout.open_virtual_port("Voice2Piano_Harmony")
            self._out = mout
            log.info("MIDI out: Voice2Piano_Harmony")
        except Exception as exc:
            log.warning("Harmony output unavailable: %s", exc)

        try:
            import rtmidi                                    # noqa: PLC0415
            min_ = rtmidi.MidiIn()
            min_.open_virtual_port("Voice2Piano_Sync")
            min_.set_callback(self._on_sync)
            min_.ignore_types(sysex=True, timing=True, active_sense=True)
            self._in = min_
            log.info("MIDI in:  Voice2Piano_Sync (CC16 = BPM-60)")
        except Exception as exc:
            log.warning("Sync input unavailable: %s", exc)

    def _on_sync(self, event, _data=None):
        msg, _ = event
        if len(msg) == 3 and (msg[0] & 0xF0) == 0xB0 and msg[1] == 16:
            self._bpm_callback(float(msg[2]) + 60.0)

    def send(self,
             right_notes: list[int], left_notes: list[int],
             root_pc: int, ctype: str,
             key_root: int, key_mode: str, degree: str,
             right_rail: int, left_rail: int,
             right_mask: int, left_mask: int):
        """
        Send chord state + pre-computed rail/mask to Max.

        CC 80-84: musical context (chord root, type, key, degree)
        CC 85-92: hardware targets (rail offsets + solenoid masks,
                  3x7-bit split)
        CC 93:    commit signal — Max serial_driver.js fires on this
        """
        if not self._out:
            return

        all_notes = list(set(right_notes + left_notes))

        # Release old notes
        for n in self._prev_notes:
            if n not in all_notes:
                try:
                    self._out.send_message([0x80, n & 0x7F, 0])
                except Exception:
                    pass

        # Activate current chord notes
        for n in all_notes:
            try:
                self._out.send_message([0x90, n & 0x7F, 80])
            except Exception:
                pass

        self._prev_notes = all_notes

        degree_map = {**DEGREE_CC_MAJOR, **DEGREE_CC_MINOR}

        # ── Musical context CCs (80-84) ──────────────────────────────────
        ccs = [
            (80, root_pc & 0x7F),
            (81, CHORD_TYPE_CC.get(ctype, 0)),
            (82, key_root & 0x7F),
            (83, 0 if key_mode == "major" else 1),
            (84, degree_map.get(degree, 0)),
        ]

        # ── Rail offset CCs (85-86): value = offset + 12, range 0-36 ────
        ccs += [
            (85, (right_rail + 12) & 0x7F),
            (86, (left_rail + 12) & 0x7F),
        ]

        # ── Solenoid mask CCs: each 15-bit mask split into 3 × 7-bit ────
        # right mask: CC 87-89
        ccs += [
            (87, right_mask & 0x7F),
            (88, (right_mask >> 7) & 0x7F),
            (89, (right_mask >> 14) & 0x01),
        ]
        # left mask: CC 90-92
        ccs += [
            (90, left_mask & 0x7F),
            (91, (left_mask >> 7) & 0x7F),
            (92, (left_mask >> 14) & 0x01),
        ]

        # ── Commit signal (CC 93) — triggers serial_driver.js ───────────
        ccs.append((93, 0))

        for cc_num, val in ccs:
            try:
                self._out.send_message([0xB0, cc_num, val])
            except Exception:
                pass

    def close(self):
        if self._out:
            for n in self._prev_notes:
                try:
                    self._out.send_message([0x80, n & 0x7F, 0])
                except Exception:
                    pass
        self._out = None
        self._in = None


# ─────────────────────────────────────────────────────────────────────────────
# CORPUS TRAINING
# ─────────────────────────────────────────────────────────────────────────────

def train_from_corpus(
        midi_folder: str,
        output_path: str = "learned_transitions.json"):
    try:
        import music21                                       # noqa: PLC0415
    except ImportError:
        print("pip install music21")
        return

    from collections import defaultdict                     # noqa: PLC0415
    from pathlib import Path                                # noqa: PLC0415

    counts_major: dict = defaultdict(lambda: defaultdict(float))
    counts_minor: dict = defaultdict(lambda: defaultdict(float))
    files = list(Path(midi_folder).rglob("*.mid")) + \
        list(Path(midi_folder).rglob("*.midi"))
    print(f"Training on {len(files)} MIDI files...")

    for f in files:
        try:
            score = music21.converter.parse(str(f))
            key = score.analyze("key")
            prev = None
            for c in score.chordify().flat.getElementsByClass("Chord"):
                rn = music21.roman.romanNumeralFromChord(c, key)
                if prev:
                    (counts_major if key.mode == "major" else counts_minor)[
                        prev][rn.figure] += 1.0
                prev = rn.figure
        except Exception:
            pass

    def normalize(counts):
        return {src: [[k, v / sum(t.values())] for k, v in
                      sorted(t.items(), key=lambda x: -x[1])[:8]]
                for src, t in counts.items() if sum(t.values()) > 0}

    with open(output_path, "w") as f:
        json.dump({"major": normalize(counts_major),
                  "minor": normalize(counts_minor)}, f, indent=2)
    print(f"Saved to {output_path}")


# ─────────────────────────────────────────────────────────────────────────────
# CHORD GENERATOR
# ─────────────────────────────────────────────────────────────────────────────

class ChordGenerator:
    def __init__(self, input_queue: queue.Queue,
                 output_queue: queue.Queue,
                 shutdown: threading.Event):
        self.iq = input_queue
        self.oq = output_queue
        self.shutdown = shutdown

        self._pitch_counts = [0.0] * 12
        self._note_buf: list[int] = []
        self._key_root = 0
        self._key_mode = "major"
        self._chord = "I"
        self._last_chord_t = 0.0
        self._chord_beats = 4.0   # [RULE]
        self._bpm = 120.0

        # Rail state for CC transmission to Max
        self._board_r = BoardState("R", RIGHT_DEFAULT_ROOT)
        self._board_l = BoardState("L", LEFT_DEFAULT_ROOT)

        self._harmony = HarmonyMIDI(bpm_callback=self._on_max_bpm)
        self._thread: Optional[threading.Thread] = None
        load_learned_transitions()

    def _on_max_bpm(self, bpm: float):
        self._bpm = max(40.0, min(240.0, bpm))
        log.info("BPM from Max: %.0f", self._bpm)

    @property
    def _chord_duration_sec(self) -> float:
        return self._chord_beats * 60.0 / max(self._bpm, 40.0)   # [RULE]

    def start(self):
        self._thread = threading.Thread(
            target=self._run, name="ChordGen", daemon=True)
        self._thread.start()
        log.info("ChordGenerator started")

    def stop(self):
        self._harmony.close()

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
            self._chord = next_chord(
                self._chord, self._key_mode, melody_midi % 12, self._key_root
            )
            self._last_chord_t = now
            log.info("Key: %-10s  Chord: %s",
                     f"{NOTE_NAMES[self._key_root]} {self._key_mode}",
                     self._chord)

    def _run(self):
        while not self.shutdown.is_set():
            try:
                evt = self.iq.get(timeout=0.3)
            except queue.Empty:
                continue

            midi = evt.get("midi_note", -1)
            if midi < 0:
                continue

            # Only accept BPM from Layer 1 if Max sync isn't connected
            bpm = evt.get("bpm", 0.0)
            if bpm > 0 and not self._harmony._in:
                self._bpm = bpm

            self._update_key(midi)
            self._maybe_advance(midi)

            root_pc, ctype = roman_to_midi(
                self._chord, self._key_root, self._key_mode)
            right_notes, left_notes = voice_chord(root_pc, ctype, midi)

            # Rail planning — used by MIDI2Piano.py (harmony_queue)
            # and transmitted to Max via CC 85-93 (for serial_driver.js)
            new_r, new_l = plan_positions(
                right_notes, left_notes, self._board_r, self._board_l
            )
            self._board_r.rail_pos = new_r
            self._board_l.rail_pos = new_l
            right_mask = self._board_r.notes_to_mask(right_notes)
            left_mask = self._board_l.notes_to_mask(left_notes)

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

            # Send full state to Max (harmony viz + serial driver)
            self._harmony.send(
                right_notes, left_notes,
                root_pc, ctype,
                self._key_root, self._key_mode, self._chord,
                new_r, new_l,
                right_mask, left_mask,
            )


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    import argparse                                          # noqa: PLC0415

    parser = argparse.ArgumentParser(description="MIDI2Chords")
    parser.add_argument("--train", metavar="FOLDER")
    args = parser.parse_args()

    if args.train:
        train_from_corpus(args.train)
        return

    shutdown = threading.Event()
    iq, oq = queue.Queue(), queue.Queue()
    gen = ChordGenerator(iq, oq, shutdown)
    gen.start()

    test = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60]
    print("Test: C major scale. Ctrl+C to stop.\n")

    def _feed():
        while not shutdown.is_set():
            for n in test:
                if shutdown.is_set():
                    break
                iq.put({"midi_note": n, "bpm": 120.0,
                       "conf": 0.9, "timestamp": time.time()})
                time.sleep(0.5)

    threading.Thread(target=_feed, daemon=True).start()

    try:
        while True:
            try:
                evt = oq.get(timeout=0.5)
                names = "C C# D Eb E F F# G Ab A Bb B".split()
                r = [
                    f"{names[n % 12]}{n // 12 - 1}"
                    for n in evt["right_notes"]
                ]
                lb = [
                    f"{names[n % 12]}{n // 12 - 1}"
                    for n in evt["left_notes"]
                ]
                key = evt['key']
                chord = evt['chord']
                ctype = evt['chord_type']
                bpm = evt['bpm']
                print(
                    f"  {key:<12}  {chord:<5} ({ctype:<6})"
                    f"  BPM:{bpm:<6.0f}"
                    f"  R: {' '.join(r):<20}"
                    f"  L: {' '.join(lb)}"
                )
            except queue.Empty:
                pass
    except KeyboardInterrupt:
        shutdown.set()
        gen.stop()
        print("\nStopped.")


if __name__ == "__main__":
    main()
