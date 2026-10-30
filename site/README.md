# UI

<!-- TODO: screenshot of the rehearsal deck -->

## Run

```bash
cd site
npm install
npm run dev      # http://localhost:5173
npm run build    # static build in dist/, works on GitHub Pages
```

Use Chrome or Edge: the microphone and the USB robot link need them. Shortcuts: `Space` play/pause · `Home` back to start.

## What it does

The site is a small retro desktop. Every feature is a window, opened from the desktop icons or the Start menu.

| Window | |
|---|---|
| **Songs** | **Song file**: MIDI or sheet music (`.musicxml`, `.mxl`); for each part choose who plays it (*Me*, *Robot*, *Off*). **Hum**: four clicks count in, then the tune is hummed against the click. A lamp, a level meter and the note being heard show that the microphone is picking up the voice, and afterwards the recording can be played back. On **Done** it writes down the notes, finds the key and picks chords for every half bar; a slider sets how closely the chords follow the tune. **Demo**: the most common chord loops in the McGill Billboard corpus, plus local MIDI files in `site/local/`. Piano style (block chords, broken chords, Alberti bass, stride, bossa nova) and extra notes for hummed tunes and demos |
| **Chords** | Change any bar's chord and loudness; intro and rolled ending |
| **My Voice** | Measures the singer's comfortable range (saved in this browser) and fits the song's key to it |
| **Rehearsal** | Play, key, speed, **● Rec** (sing along and record), **👂 Listen** (the piano reacts to the voice as it plays, see below), **♪ Play** on the *My tune* track has the piano play the tune too, to learn it or to check a new key. Top-down view of the robot, and a scrolling timeline with tracks for the robot's hands, the piano, the tune (with the sung pitch on top) and the recording. Drag the tracks to scrub, click the bar below to jump. **Change one part**: drag across the bar numbers to pick bars, then give them their own speed, play them in another piano style, or cut them (click the ✂ on the ruler to bring them back). **Change one note**: click a block on the Piano track, then make it shorter or longer (− / +, a quarter beat at a time) or leave it out (🔇, or the Delete key); left-out notes stay as grey outlines; clicking one brings it back |
| **How I Sang** | After a recording: notes in tune, notes sung, sharp/flat, early/late, and the lines to practise |
| **Robot** | Playable share and problems list; connect over USB, home the hands, play on the real robot, or save `performance.json` |
| **Settings** | Color scheme (after Windows 95's: Desert, Standard, Eggplant, Rainy Day, Plum), what 👂 Listen does (wait for the singer, follow the singer's loudness, follow the singer's key), hand split, notes per hand, octave folding |

## How it works

**Planner** (`src/engine/planner.ts`) turns an arrangement into something the robot can physically play:

1. Transpose and time-scale; group notes into onset slices; split hands at the split point.
2. Optionally thin chords down to N voices per hand, keeping the outer voices.
3. **Viterbi search over carriage positions.** Treble goes first, then bass, which must stay to its left. The search minimizes missed notes and moves, and penalizes moves that cannot finish in time.
4. Assign every note a finger on either carriage, folding by octave if needed.
5. Schedule moves as late as possible, and release fingers before a move, before a re-strike, and after 2 s.
6. Check the solenoid current budget: full current while striking, hold duty afterwards.

**Part changes** (`src/engine/parts.ts`) sit on top of the whole-song settings, bar by bar (a speed, a piano style, or a cut) and note by note (left out, or a new length). Each piano note gets an id from its start and pitch, which the robot plan keeps, so a block clicked on the timeline leads back to its note. The song is rebuilt with each bar moved to its new place and length, so the robot plan, the tune, the pitch check and the timeline all use the changed version. A new style for a chord chart re-plays those bars from the chart. For a written piano part, the bars' chords are first read from the notes (the major or minor triad that best covers each half bar, ties going to the song's key), then played in the new style. Changing a part keeps the current place in the song.

**Listening** (`src/engine/listen.ts`): with 👂 Listen on, the microphone's pitch and level go to a listener 25 times a second, and the piano reacts like an accompanist would. It never follows the singer's tempo note by note; it only waits.

