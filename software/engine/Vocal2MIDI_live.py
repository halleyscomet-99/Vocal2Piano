"""
Voice2Piano -- Vocal2MIDI_live.py  v4.0
=========================================
Three detection modes:

  voice       CREPE tiny + pYIN fallback
              200ms window, monophonic singing/humming

  instrument  CREPE tiny + aubio fallback
              100ms window, monophonic melody instrument

  chord       CQT multi-peak + aubio onset
              200ms window, polyphonic chords / accompaniment
              Detects up to 6 simultaneous notes
              Best for: piano chords, guitar strumming

WEBSOCKET (--ws)
  Pushes events to ws://localhost:<port>
  Each message: { midi, note, freq, conf, bpm, is_beat, engine, chord_notes }
  chord_notes is a list for chord mode: [{ midi, note, conf }, ...]

USAGE
-----
  python Vocal2MIDI_live.py --mode voice --ws
  python Vocal2MIDI_live.py --mode instrument --ws
  python Vocal2MIDI_live.py --mode chord --ws

DEPENDENCIES
------------
  pip install sounddevice aubio librosa scipy python-rtmidi websockets
  pip install crepe tensorflow   (optional, improves voice/instrument modes)

ACCURACY NOTES
--------------
  Chord mode uses CQT (Constant-Q Transform) which aligns frequency bins
  exactly with semitone steps. This gives cleaner peak separation than FFT.
  Multi-peak detection with prominence filtering removes octave duplicates.
  Adaptive noise gate calibrates to your room automatically.
"""

import threading
import queue
import time
import argparse
import logging
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import sounddevice as sd
import aubio
import librosa
import rtmidi
from scipy.signal import find_peaks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(threadName)s] %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("V2P-LIVE")


# =============================================================================
# CONFIGURATION
# =============================================================================

SAMPLE_RATE = 44100
HOP_SIZE = 256
CHANNELS = 1

# Adaptive noise gate (0 = auto-calibrate from first 0.5s of ambient noise)
NOISE_GATE_RMS = 0.0
_gate_rms = 0.015

# CREPE settings
CREPE_MODEL = "tiny"
CREPE_CONF_THRESH = 0.50
CREPE_STEP_SIZE = 10

# Fallback thresholds
PYIN_CONF_THRESH = 0.35
AUBIO_CONF_THRESH = 0.40

# Chord detection (CQT multi-peak)
CHORD_ENERGY_THRESH = 0.20  # fraction of peak energy to accept a note
CHORD_PROMINENCE = 0.08  # min peak prominence to avoid noise spikes
CHORD_DISTANCE = 2  # min semitone distance between peaks
MAX_CHORD_NOTES = 6  # max simultaneous notes
CHORD_OCTAVE_FILTER = True  # suppress octave duplicates

# Onset detection
ONSET_THRESHOLD = 0.18
ONSET_SILENCE_DB = -58

# Buffer sizes
BUFFER_SEC_VOICE = 0.20
BUFFER_SEC_INSTRUMENT = 0.10
BUFFER_SEC_CHORD = 0.20
MIN_BUFFER_SEC = 0.06

# Pitch range
F0_MIN = 60.0
F0_MAX = 2000.0
OCTAVE_SHIFT = -12

# Smoothing (monophonic modes)
SMOOTHING_FRAMES = 3

# Rhythm
AUBIO_WIN_SIZE = 1024
BPM_MIN = 50.0
BPM_MAX = 220.0

# MIDI
VIRTUAL_PORT_NAME = "Voice2Piano_Layer1"
NOTE_ON = 0x90
NOTE_OFF = 0x80
DEFAULT_VELOCITY = 80

# Queues
AUDIO_QUEUE_MAX = 40
LAYER2_QUEUE_MAX = 100


# =============================================================================
# CHECK CREPE
# =============================================================================


def _check_crepe():
    try:
        import crepe as _c  # noqa: F401, PLC0415

        return True
    except ImportError:
        return False


