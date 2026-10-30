# Software

The Vocal2Piano app lives in [`site/`](../site). It runs in the browser, so the microphone, the piano and the USB link to the robot need nothing installed. This folder holds the offline tools: the scripts that turn published datasets into the statistics the app uses, and transcribers that turn local scores and recordings into demos.

| Feature | Where |
|---|---|
| Song import (MIDI, MusicXML), choosing the sung part | `site/src/engine/score.ts`, `midi.ts`, `musicxml.ts` |
| Hum a tune → chords → piano part | `site/src/humSession.ts`, `engine/harmonize.ts`, `arranger.ts` |
| The piano reacting to the voice as it plays (waits for the singer, loudness, key) | `site/src/engine/listen.ts` |
| Chord editing, styles, dynamics, intro and ending | `site/src/components/ChordsWindow.tsx`, `engine/arranger.ts` |
| Changing one part (speed, piano style, cuts) or one note (leave out, longer, shorter) | `site/src/engine/parts.ts`, `components/PartBar.tsx` |
| Pitch and timing check of a recording, or of singing with Listen on | `site/src/engine/pitchCheck.ts` |
| Planning what the robot can play | `site/src/engine/planner.ts` |
| Streaming to the robot | `site/src/robotLink.ts`, protocol in [`firmware/PROTOCOL.md`](../firmware/PROTOCOL.md) |

## Where the musical choices come from

| What | Source | Used for |
|---|---|---|
| Demo progressions | **McGill Billboard corpus**: expert chord annotations of 739 Billboard Hot 100 songs, 1958–91. J. A. Burgoyne, J. Wild, I. Fujinaga, *An Expert Ground Truth Set for Audio Chord Recognition and Music Analysis*, ISMIR 2011. CC0 | The most common 4-bar loop for each set of chords used in at least 5 % of songs (`billboard_stats.py` → `engine/billboardStats.ts`) |
| How songs start and end | McGill Billboard corpus | Start and end chord probabilities in the harmonizer |
| How melodies sit on chords, and how pop chords move | **POP909**: 909 pop songs with a melody track and beat-aligned chord labels. Z. Wang et al., *POP909: A Pop-song Dataset for Music Arrangement Generation*, ISMIR 2020. MIT | Melody-over-chord and half-bar transition probabilities in the harmonizer (`pop909_stats.py` → `engine/melodyStats.ts`) |
| Harmonizer design | **MySong**: I. Simon, D. Morris, S. Basu, *MySong: Automatic Accompaniment Generation for Vocal Melodies*, CHI 2008 | A hidden Markov model over chords with a user slider between chord habits and following the tune |
| Key finding | C. L. Krumhansl, *Cognitive Foundations of Musical Pitch*, 1990 (Krumhansl–Kessler key profiles, 1982) | Key of a hummed tune |
| Pitch tracking | A. de Cheveigné, H. Kawahara, *YIN, a fundamental frequency estimator for speech and music*, JASA 111(4), 2002 | Live and recorded singing |
| Piano styles | Standard, named keyboard accompaniment patterns: block chords, broken chords, Alberti bass, stride, bossa nova | `engine/arranger.ts` (each is described there) |
| Transcribing recordings | **Basic Pitch**: R. M. Bittner et al., *A Lightweight Instrument-Agnostic Model for Polyphonic Note Transcription and Multipitch Estimation*, ICASSP 2022. Apache-2.0 | `audio_to_midi.py` |

### How well the harmonizer does

Measured by `pop909_stats.py`: statistics from every other POP909 song, tested on the rest. The table shows how often the chosen chord matches the annotated one, per half bar, among the six chords of the key.

| Model | Correct |
|---|---|
| Chord habits only (ignores the tune) | 28.6 % |
| Tune only | 35.7 % |
| Both, melody weight 3 (the default, picked on the training half) | **39.1 %** |

`rs200_stats.py` runs the same test on the Rolling Stone 200 rock corpus (T. de Clercq, D. Temperley, *A corpus analysis of rock harmony*, Popular Music 30(1), 2011; CC BY 4.0). There, the tune adds almost nothing over chord habits (55.4 % vs 55.2 % per bar). That fits Temperley's "melodic-harmonic divorce" in rock (Popular Music 26(2), 2007), where rock melodies often ignore the chord underneath. This is why the harmonizer learns from pop songs instead.

## Scripts

```bash
# Billboard: demo loops, start/end chords
curl -L -o bb.tar.gz "https://www.dropbox.com/s/2lvny9ves8kns4o/billboard-2.0-salami_chords.tar.gz?dl=1" && tar xzf bb.tar.gz
python3 billboard_stats.py McGill-Billboard > ../site/src/engine/billboardStats.ts

# POP909: melody over chords, chord transitions, accuracy report (needs mido)
curl -L -o pop.zip https://github.com/music-x-lab/POP909-Dataset/raw/master/POP909.zip && unzip pop.zip
python3 pop909_stats.py POP909 ../site/src/engine/billboardStats.ts > ../site/src/engine/melodyStats.ts

# A score in numbered musical notation → a local demo (no packages needed)
python3 numbered_to_midi.py input/song.txt

# A piano recording → a local demo (Basic Pitch needs Python 3.8–3.11)
python3.11 -m venv .venv && .venv/bin/pip install basic-pitch
.venv/bin/python audio_to_midi.py input/song.mp3 "Song name" --bpm 123
```

Scores and recordings go in `input/` and transcriptions in `site/local/`. Both are git-ignored, because transcriptions of other people's songs are for private practice, not for publishing.
