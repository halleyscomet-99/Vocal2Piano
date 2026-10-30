"""Turn a piano recording into a MIDI demo for the site, with Spotify's Basic Pitch.

Basic Pitch: R. M. Bittner et al., "A Lightweight Instrument-Agnostic Model for Polyphonic Note
Transcription and Multipitch Estimation", ICASSP 2022. Apache-2.0: https://github.com/spotify/basic-pitch

Setup (once; Basic Pitch needs Python 3.8–3.11):
    python3.11 -m venv .venv && .venv/bin/pip install basic-pitch

Usage:
    .venv/bin/python audio_to_midi.py input/song.mp3 "Song name" [--bpm 123]

Writes site/local/<name>.mid and lists it in site/local/demos.json, so it shows up under
Songs → Demo while the dev server runs. site/local/ is git-ignored and never built into the
site: transcriptions of other people's songs are for private practice only.
"""

import argparse

from local_demos import add_demo, demo_file


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("name")
    ap.add_argument("--bpm", type=float, help="tempo to write into the MIDI (otherwise Basic Pitch's 120)")
    ap.add_argument("--min-ms", type=float, default=60, help="drop notes shorter than this")
    a = ap.parse_args()

    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    # Piano range only; slightly stricter onsets than the defaults to skip ghost notes.
    _, midi, _ = predict(
        a.audio,
        ICASSP_2022_MODEL_PATH,
        onset_threshold=0.55,
        frame_threshold=0.3,
        minimum_note_length=a.min_ms,
        minimum_frequency=27.5,
        maximum_frequency=4186.0,
        midi_tempo=a.bpm or 120,
    )
    for inst in midi.instruments:
        inst.name = "Piano"
        inst.notes = [n for n in inst.notes if n.end - n.start >= a.min_ms / 1000 and n.velocity >= 20]

    out = demo_file(a.name)
    midi.write(str(out))
    notes = sum(len(i.notes) for i in midi.instruments)
    bpm = a.bpm or 120
    add_demo(a.name, out, bpm=bpm, bars=round(midi.get_end_time() * bpm / 240), source="recording")
    print(f"wrote {out} ({notes} notes)")


if __name__ == "__main__":
    main()