CREPE_AVAILABLE = _check_crepe()
if not CREPE_AVAILABLE:
    log.warning(
        "CREPE not installed -- using pYIN/aubio fallback.\n"
        "  pip install crepe tensorflow"
    )
else:
    log.info("CREPE available.")


# =============================================================================
# SHARED STATE
# =============================================================================

audio_queue: queue.Queue = queue.Queue(maxsize=AUDIO_QUEUE_MAX)
layer2_queue: queue.Queue = queue.Queue(maxsize=LAYER2_QUEUE_MAX)
ws_queue: queue.Queue = queue.Queue(maxsize=50)
shutdown_event = threading.Event()

_active_mode = ["instrument"]

_aubio_pitch = aubio.pitch("yinfft", AUBIO_WIN_SIZE, HOP_SIZE, SAMPLE_RATE)
_aubio_pitch.set_unit("Hz")
_aubio_pitch.set_silence(-65)

_onset_o = aubio.onset("complex", AUBIO_WIN_SIZE, HOP_SIZE, SAMPLE_RATE)
_onset_o.set_threshold(ONSET_THRESHOLD)
_onset_o.set_silence(ONSET_SILENCE_DB)

_tempo_o = aubio.tempo("default", AUBIO_WIN_SIZE, HOP_SIZE, SAMPLE_RATE)

_audio_buf: list = []
_last_f0: float = 0.0
_last_conf: float = 0.0
_last_engine: str = "none"
_f0_history: list = []

_calibration_frames: list = []
_calibration_done = False


# =============================================================================
# ADAPTIVE NOISE GATE
# =============================================================================


def calibrate_noise_gate(frame):
    """Measure ambient RMS for first 0.5s; gate = 3x ambient."""
    global _calibration_frames, _calibration_done, _gate_rms

    if _calibration_done:
        return

    _calibration_frames.append(float(np.sqrt(np.mean(frame**2))))

    target = int(0.5 * SAMPLE_RATE / HOP_SIZE)
    if len(_calibration_frames) >= target:
        ambient = float(np.median(_calibration_frames))
        _gate_rms = max(ambient * 3.0, 0.006)
        _calibration_done = True
        log.info("Gate calibrated: ambient=%.4f  gate=%.4f", ambient, _gate_rms)


def is_silent(frame):
    return float(np.sqrt(np.mean(frame**2))) < _gate_rms


# =============================================================================
# CREPE  (neural, most accurate for monophonic)
# =============================================================================


def detect_crepe(audio):
    """
    CREPE neural pitch detector.
    Accuracy: 97.4% within 25 cents (MDB-stem-synth benchmark).
    Returns (f0_hz, confidence).
    """
    if not CREPE_AVAILABLE:
        return 0.0, 0.0
    try:
        import crepe as _crepe  # noqa: PLC0415

        if len(audio) < 1024:
            audio = np.pad(audio, (0, 1024 - len(audio)))

        _, freq_arr, conf_arr, _ = _crepe.predict(
            audio.astype(np.float64),
            SAMPLE_RATE,
            model_capacity=CREPE_MODEL,
            viterbi=True,
            center=True,
            step_size=CREPE_STEP_SIZE,
            verbose=0,
        )

        if freq_arr is None or len(freq_arr) == 0:
            return 0.0, 0.0

        voiced = (conf_arr > 0.40) & (freq_arr >= F0_MIN) & (freq_arr <= F0_MAX)
        if not np.any(voiced):
            return 0.0, 0.0

        f0v = freq_arr[voiced]
        cv = conf_arr[voiced]
        idx = np.argsort(f0v)
        cumconf = np.cumsum(cv[idx])
        mid = np.searchsorted(cumconf, cumconf[-1] / 2)
        return float(f0v[idx][mid]), float(np.mean(cv))

    except Exception as exc:
        log.debug("CREPE: %s", exc)
        return 0.0, 0.0


# =============================================================================
# pYIN  (voice fallback)
# =============================================================================


