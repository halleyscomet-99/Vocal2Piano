# Software

Python pipeline and React web UI.

## Structure

```
software/
├── app/                   React/Vite web frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── FileMode.jsx       file upload UI
│   │   │   ├── LiveMode.jsx       live recording UI
│   │   │   ├── Piano88.jsx        88-key canvas piano (mono + polyphonic)
│   │   │   ├── Waveform.jsx       audio waveform renderer
│   │   │   └── TrackPlayer.jsx    multi-track playback
│   │   ├── hooks/
│   │   │   └── usePitchDetect.js  WebSocket + browser pitch detection
│   │   └── utils/
│   │       └── midiUtils.js       MIDI encoding + Tone.js playback
│   └── .env                       VITE_BACKEND_URL=http://localhost:8000
│
├── engine/
│   ├── Vocal2MIDI_live.py         real-time mic → MIDI
│   ├── Vocal2MIDI_file.py         audio file → MIDI (HTTP server)
│   ├── MIDI2Chords.py             melody → chord notes
│   └── MIDI2Piano.py              chord notes → Teensy serial commands
│
├── files/
│   ├── input/                     uploaded audio (git-ignored)
│   └── output/                    MIDI files + separated stems (git-ignored)
│
└── patch/
    └── Vocal2MIDI.maxpat          Max/MSP visualization patch
```

## Engine scripts

### `Vocal2MIDI_live.py`

Reads from the microphone and outputs MIDI to a virtual port (`Voice2Piano_Layer1`). Also starts a WebSocket server so the web UI can receive the same pitch data.

Three modes:

| Mode | Algorithm | Good for | Latency |
|------|-----------|----------|---------|
| `instrument` | CREPE neural net + aubio fallback | piano, guitar | ~100ms |
| `voice` | CREPE + pYIN fallback | singing, humming | ~200ms |
| `chord` | CQT 88-bin peak detection | chords, accompaniment | ~200ms |

```bash
python software/engine/Vocal2MIDI_live.py --mode instrument --ws
python software/engine/Vocal2MIDI_live.py --mode voice --ws
python software/engine/Vocal2MIDI_live.py --mode chord --ws
```

`--ws` opens a WebSocket on `localhost:8765`. The web UI auto-connects and uses the Python pitch results instead of browser autocorrelation. Falls back to browser if the socket isn't available.

Install CREPE for better accuracy (optional):
```bash
pip install crepe tensorflow
```

Detection events are also written to `layer2_queue`, which `MIDI2Chords.py` reads from when running in `--live` mode.

### `Vocal2MIDI_file.py`

Converts uploaded audio files to MIDI. Runs as an HTTP server for the web UI.

```bash
python software/engine/Vocal2MIDI_file.py --server
python software/engine/Vocal2MIDI_file.py song.mp3         # CLI
```

Source type is either auto-detected or user-specified:

| Type | How it's processed |
|------|--------------------|
| `voice` | pYIN extracts the melody line |
| `instrumental` | Basic Pitch ONNX transcribes polyphonically |
| `mixed` | Demucs separates stems, Basic Pitch runs on the accompaniment |

The SSE stream (`POST /convert/stream`) sends pipeline step events as they happen, so the web UI progress bar updates in real time. Stems (vocals + accompaniment) are saved and served via `GET /files/{filename}`.

### `MIDI2Chords.py`

Reads melody notes from `layer2_queue`, works out the current key, picks a chord using a Markov chain, and sends voicing targets to `harmony_queue`.

```bash
python software/engine/MIDI2Chords.py             # test run (C major scale)
python software/engine/MIDI2Chords.py --train software/files/input/
```

The chord transition weights are marked `# [RULE]` (fixed music theory) or `# [TRAIN]` (can be replaced by corpus data). Running `--train` parses MIDI files in the folder and writes `learned_transitions.json`, which is auto-loaded on the next run.

Output events look like:
```python
{
    'right_notes': [60, 64, 67],   # MIDI notes for right board
    'left_notes':  [48],            # MIDI notes for left board
    'chord': 'V',
    'chord_type': 'dom7',
    'key': 'G major',
}
```

### `MIDI2Piano.py`

Reads from `harmony_queue`, figures out where each board needs to slide to cover the target notes, and sends `MOVE` / `FIRE` commands to the Teensy over USB serial.

```bash
python software/engine/MIDI2Piano.py --live         # connect to MIDI2Chords
python software/engine/MIDI2Piano.py                # standalone test (I–IV–V–vi loop)
python software/engine/MIDI2Piano.py --port /dev/tty.usbmodem12345
```

Auto-detects the Teensy by USB vendor ID. Falls back to simulation mode (prints commands to terminal) if no Teensy is connected — useful for testing the chord logic without hardware.

The rail planner tries every position from −12 to +24 semitones for each board and picks the combination that covers the most chord notes, with a small penalty for large movements.

## Frontend

```bash
cd software/app
npm install
npm run dev    # http://localhost:3000
```

**Live tab** — Pick input mode (Instrument / Voice / Chord), record, then compare the original recording against the MIDI output with waveform tracks. The piano lights up keys in real time.

**File tab** — Pick source type (Auto / Voice / Instrumental / Mixed), drop a file. The pipeline progress updates step by step. For mixed files you get four tracks: original, MIDI output, separated vocals, and separated accompaniment.

## Max/MSP patch

Open `software/patch/Vocal2MIDI.maxpat` in Max/MSP. Set the MIDI input to `Voice2Piano_Layer1` (the virtual port opened by `Vocal2MIDI_live.py`). The patch shows a live 88-key keyboard and a rolling note history.

## Dependencies

```bash
pip install sounddevice aubio librosa scipy python-rtmidi websockets
pip install 'basic-pitch[onnx]' onnxruntime
pip install fastapi uvicorn python-multipart
pip install demucs
pip install pyserial
pip install crepe tensorflow      # optional
pip install music21               # optional, for --train
```