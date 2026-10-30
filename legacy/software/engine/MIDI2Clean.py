"""
Voice2Piano -- MIDI2Clean.py
=============================
Layer 2a: MIDI post-processing — clean, quantise, hardware-adapt.

Takes raw MIDI from Layer 1 (pYIN / Basic Pitch) and produces a
version that is:
  1. Noise-free   (short/quiet notes removed)
  2. Quantised    (notes snapped to a rhythmic grid)
  3. Hardware-friendly (within the 15+15 solenoid range per chord)
  4. JSON-serialisable (for the Piano Roll frontend)

Endpoints (when run as server):
  POST /clean        body: {midi_b64, bpm, style, transpose}
                     returns: {melody, accomp, bpm, stats}
  POST /arrange      body: {melody, bpm, style, transpose}
                     returns: {accomp}
  POST /send_teensy  body: {accomp, bpm, transpose}
                     returns: {status}

Note format (used by PianoRoll.jsx):
  { midi: int, time: float (sec), duration: float (sec), velocity: int }
"""

import io
import base64
import json
import logging
from pathlib import Path

log = logging.getLogger("V2P-CLEAN")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)

# ─────────────────────────────────────────────────────────────────────────────
# MIDI CLEANING
# ─────────────────────────────────────────────────────────────────────────────

# Minimum note duration to keep (seconds)
MIN_NOTE_DUR = 0.12   # raised from 0.08 — filters grace notes

# Minimum velocity to keep
MIN_VELOCITY = 30     # raised from 20 — filters ghost notes

# Quantise grid options (fraction of a beat)
GRID_OPTIONS = {
    "coarse": 1 / 2,   # half-beat
    "normal": 1 / 4,   # quarter-beat (default)
    "fine": 1 / 8,   # eighth-beat
}


def load_midi_notes(midi_bytes: bytes) -> list[dict]:
    """
    Parse a MIDI file and return a flat list of note dicts.
    Requires: pip install pretty_midi
    """
    try:
        import pretty_midi         # noqa: PLC0415
    except ImportError:
        raise RuntimeError("pip install pretty_midi")

    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    notes = []
    for inst in pm.instruments:
        if inst.is_drum:
            continue
        for n in inst.notes:
            notes.append({
                "midi": n.pitch,
                "time": round(n.start, 4),
                "duration": round(n.end - n.start, 4),
                "velocity": n.velocity,
            })
    notes.sort(key=lambda n: n["time"])
    return notes


def remove_noise(notes: list[dict]) -> list[dict]:
    """
    Drop notes that are too short or too quiet to be intentional.
    """
    return [
        n for n in notes
        if n["duration"] >= MIN_NOTE_DUR and n["velocity"] >= MIN_VELOCITY
    ]


def quantise(
    notes: list[dict],
    bpm: float,
    grid: str = "normal",
) -> list[dict]:
    """
    Snap note start times and durations to the nearest rhythmic grid point.
    Grid is expressed as a fraction of a beat (e.g. 1/4 = sixteenth note).
    """
    beat_sec = 60.0 / max(bpm, 1)
    step = beat_sec * GRID_OPTIONS.get(grid, GRID_OPTIONS["normal"])

    result = []
    for n in notes:
        snapped_start = round(n["time"] / step) * step
        snapped_dur = max(step, round(n["duration"] / step) * step)
        result.append({
            **n,
            "time": round(snapped_start, 4),
            "duration": round(snapped_dur, 4),
        })
    return result


def clamp_to_hardware(notes: list[dict]) -> list[dict]:
    """
    Clamp MIDI pitches to A0-C8 (21-108), the full piano range.
    Notes outside this range are octave-shifted into range.
    """
    out = []
    for n in notes:
        midi = n["midi"]
        while midi < 21:
            midi += 12
        while midi > 108:
            midi -= 12
        out.append({**n, "midi": midi})
    return out


def apply_transpose(notes: list[dict], semitones: int) -> list[dict]:
    """Shift all notes by semitones, then clamp to range."""
    shifted = [{**n, "midi": n["midi"] + semitones} for n in notes]
    return clamp_to_hardware(shifted)