def detect_pyin(audio):
    """pYIN probabilistic YIN. Returns (f0, confidence)."""
    if len(audio) < 4096:
        audio = np.pad(audio, (0, 4096 - len(audio)))

    f0_arr, vf, vp = librosa.pyin(
        audio.astype(np.float32),
        fmin=F0_MIN,
        fmax=F0_MAX,
        sr=SAMPLE_RATE,
        hop_length=HOP_SIZE,
        frame_length=4096,
        fill_na=None,
    )
    if f0_arr is None or len(f0_arr) == 0:
        return 0.0, 0.0

    ok = vf & (vp >= PYIN_CONF_THRESH) & ~np.isnan(f0_arr)
    if not np.any(ok):
        return 0.0, 0.0

    return float(np.median(f0_arr[ok])), float(np.mean(vp[ok]))


# =============================================================================
# aubio (instrument fallback, per frame)
# =============================================================================


def detect_aubio_frame(frame):
    """aubio yinfft on one frame. Returns (f0, confidence)."""
    s = frame.astype(np.float32)
    f0 = float(_aubio_pitch(s)[0])
    conf = float(_aubio_pitch.get_confidence())
    if f0 <= 0 or not (F0_MIN <= f0 <= F0_MAX):
        return 0.0, 0.0
    return f0, conf


# =============================================================================
# CQT CHORD DETECTION  (polyphonic)
# =============================================================================


def detect_chords(frames):
    """
    CQT-based multi-pitch detection for real-time chord recognition.

    Algorithm:
    1. Compute CQT (88 bins, one per piano key, A0-C8)
    2. Average energy across time frames → per-note energy profile
    3. Find peaks with prominence filtering
    4. Remove octave duplicates (keep stronger octave)
    5. Return up to MAX_CHORD_NOTES notes sorted by energy

    CQT is better than FFT for chords because bins align exactly
    with equal-temperament semitones, avoiding inter-bin leakage.

    Returns
    -------
    list of { midi, note, conf, freq } sorted by conf desc
    """
    if not frames:
        return []

    audio = np.concatenate(frames).astype(np.float32)

    # Normalize
    peak = float(np.max(np.abs(audio))) + 1e-9
    audio = audio / peak

    try:
        # CQT: 88 bins starting at A0 (MIDI 21)
        C = np.abs(
            librosa.cqt(
                audio,
                sr=SAMPLE_RATE,
                hop_length=512,
                fmin=librosa.midi_to_hz(21),
                n_bins=88,
                bins_per_octave=12,
                filter_scale=1.0,
            )
        )
    except Exception as exc:
        log.debug("CQT error: %s", exc)
        return []

    if C.size == 0:
        return []

    # Mean energy per bin across time
    energy = np.mean(C, axis=1)

    if energy.max() == 0:
        return []

    # Normalise so peak = 1.0
    energy = energy / energy.max()

    # Find peaks
    peaks, props = find_peaks(
        energy,
        height=CHORD_ENERGY_THRESH,
        distance=CHORD_DISTANCE,
        prominence=CHORD_PROMINENCE,
    )

    if len(peaks) == 0:
        return []

    # Map CQT bin to MIDI (bin 0 = A0 = MIDI 21)
    results = []
    for p in peaks:
        midi = int(p) + 21
        if not (21 <= midi <= 108):
            continue
        freq = float(librosa.midi_to_hz(midi))
        note = librosa.midi_to_note(midi)
        results.append(
            {
                "midi": midi,
                "note": note,
                "conf": float(energy[p]),
                "freq": round(freq, 2),
            }
        )

    if not results:
        return []

    # Remove octave duplicates: if both C3 and C4 present, keep stronger
    if CHORD_OCTAVE_FILTER:
        filtered = []
        midis = [r["midi"] for r in results]
        for r in results:
            # Check if any octave version of this note has higher confidence
            is_weaker_octave = False
            for offset in [-24, -12, 12, 24]:
                oct_midi = r["midi"] + offset
                if oct_midi in midis:
                    other = next(x for x in results if x["midi"] == oct_midi)
                    # If the other octave is significantly stronger, skip this
                    if other["conf"] > r["conf"] * 1.4:
                        is_weaker_octave = True
                        break
            if not is_weaker_octave:
                filtered.append(r)
        results = filtered

    # Sort by confidence, take top N
    results.sort(key=lambda x: -x["conf"])
    return results[:MAX_CHORD_NOTES]