- **Waits for the entrance.** The tune is split into lines at rests of 1.5 beats or more. Nothing after the start of the next line is scheduled until the voice has been heard; if there's no voice 0.4 s after it, the piano stops and waits. When the singing starts it comes in together, from that line, or from the line before if that's the starting pitch.
- **Stops when the singer stops.** Quiet for 1.5 s (or 3 beats) where the tune should be sung, and it stops. When the singing resumes it picks up from the note where it stopped, the start of that line or the next line, whichever starts on the sung pitch. For the next 1.5 s it keeps comparing the singing with all three, and moves once if another one clearly fits better (e.g. two of them start on the same note).
- **Plays as loud as the singing**, relative to the singer's usual level (0.65× to 1.3×), on the speakers and in the robot's strike strength.
- **Moves to the sung key.** If a whole line was sung a steady number of semitones away from the written key, the piano moves there in the rest after it.
- The sung pitch is drawn live on the *My tune* track, and **How I Sang** is built from it, with no recording needed. While ● Rec is on the piano keeps time and doesn't wait, so the recording stays one continuous take.
- To tell the voice from the piano: a level well above the last 3 s's quietest, a clear pitch, and, if that pitch is one the piano is sounding but not the one to be sung, it is taken as the piano. Headphones, or a microphone close to the singer, still work best.

**Humming** (`src/humSession.ts`, `src/engine/harmonize.ts`): offline YIN pitch track → note segments (split on pitch changes, on sharp level drops, and on softer dips where the same note is hummed twice without a break) → tuning that follows the singer (it starts from the first notes and moves along, so slowly drifting flat or sharp doesn't change notes) → a note halfway between two is taken in the key of the tune → the singer's average lag behind the click taken out → eighth-note quantization → Krumhansl–Schmuckler key → a hidden Markov model over half bars, in the manner of MySong (CHI 2008): melody-over-chord and chord-transition probabilities from POP909, start and end chords from Billboard. The recording's start is timed from the earliest of its audio callbacks, as late callbacks on a busy page would shift every note. On synthetic humming with loose timing, scoops, vibrato, ±22 cents per note and drift of up to 0.9 semitones, 87 % of notes come out right (78 % before these steps); most of the rest are repeated notes hummed without a dip. Where every number comes from, and how accurate it is, is in [`software/README.md`](../software/README.md).

**Robot link** (`src/robotLink.ts`) speaks the line protocol in [`firmware/PROTOCOL.md`](../firmware/PROTOCOL.md). The other end is the Teensy firmware in [`firmware/`](../firmware).

Hardware constants live in `src/engine/robot.ts`. Carriage speed and acceleration, hold duty and the current budget are **estimates**; update them once they are measured on the real robot.

## Layout

```
src/
├── engine/              testable in Node (except musicxml.ts, which needs DOMParser)
│   ├── robot.ts         geometry, finger ↔ key, PCA9685 channel map, move timing
│   ├── planner.ts       playability planner
│   ├── arranger.ts      chord chart → piano part (5 named styles, passing/grace notes, dynamics, intro/ending)
│   ├── billboardStats.ts, melodyStats.ts   generated from Billboard and POP909 by software/*.py
│   ├── harmonize.ts     hummed audio → notes → key → chords
│   ├── listen.ts        the piano reacting to the voice as it plays
│   ├── parts.ts         per-part speed, style and cuts
│   ├── pitchCheck.ts    a recording, or what Listen heard, against the tune
│   ├── score.ts         imported parts, melody guess, top-line split
│   ├── midi.ts          MIDI import, performance export
│   ├── musicxml.ts      MusicXML / .mxl import
│   ├── voice.ts         YIN pitch, vocal range, key suggestion
│   ├── audioAnalysis.ts beat / chord / key detection from audio (not used by the UI at the moment)
│   └── types.ts
├── components/          desktop + windows, Stage (canvas), TrackView (timeline), pixel icons
├── audio.ts             piano + recordings + robot on one scheduler (can wait for the singer, and take notes added live)
├── mic.ts               shared microphone: live pitch and raw capture
├── humSession.ts        humming against a click, with a level meter
├── robotLink.ts         Web Serial link to the Teensy
└── App.tsx
```

## Not done yet

- Firmware that implements the serial protocol (`firmware/`)
- Measured hardware constants in `src/engine/robot.ts`
- Part changes count bars in 4/4 at the song's first tempo; a recording made before a part change doesn't move with it
- Sheet music repeats and voltas are not expanded
- Listen has only been tried with a synthetic voice fed in as the microphone, not with a real singer next to the real robot