def assess_playability(notes: list[dict]) -> dict:
    """
    Check how hardware-friendly a set of notes is.
    Each 'chord' (notes within 50ms of each other) should span ≤15 semitones
    so one board can cover it, or ≤30 semitones across both boards.
    Returns a dict with stats and a playability score 0-1.
    """
    if not notes:
        return {"score": 1.0, "chords": 0, "problem_chords": 0}

    # Group simultaneous notes (within 50ms)
    groups = []
    buf = [notes[0]]
    for n in notes[1:]:
        if n["time"] - buf[0]["time"] < 0.05:
            buf.append(n)
        else:
            groups.append(buf)
            buf = [n]
    if buf:
        groups.append(buf)

    problem = 0
    for g in groups:
        midis = [n["midi"] for n in g]
        span = max(midis) - min(midis)
        if span > 30:   # can't cover with both boards
            problem += 1

    score = 1.0 - (problem / max(len(groups), 1))
    return {
        "score": round(score, 3),
        "chords": len(groups),
        "problem_chords": problem,
    }


def clean_midi(
    midi_bytes: bytes,
    bpm: float = 120.0,
    transpose: int = 0,
    grid: str = "normal",
) -> tuple[list[dict], list[dict], dict]:
    """
    Full cleaning pipeline.
    Returns (cleaned_notes, removed_notes, stats_dict).
    removed_notes carry a 'remove_reason' key for display.
    """
    raw = load_midi_notes(midi_bytes)
    log.info("Loaded %d raw notes", len(raw))

    # Tag removed notes with reason before denoising
    removed = []
    denoised = []
    # First pass: duration and velocity
    after_dv = []
    for n in raw:
        if n["duration"] < MIN_NOTE_DUR:
            removed.append({**n, "remove_reason": "too_short"})
        elif n["velocity"] < MIN_VELOCITY:
            removed.append({**n, "remove_reason": "too_quiet"})
        else:
            after_dv.append(n)

    # Second pass: duplicate notes (same pitch within 80ms)
    after_dv.sort(key=lambda x: (x["time"], x["midi"]))
    for i, n in enumerate(after_dv):
        is_dup = any(
            abs(n["time"] - after_dv[j]["time"]) < 0.08
            and n["midi"] == after_dv[j]["midi"]
            and j != i
            for j in range(max(0, i - 3), i)
        )
        if is_dup:
            removed.append({**n, "remove_reason": "duplicate"})
        else:
            denoised.append(n)
    log.info("After noise removal: %d notes (%d removed)",
             len(denoised), len(removed))

    quantised = quantise(denoised, bpm, grid)
    transposed = apply_transpose(quantised, transpose)

    # Also transpose removed notes for display alignment
    removed_t = apply_transpose(removed, transpose)

    playability = assess_playability(transposed)
    stats = {
        "raw_count": len(raw),
        "cleaned_count": len(transposed),
        "removed": len(removed),
        "removed_short": sum(
            1 for n in removed
            if n["remove_reason"] == "too_short"
        ),
        "removed_quiet": sum(
            1 for n in removed
            if n["remove_reason"] == "too_quiet"
        ),
        "removed_dup": sum(
            1 for n in removed
            if n["remove_reason"] == "duplicate"
        ),
        "playability": playability,
    }
    log.info("Cleaning done: %s", stats)
    return transposed, removed_t, stats


# ─────────────────────────────────────────────────────────────────────────────
# ARRANGEMENT — splits melody into melody + accompaniment voicing
# ─────────────────────────────────────────────────────────────────────────────

def split_melody_accomp(
    notes: list[dict],
) -> tuple[list[dict], list[dict]]:
    """
    Simple heuristic split: highest note in each chord = melody,
    remaining notes = accompaniment.
    If only one note at a time (monophonic), all goes to melody.
    """
    if not notes:
        return [], []

    # Group simultaneous notes
    groups = []
    buf = [notes[0]]
    for n in notes[1:]:
        if n["time"] - buf[0]["time"] < 0.05:
            buf.append(n)
        else:
            groups.append(sorted(buf, key=lambda x: -x["midi"]))
            buf = [n]
    if buf:
        groups.append(sorted(buf, key=lambda x: -x["midi"]))

    melody = []
    accomp = []
    for g in groups:
        melody.append(g[0])
        accomp.extend(g[1:])

    return melody, accomp