# =============================================================================
# MONOPHONIC ANALYSIS  (voice / instrument modes)
# =============================================================================


def analyse_buffer_mono(frames, mode):
    """
    CREPE first, then pYIN (voice) or aubio (instrument) fallback.
    Returns (f0, confidence, engine_name).
    """
    global _last_f0, _last_conf, _last_engine

    if not frames:
        return _last_f0, _last_conf, _last_engine

    audio = np.concatenate(frames).astype(np.float32)
    p = float(np.max(np.abs(audio))) + 1e-9
    audio_norm = audio / p

    best_f0, best_conf, best_engine = 0.0, 0.0, "none"

    if CREPE_AVAILABLE:
        cf, cc = detect_crepe(audio_norm)
        if cf > 0 and cc >= CREPE_CONF_THRESH:
            best_f0, best_conf, best_engine = cf, cc, "crepe"

    if best_conf < CREPE_CONF_THRESH:
        if mode == "voice":
            pf, pc = detect_pyin(audio_norm)
            if pf > 0 and pc > best_conf:
                best_f0, best_conf, best_engine = pf, pc, "pyin"
        else:
            af, ac = detect_aubio_frame(frames[-1])
            if af > 0 and ac > best_conf:
                best_f0, best_conf, best_engine = af, ac, "aubio"

    _last_f0, _last_conf, _last_engine = best_f0, best_conf, best_engine
    return best_f0, best_conf, best_engine


# =============================================================================
# RHYTHM
# =============================================================================


def detect_rhythm(frame):
    """Returns (bpm, is_beat, is_onset)."""
    s = frame.astype(np.float32)
    is_beat = bool(_tempo_o(s)[0])
    bpm = float(_tempo_o.get_bpm())
    if not (BPM_MIN <= bpm <= BPM_MAX):
        bpm = 0.0
    is_onset = bool(_onset_o(s)[0])
    return bpm, is_beat, is_onset


# =============================================================================
# SMOOTHING + MIDI
# =============================================================================


def smooth_f0(f0):
    """3-frame median filter."""
    global _f0_history
    if f0 > 0.0:
        _f0_history.append(f0)
    if len(_f0_history) > SMOOTHING_FRAMES:
        _f0_history = _f0_history[-SMOOTHING_FRAMES:]
    if not _f0_history:
        return 0.0
    return float(np.median(_f0_history))


def f0_to_midi(f0):
    """Equal-temperament + octave shift."""
    if f0 <= 0.0:
        return -1
    raw = 12.0 * np.log2(f0 / 440.0) + 69.0
    return int(np.clip(round(raw) + OCTAVE_SHIFT, 0, 127))


def _push(q, event):
    try:
        q.put_nowait(event)
    except queue.Full:
        try:
            q.get_nowait()
        except queue.Empty:
            pass
        q.put_nowait(event)


# =============================================================================
# AUDIO CALLBACK
# =============================================================================


def audio_callback(indata, frames, time_info, status):
    if status:
        log.warning("xrun: %s", status)
    if shutdown_event.is_set():
        raise sd.CallbackStop
    _push(audio_queue, indata[:, 0].copy())


# =============================================================================
# PROCESSING LOOP
# =============================================================================


