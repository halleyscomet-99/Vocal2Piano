# Vocal2Piano

A robot piano accompanist. A singer sings; a robot sitting on a real keyboard plays the piano part alongside. Two carriages (treble and bass) slide along the keys on stepper motors, each with 13 solenoid fingers.

The app runs in the browser: it loads a song (MIDI or sheet music) or turns a hummed tune into one, plans what the robot can reach and play, and streams it to the robot over USB during rehearsal. With Listen on, the piano follows the singer as it plays: it waits for each entrance, matches the singer's loudness, and moves to the key being sung.

## Repository

| Folder | What's in it |
|---|---|
| [`site/`](site) | The app: React + TypeScript, runs in Chrome or Edge, no install. Start here |
| [`software/`](software) | Offline Python tools: statistics from music datasets (McGill Billboard, POP909) and transcribers for local scores and recordings |
| [`firmware/`](firmware) | Teensy 4.1 firmware (PlatformIO): carriages, solenoids and safety limits, driven by the app over USB ([`PROTOCOL.md`](firmware/PROTOCOL.md)). Its README has the bring-up steps |
| [`hardware/CAD/`](hardware/CAD) | Fusion 360 models of the robot: carriages, fingers, mounts |
| [`hardware/PCB/`](hardware/PCB) | KiCad boards: `C0nTrollER` (Teensy, stepper drivers, power) and `PLAyeRs` (13 solenoid channels each), with fabrication files |
| [`legacy/`](legacy) | The first version (Python pipeline, Max/MSP patch, old firmware), kept for reference |

## Run

```bash
cd site
npm install
npm run dev
```

## Local songs

Scores and recordings to transcribe go in `software/input/`, and the results in `site/local/`. Both folders are git-ignored: transcriptions of other people's songs are for private practice, not for publishing.