# ─────────────────────────────────────────────────────────────────────────────
# HTTP SERVER
# ─────────────────────────────────────────────────────────────────────────────

def run_server(port: int = 8001):
    """
    FastAPI server exposing /clean, /arrange, /send_teensy.
    Runs alongside Vocal2MIDI_file.py (port 8000).
    """
    try:
        import uvicorn                                      # noqa: PLC0415
        from fastapi import FastAPI, HTTPException          # noqa: PLC0415
        from fastapi.middleware.cors import CORSMiddleware  # noqa: PLC0415
        from pydantic import BaseModel                     # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError(
            "pip install fastapi uvicorn pydantic"
        ) from exc

    app = FastAPI(title="Voice2Piano MIDI Clean", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    class CleanRequest(BaseModel):
        midi_b64: str
        bpm: float = 120.0
        transpose: int = 0
        grid: str = "normal"

    class ArrangeRequest(BaseModel):
        melody: list[dict]
        bpm: float = 120.0
        style: str = "pop"
        transpose: int = 0

    class SendRequest(BaseModel):
        accomp: list[dict]
        bpm: float = 120.0
        transpose: int = 0

    @app.get("/")
    def health():
        return {"status": "ok", "service": "midi-clean", "version": "1.0.0"}

    @app.post("/clean")
    def clean(req: CleanRequest):
        """
        Clean + quantise a raw MIDI file.
        Input:  base64-encoded MIDI bytes
        Output: {melody, accomp, stats}
        """
        try:
            midi_bytes = base64.b64decode(req.midi_b64)
        except Exception:
            raise HTTPException(400, "Invalid base64 MIDI data")

        try:
            notes, removed, stats = clean_midi(
                midi_bytes, req.bpm, req.transpose, req.grid
            )
        except Exception as exc:
            raise HTTPException(500, str(exc))

        melody, accomp = split_melody_accomp(notes)
        return {
            "melody": melody,
            "accomp": accomp,
            "removed": removed,
            "stats": stats,
            "bpm": req.bpm,
        }

    @app.post("/arrange")
    def arrange(req: ArrangeRequest):
        """
        Generate accompaniment from a melody note list.
        Calls MIDI2Chords logic internally.
        Input:  melody notes + style/bpm/transpose
        Output: {accomp}
        """
        try:
            from MIDI2Chords import (              # noqa: PLC0415
                detect_key, next_chord, roman_to_midi,
                NOTE_NAMES, load_learned_transitions,
            )
        except ImportError:
            raise HTTPException(500, "MIDI2Chords.py not found")

        load_learned_transitions()

        beat_sec = 60.0 / max(req.bpm, 1)
        bar_sec = beat_sec * 4

        # Build pitch histogram from melody
        pitch_counts = [0.0] * 12
        for n in req.melody:
            pitch_counts[n["midi"] % 12] += n["duration"]

        key_root, key_mode = detect_key(pitch_counts)
        log.info(
            "Arrange: key=%s %s style=%s",
            NOTE_NAMES[key_root], key_mode, req.style,
        )

        # Walk through bars and assign chords
        if not req.melody:
            return {"accomp": []}

        total_sec = max(
            n["time"] + n["duration"] for n in req.melody
        )
        accomp = []
        chord = "I" if key_mode == "major" else "i"

        # ── Note map builder ─────────────────────────────────────────
        def get_notes(root_pc, ctype, transp):
            from MIDI2Chords import CHORD_INTERVALS as CI  # noqa
            ivs = CI.get(ctype, [0, 4, 7])
            b = root_pc % 12 + 36          # bass octave 2
            b5 = (root_pc + 7) % 12 + 36
            b3 = (root_pc + (ivs[1] if len(ivs) > 1 else 4)) % 12 + 36
            m = root_pc % 12 + 60          # mid octave 4
            m3 = (root_pc + (ivs[1] if len(ivs) > 1 else 4)) % 12 + 60
            m5 = (root_pc + 7) % 12 + 60
            m7 = (root_pc + (ivs[3] if len(ivs) > 3 else 10)) % 12 + 60
            h = root_pc % 12 + 72          # high octave 5
            h3 = (root_pc + (ivs[1] if len(ivs) > 1 else 4)) % 12 + 72
            h5 = (root_pc + 7) % 12 + 72
            ch = [(root_pc + i) % 12 + 60 for i in ivs]
            def tr(n): return n + transp
            return {
                "bass": tr(b), "bass5": tr(b5), "bass3": tr(b3),
                "mid": tr(m), "mid3": tr(m3), "mid5": tr(m5),
                "mid7": tr(m7),
                "high": tr(h), "high3": tr(h3), "high5": tr(h5),
                "chord": [tr(n) for n in ch],
                "chord_hi": [tr(n + 12) for n in ch],
                "power": [tr(b), tr(b5)],
            }

        def clamp(n):
            while n < 21:
                n += 12
            while n > 108:
                n -= 12
            return int(n)

        def add_note(t_abs, key, dur_b, vel, nm):
            dur = round(beat_sec * dur_b, 4)
            if isinstance(key, int):
                targets = [key]
            else:
                raw = nm.get(key, [])
                targets = [raw] if isinstance(raw, int) else raw
            for n in targets:
                accomp.append({
                    "midi": clamp(n),
                    "time": round(t_abs, 4),
                    "duration": dur,
                    "velocity": vel,
                })

        # ── Patterns (16th-note grid: S = one sixteenth note) ────────────
        S = beat_sec / 4.0

        STYLE_PATTERNS = {
            # POP: four-on-floor bass, chord stabs on 2+4
            "pop": [
                (0, "bass", 4.0, 85),
                (4, "chord", 2.0, 65),
                (6, "mid3", 1.0, 55),
                (8, "bass5", 4.0, 78),
                (12, "chord", 2.0, 65),
                (14, "mid5", 1.0, 55),
            ],
            # R&B: lazy syncopated bass, lush sustained chords
            "rnb": [
                (0, "bass", 3.0, 88),
                (2, "chord", 1.5, 58),
                (6, "bass3", 1.5, 72),
                (8, "bass", 2.0, 82),
                (10, "chord", 2.0, 60),
                (12, "mid7", 1.0, 52),
                (14, "chord", 2.0, 60),
            ],
            # FUNK: 16th-note ghost bass + staccato chord stabs
            "funk": [
                (0, "bass", 1.0, 90),
                (2, "bass5", 0.5, 60),
                (3, "bass", 0.5, 72),
                (4, "chord", 0.5, 70),
                (6, "bass3", 0.5, 65),
                (7, "bass", 0.5, 58),
                (8, "bass", 1.0, 85),
                (10, "bass5", 0.5, 60),
                (12, "chord", 0.5, 70),
                (13, "mid", 0.5, 55),
                (14, "bass3", 0.5, 65),
            ],
            # JAZZ: walking bass, off-beat comp voicings
            "jazz": [
                (0, "bass", 1.0, 82),
                (2, "chord", 1.0, 58),
                (4, "bass3", 1.0, 76),
                (6, "mid7", 1.0, 54),
                (8, "bass5", 1.0, 78),
                (10, "chord", 1.0, 58),
                (12, "bass3", 1.0, 72),
                (14, "chord", 1.0, 56),
            ],
            # ROCK: power chords on 1+3, crashes on 2+4
            "rock": [
                (0, "power", 2.0, 92),
                (4, "chord", 1.0, 78),
                (6, "bass", 1.0, 80),
                (8, "power", 2.0, 90),
                (12, "chord", 1.5, 80),
                (14, "bass5", 1.0, 70),
            ],
            # CLASSICAL: Alberti bass (low-high-mid-high)
            "classical": [
                (0, "bass", 1.0, 80),
                (4, "high3", 0.8, 58),
                (8, "mid5", 0.8, 62),
                (12, "high3", 0.8, 58),
            ],
            # FINGERPICKING: Travis-style alternating thumb + fingers
            "fingerpicking": [
                (0, "bass", 1.5, 82),
                (2, "mid", 0.7, 60),
                (3, "mid3", 0.7, 56),
                (4, "bass5", 1.5, 76),
                (6, "mid5", 0.7, 58),
                (7, "high", 0.7, 52),
                (8, "bass", 1.5, 80),
                (10, "mid3", 0.7, 62),
                (11, "mid5", 0.7, 56),
                (12, "bass5", 1.5, 74),
                (14, "mid", 0.7, 58),
                (15, "mid3", 0.7, 54),
            ],
            # BOSSA NOVA: syncopated clave rhythm
            "bossa": [
                (0, "bass", 1.0, 80),
                (3, "chord", 1.5, 62),
                (5, "bass3", 1.0, 72),
                (8, "bass5", 1.0, 76),
                (10, "chord", 1.0, 60),
                (13, "mid7", 1.5, 55),
            ],
        }

        ALIASES = {
            "pop": "pop", "rnb": "rnb", "r&b": "rnb",
            "funk": "funk", "jazz": "jazz", "rock": "rock",
            "classical": "classical",
            "fingerpicking": "fingerpicking", "bossa": "bossa",
        }
        pkey = ALIASES.get(req.style.lower(), "pop")
        pattern = STYLE_PATTERNS[pkey]

        t = 0.0
        while t < total_sec:
            nearby = [
                n for n in req.melody
                if n["time"] >= t and n["time"] < t + bar_sec
            ]
            mel_pc = (
                nearby[0]["midi"] % 12 if nearby else key_root
            )
            chord = next_chord(
                chord, key_mode, mel_pc, key_root
            )
            root_pc, ctype = roman_to_midi(
                chord, key_root, key_mode
            )
            nm = get_notes(root_pc, ctype, req.transpose)

            for (frac, nkey, dur_b, vel) in pattern:
                note_time = t + frac * S
                if note_time >= total_sec:
                    break
                add_note(note_time, nkey, dur_b, vel, nm)

            t += bar_sec

        return {"accomp": accomp}

    @app.post("/send_teensy")
    def send_teensy(req: SendRequest):
        """
        Send accompaniment notes to Teensy via MIDI2Piano.py serial driver.
        """
        try:
            from MIDI2Piano import PianoDriver     # noqa: PLC0415
            import queue as _q                     # noqa: PLC0415
            import threading                       # noqa: PLC0415
        except ImportError:
            raise HTTPException(500, "MIDI2Piano.py not found")

        shutdown = threading.Event()
        q = _q.Queue()
        for n in sorted(req.accomp, key=lambda x: x["time"]):
            q.put({
                "right_notes": [n["midi"]],
                "left_notes": [],
                "chord": "?",
                "chord_type": "?",
                "key": "?",
                "bpm": req.bpm,
            })

        driver = PianoDriver(q, shutdown)
        driver.start()

        import time as _time                       # noqa: PLC0415
        _time.sleep(0.5)
        shutdown.set()
        driver.stop()
        return {"status": "sent", "notes": len(req.accomp)}

    print(f"MIDI Clean Server → http://localhost:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    import argparse                                # noqa: PLC0415
    parser = argparse.ArgumentParser(
        description="MIDI2Clean — clean and quantise MIDI"
    )
    parser.add_argument("input", nargs="?", help="MIDI file path")
    parser.add_argument("--bpm", type=float, default=120.0)
    parser.add_argument("--transpose", type=int, default=0)
    parser.add_argument("--grid", default="normal",
                        choices=["coarse", "normal", "fine"])
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()

    if args.server:
        run_server(args.port)
        return

    if not args.input:
        parser.print_help()
        return

    midi_bytes = Path(args.input).read_bytes()
    notes, stats = clean_midi(
        midi_bytes, args.bpm, args.transpose, args.grid
    )
    print(json.dumps({"stats": stats, "note_count": len(notes)}, indent=2))


if __name__ == "__main__":
    main()