def processing_loop():
    """Main thread -- onset-guided analysis, sends MIDI + WebSocket."""
    threading.current_thread().name = "Processing"
    log.info(
        "mode=%s  gate=%.3f  crepe=%s", _active_mode[0], _gate_rms, CREPE_AVAILABLE
    )

    global _audio_buf, _f0_history

    mode = _active_mode[0]
    is_chord_mode = mode == "chord"

    buf_target = {
        "voice": BUFFER_SEC_VOICE,
        "instrument": BUFFER_SEC_INSTRUMENT,
        "chord": BUFFER_SEC_CHORD,
    }.get(mode, BUFFER_SEC_INSTRUMENT)

    # Monophonic state
    prev_note = -1

    # Polyphonic state (chord mode)
    prev_chord: set = set()

    midiout = rtmidi.MidiOut()
    midiout.open_virtual_port(VIRTUAL_PORT_NAME)
    log.info("MIDI port '%s' open.", VIRTUAL_PORT_NAME)

    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="Analyse")

    # ---- Mono emit ----
    def emit_mono(f0, conf, engine, bpm, is_beat, is_onset):
        nonlocal midiout
        nonlocal prev_note

        min_conf = CREPE_CONF_THRESH if engine == "crepe" else AUBIO_CONF_THRESH
        if f0 <= 0.0 or conf < min_conf:
            return

        f0_s = smooth_f0(f0)
        if f0_s <= 0.0:
            return

        midi_note = f0_to_midi(f0_s)
        if midi_note < 0:
            return

        name = librosa.midi_to_note(midi_note)
        log.info(
            "[%s] %s MIDI %d  %.1f Hz  conf %.2f  BPM %.1f",
            engine,
            name,
            midi_note,
            f0_s,
            conf,
            bpm,
        )

        if midi_note != prev_note:
            if prev_note >= 0:
                midiout.send_message([NOTE_OFF, prev_note, 0])
            midiout.send_message([NOTE_ON, midi_note, DEFAULT_VELOCITY])
            prev_note = midi_note

        evt = {
            "midi_note": midi_note,
            "f0": f0_s,
            "conf": conf,
            "engine": engine,
            "bpm": bpm,
            "is_beat": is_beat,
            "is_onset": is_onset,
            "chord_notes": [],
            "timestamp": time.time(),
        }
        _push(layer2_queue, evt)
        _push(ws_queue, evt)

    # ---- Chord emit ----
    def emit_chord(chord_notes, bpm, is_beat, is_onset):
        nonlocal prev_chord, midiout

        new_set = set(n["midi"] for n in chord_notes)

        # Release notes no longer playing
        for m in prev_chord - new_set:
            midiout.send_message([NOTE_OFF, m, 0])

        # Trigger new notes
        for m in new_set - prev_chord:
            vel = DEFAULT_VELOCITY
            midiout.send_message([NOTE_ON, m, vel])

        prev_chord = new_set

        if chord_notes:
            names = " ".join(n["note"] for n in chord_notes[:4])
            log.info("[chord] %s  BPM %.1f  %s", names, bpm, "*" if is_beat else "")

        # Dominant note for single-note display
        top = chord_notes[0] if chord_notes else None
        evt = {
            "midi_note": top["midi"] if top else -1,
            "f0": top["freq"] if top else 0.0,
            "conf": top["conf"] if top else 0.0,
            "engine": "cqt",
            "bpm": bpm,
            "is_beat": is_beat,
            "is_onset": is_onset,
            "chord_notes": chord_notes,
            "timestamp": time.time(),
        }
        _push(layer2_queue, evt)
        _push(ws_queue, evt)

    try:
        while not shutdown_event.is_set():
            try:
                raw_frame = audio_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            calibrate_noise_gate(raw_frame)
            rhythm_future = executor.submit(detect_rhythm, raw_frame)

            if is_silent(raw_frame):
                # Release all held notes
                if is_chord_mode:
                    for m in prev_chord:
                        midiout.send_message([NOTE_OFF, m, 0])
                    prev_chord = set()
                else:
                    if prev_note >= 0:
                        midiout.send_message([NOTE_OFF, prev_note, 0])
                        prev_note = -1
                _audio_buf.clear()
                _f0_history.clear()
                bpm, is_beat, is_onset = rhythm_future.result()
                _push(
                    ws_queue,
                    {
                        "midi_note": -1,
                        "f0": 0.0,
                        "conf": 0.0,
                        "engine": "silence",
                        "bpm": bpm,
                        "is_beat": is_beat,
                        "is_onset": False,
                        "chord_notes": [],
                        "timestamp": time.time(),
                    },
                )
                continue

            is_onset = bool(_onset_o(raw_frame.astype(np.float32))[0])

            if is_onset:
                total = sum(len(b) for b in _audio_buf)
                if total >= int(MIN_BUFFER_SEC * SAMPLE_RATE):
                    buf_snap = list(_audio_buf)
                    bpm, is_beat, _ = rhythm_future.result()

                    if is_chord_mode:
                        f = executor.submit(detect_chords, buf_snap)
                        try:
                            chord_notes = f.result(timeout=0.08)
                            emit_chord(chord_notes, bpm, is_beat, True)
                        except Exception:
                            pass
                    else:
                        f = executor.submit(analyse_buffer_mono, buf_snap, mode)
                        try:
                            f0, conf, engine = f.result(timeout=0.05)
                            emit_mono(f0, conf, engine, bpm, is_beat, True)
                        except Exception:
                            pass

                _audio_buf.clear()
                _audio_buf.append(raw_frame.copy())

            else:
                _audio_buf.append(raw_frame.copy())
                total = sum(len(b) for b in _audio_buf)

                if total >= int(buf_target * SAMPLE_RATE):
                    buf_snap = list(_audio_buf)
                    bpm, is_beat, _ = rhythm_future.result()

                    if is_chord_mode:
                        f = executor.submit(detect_chords, buf_snap)
                        try:
                            chord_notes = f.result(timeout=0.15)
                            emit_chord(chord_notes, bpm, is_beat, False)
                        except Exception:
                            pass
                    else:
                        f = executor.submit(analyse_buffer_mono, buf_snap, mode)
                        try:
                            f0, conf, engine = f.result(timeout=0.15)
                            emit_mono(f0, conf, engine, bpm, is_beat, False)
                        except Exception:
                            pass

                    keep = int(0.04 * SAMPLE_RATE)
                    tail = np.concatenate(_audio_buf)[-keep:]
                    _audio_buf.clear()
                    _audio_buf.append(tail)

    finally:
        if is_chord_mode:
            for m in prev_chord:
                midiout.send_message([NOTE_OFF, m, 0])
        elif prev_note >= 0:
            midiout.send_message([NOTE_OFF, prev_note, 0])
        executor.shutdown(wait=False)
        del midiout
        log.info("Processing stopped.")


# =============================================================================
# WEBSOCKET
# =============================================================================


def run_ws_server(port=8765):
    """Push note/chord events to ws://0.0.0.0:<port>."""
    try:
        import asyncio as _a  # noqa: PLC0415
        import json as _j  # noqa: PLC0415
        import websockets  # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError("pip install websockets") from exc

    clients = set()

    async def handler(ws):
        clients.add(ws)
        log.info("WS client: %s", ws.remote_address)
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)

    async def broadcast():
        while not shutdown_event.is_set():
            try:
                evt = ws_queue.get_nowait()
            except queue.Empty:
                await _a.sleep(0.005)
                continue

            midi = evt.get("midi_note", -1)
            note_name = librosa.midi_to_note(midi) if midi >= 0 else None
            msg = _j.dumps(
                {
                    "midi": midi,
                    "note": note_name,
                    "freq": round(evt.get("f0", 0.0), 2),
                    "conf": round(evt.get("conf", 0.0), 2),
                    "bpm": round(evt.get("bpm", 0.0), 1),
                    "is_beat": evt.get("is_beat", False),
                    "engine": evt.get("engine", ""),
                    "mode": _active_mode[0],
                    "crepe": CREPE_AVAILABLE,
                    "chord_notes": evt.get("chord_notes", []),
                }
            )
            dead = set()
            for ws in set(clients):
                try:
                    await ws.send(msg)
                except Exception:
                    dead.add(ws)
            clients.difference_update(dead)

    async def srv():
        # Bind to 0.0.0.0 to avoid IPv6 port conflict issues
        async with websockets.serve(handler, "0.0.0.0", port):
            log.info("WS server ws://localhost:%d", port)
            await broadcast()

    _a.run(srv())


# =============================================================================
# MAIN
# =============================================================================


def start():
    proc = threading.Thread(target=processing_loop, name="Processing", daemon=True)
    proc.start()
    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="float32",
        blocksize=HOP_SIZE,
        callback=audio_callback,
        latency="low",
    )
    stream.start()
    return stream, proc


def main():
    parser = argparse.ArgumentParser(
        description="Voice2Piano Live -- real-time pitch / chord detection"
    )
    parser.add_argument(
        "--mode",
        choices=["voice", "instrument", "chord"],
        default="instrument",
        help=(
            "voice=CREPE+pYIN singing  "
            "instrument=CREPE+aubio melody  "
            "chord=CQT polyphonic"
        ),
    )
    parser.add_argument(
        "--ws", action="store_true", help="Run WebSocket server for frontend"
    )
    parser.add_argument("--ws-port", type=int, default=8765)
    args = parser.parse_args()

    _active_mode[0] = args.mode

    mode_up = args.mode.upper()
    crepe_str = (
        "YES (neural)" if CREPE_AVAILABLE else "NO  (pip install crepe tensorflow)"
    )

    if args.mode == "voice":
        algo = (
            f"CREPE tiny -> pYIN fallback  |  " f"window {BUFFER_SEC_VOICE*1000:.0f}ms"
        )
    elif args.mode == "instrument":
        algo = (
            f"CREPE tiny -> aubio fallback  |  "
            f"window {BUFFER_SEC_INSTRUMENT*1000:.0f}ms"
        )
    else:
        algo = (
            f"CQT 88-bin multi-peak  |  "
            f"window {BUFFER_SEC_CHORD*1000:.0f}ms  "
            f"max {MAX_CHORD_NOTES} notes"
        )

    print("=" * 62)
    print(f"Voice2Piano Live  --  {mode_up}")
    print(f"  CREPE: {crepe_str}")
    print(f"  Stack: {algo}")
    print(f"  Onset: aubio complex (thresh={ONSET_THRESHOLD})")
    print("  Noise gate: adaptive (auto-calibrates first 0.5s)")
    print(f"  Octave shift: {OCTAVE_SHIFT:+d}")
    if args.ws:
        print(f"  WebSocket: ws://localhost:{args.ws_port}")
    if not CREPE_AVAILABLE and args.mode != "chord":
        print("\n  TIP: pip install crepe tensorflow  (better accuracy)")
    print("\nPlay or sing. Enter to stop.")
    print("=" * 62)

    stream, proc = start()

    if args.ws:
        threading.Thread(
            target=run_ws_server, args=(args.ws_port,), name="WS", daemon=True
        ).start()

    def _monitor():
        while not shutdown_event.is_set():
            try:
                evt = layer2_queue.get(timeout=0.2)
                if evt["midi_note"] < 0:
                    continue
                chord = evt.get("chord_notes", [])
                if chord:
                    names = " + ".join(n["note"] for n in chord)
                    confs = " ".join(f"{n['conf']:.2f}" for n in chord)
                    print(
                        f"  [chord]  {names}"
                        f"  conf [{confs}]"
                        f"  BPM {evt['bpm']:5.1f}"
                        f"  {'*' if evt['is_beat'] else ' '}"
                    )
                else:
                    name = librosa.midi_to_note(evt["midi_note"])
                    print(
                        f"  [{evt['engine']:10s}]"
                        f"  {name:5s}"
                        f"  MIDI {evt['midi_note']:3d}"
                        f"  {evt['f0']:7.2f} Hz"
                        f"  conf {evt['conf']:.2f}"
                        f"  BPM {evt['bpm']:5.1f}"
                        f"  {'*' if evt['is_beat'] else ' '}"
                    )
            except queue.Empty:
                pass

    threading.Thread(target=_monitor, daemon=True).start()

    try:
        input()
    except KeyboardInterrupt:
        pass
    finally:
        shutdown_event.set()
        stream.stop()
        proc.join(timeout=2.0)
        print("Stopped.")


if __name__ == "__main__":
    main()
