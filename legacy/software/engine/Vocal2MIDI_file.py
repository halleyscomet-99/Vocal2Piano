"""
Voice2Piano -- Vocal2MIDI_file.py  v1.8
========================================
Converts audio files to MIDI with source classification and separation.

KEY FIXES in v1.8
-----------------
- FileNotFoundError: upload copied to INPUT_DIR before processing.
  Basic Pitch always reads from INPUT_DIR (never from tmp upload dir).
- SSE emit() uses keyword-only args everywhere (no positional args).
- Demucs uses sync subprocess.run (same as working converter.py).
- All exceptions caught and sent as SSE error events (no silent crashes).

SOURCE TYPES  (POST form field: source_type)
---------------------------------------------
  auto          pYIN + spectral analysis auto-detect
  voice         pYIN monophonic melody MIDI
  instrumental  Basic Pitch ONNX polyphonic MIDI
  mixed         Demucs --two-stems vocals -> Basic Pitch on no_vocals.wav

ENDPOINTS
---------
  GET  /                    health check
  POST /convert/stream      SSE stream
  GET  /files/{filename}    serve output files (MIDI, WAV stems)

SSE EVENTS
----------
  { type:'step', step:'...', status:'running'|'done'|'error'|'skipped',
    detail:'...' }
  { type:'done', source_type:'...', midi_file:'...',
    vocals_file?:'...', accom_file?:'...' }
  { type:'error', detail:'...' }
"""

import sys
import os
import json
import asyncio
import argparse
import shutil
import subprocess
import tempfile
import traceback
from pathlib import Path

import numpy as np
import librosa

# =============================================================================
# CONFIGURATION
# =============================================================================

PYIN_CONF_MIN = 0.45
VOICE_RATIO_THRESHOLD = 0.35
INSTR_RATIO_THRESHOLD = 0.15

_HERE = Path(__file__).parent
OUTPUT_DIR = (_HERE / ".." / "files" / "output").resolve()
INPUT_DIR = (_HERE / ".." / "files" / "input").resolve()

ACCEPTED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aiff"}


# =============================================================================
# AUTO CLASSIFICATION
# =============================================================================


async def classify_audio_source(audio, sr, emit):
    """
    Auto-classify audio as voice / instrumental / mixed.
    Uses pYIN voiced-frame ratio as primary signal.
    voiced_conf separates voice vs mixed only (not used as gate).
    """
    await emit(
        type="step",
        step="classify",
        status="running",
        detail="Analysing pYIN + spectral bandwidth...",
    )

    if sr != 22050:
        audio_22k = librosa.resample(
            audio, orig_sr=sr, target_sr=22050
        )
        sr_22k = 22050
    else:
        audio_22k, sr_22k = audio, sr

    loop = asyncio.get_running_loop()

    def _classify():
        f0_arr, voiced_flag, voiced_prob = librosa.pyin(
            audio_22k,
            fmin=80.0,
            fmax=1000.0,
            sr=sr_22k,
            hop_length=256,
            fill_na=None,
        )
        vr = (
            float(np.mean(voiced_flag))
            if voiced_flag is not None
            else 0.0
        )
        if voiced_prob is not None and voiced_flag is not None:
            mask = voiced_flag & ~np.isnan(voiced_prob)
            vp = voiced_prob[mask]
            mc = float(np.mean(vp)) if len(vp) > 0 else 0.0
        else:
            mc = 0.0
        sb = librosa.feature.spectral_bandwidth(
            y=audio_22k, sr=sr_22k
        )
        mb = float(np.mean(sb))
        return vr, mc, mb

    vr, mc, mb = await loop.run_in_executor(None, _classify)
    is_narrow = mb < 2500
    voice_present = vr > VOICE_RATIO_THRESHOLD
    no_voice = vr < INSTR_RATIO_THRESHOLD
    high_conf = mc > 0.45

    if no_voice:
        source = "instrumental"
    elif voice_present and is_narrow and high_conf:
        source = "voice"
    elif voice_present:
        source = "mixed"
    else:
        source = "instrumental"

    print(f"    vr={vr:.2f} conf={mc:.2f} bw={mb:.0f} -> {source}")

    await emit(
        type="step",
        step="classify",
        status="done",
        detail=(
            f"voice_ratio={vr:.0%}  conf={mc:.2f}  bw={mb:.0f} Hz"
        ),
        result=source,
        voice_ratio=round(vr, 3),
        voiced_conf=round(mc, 3),
        spectral_bw=round(mb, 0),
        is_narrow=is_narrow,
    )
    return source


# =============================================================================
# DEMUCS SEPARATION
# Uses sync subprocess.run in executor -- same as working converter.py
# =============================================================================


async def separate_sources_async(input_path, output_dir, stem, emit):
    """
    Run Demucs via subprocess.run in a thread executor.
    Mirrors converter.py: sync subprocess is reliable on macOS.

    Produces:
      output_dir/htdemucs/<stem>/vocals.wav
      output_dir/htdemucs/<stem>/no_vocals.wav

    Copies both to OUTPUT_DIR with stem-prefixed names for /files/.
    """
    if not shutil.which("demucs"):
        await emit(
            type="step",
            step="separate",
            status="running",
            detail="Demucs htdemucs: separating vocals / accompaniment...",
        )
        return None

    loop = asyncio.get_running_loop()

    def _run():
        return subprocess.run(
            [
                "demucs",
                "--two-stems",
                "vocals",
                str(input_path),
                "-o",
                str(output_dir),
            ],
            capture_output=True,
            timeout=600,
        )

    try:
        result = await loop.run_in_executor(None, _run)
    except FileNotFoundError:
        await emit(
            type="step",
            step="separate",
            status="skipped",
            detail="demucs not found — pip install demucs",
        )
        return None
    except subprocess.TimeoutExpired:
        await emit(
            type="step",
            step="separate",
            status="error",
            detail="Demucs timed out (>10 min)",
        )
        return None
    except Exception as exc:
        await emit(
            type="step",
            step="separate",
            status="error",
            detail=str(exc)[:200],
        )
        return None

    if result.returncode != 0:
        err = result.stderr.decode(errors="replace")
        print(f"  DEMUCS STDERR: {err[:300]}")
        await emit(
            type="step",
            step="separate",
            status="error",
            detail=f"Demucs rc={result.returncode}: {err[:120]}",
        )
        return None

    # Find output files -- search recursively in case version differs
    no_vocals = (
        Path(output_dir) / "htdemucs" / stem / "no_vocals.wav"
    )
    vocals = Path(output_dir) / "htdemucs" / stem / "vocals.wav"

    if not no_vocals.exists():
        found = list(Path(output_dir).rglob("no_vocals.wav"))
        if found:
            no_vocals = found[0]
            vocals = no_vocals.parent / "vocals.wav"
        else:
            await emit(
                type="step",
                step="separate",
                status="error",
                detail="no_vocals.wav not found in Demucs output",
            )
            return None

    # Copy stems to OUTPUT_DIR for serving via /files/
    vocals_out = OUTPUT_DIR / f"{stem}_vocals.wav"
    accom_out = OUTPUT_DIR / f"{stem}_accompaniment.wav"
    shutil.copy2(str(vocals), str(vocals_out))
    shutil.copy2(str(no_vocals), str(accom_out))

    print(f"  vocals        -> {vocals_out.name}")
    print(f"  accompaniment -> {accom_out.name}")

    await emit(
        type="step",
        step="separate",
        status="done",
        detail="vocals.wav + accompaniment.wav ready",
        vocals_file=vocals_out.name,
        accom_file=accom_out.name,
    )
    return {
        "vocals": str(vocals_out),
        "accompaniment": str(accom_out),
    }


# =============================================================================
# BASIC PITCH  (polyphonic, ONNX backend forced)
# =============================================================================


async def run_basic_pitch_async(input_path, output_path, emit):
    """
    Polyphonic MIDI transcription via Basic Pitch ONNX.
    Forces ONNX by passing nmp.onnx path directly (skips TF/TFLite).
    input_path must be a persistent path (not inside a tmp_dir).
    """
    try:
        import basic_pitch  # noqa: F401
    except ImportError:
        await emit(
            type="step",
            step="transcribe",
            status="running",
            detail=f"Basic Pitch [ONNX] -> {Path(input_path).name}",
        )
        raise RuntimeError("basic-pitch not installed")

    try:
        from basic_pitch.inference import (  # noqa: PLC0415
            predict_and_save,
        )
        import basic_pitch as _bp  # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError(
            "pip install 'basic-pitch[onnx]' onnxruntime"
        ) from exc

    bp_dir = Path(_bp.__file__).parent
    onnx_path = (
        bp_dir / "saved_models" / "icassp_2022" / "nmp.onnx"
    )
    if not onnx_path.exists():
        raise RuntimeError(f"ONNX model not found: {onnx_path}")

    _in = str(input_path)
    _out = str(output_path)
    _onnx = str(onnx_path)

    loop = asyncio.get_running_loop()
    tmp_out = tempfile.mkdtemp(prefix="bp_out_")

    def _run():
        predict_and_save(
            audio_path_list=[_in],
            output_directory=tmp_out,
            save_midi=True,
            sonify_midi=False,
            save_model_outputs=False,
            save_notes=False,
            model_or_model_path=_onnx,
        )
        midi_files = list(Path(tmp_out).rglob("*.mid"))
        if not midi_files:
            raise RuntimeError(
                "Basic Pitch produced no MIDI output."
            )
        shutil.copy2(str(midi_files[0]), _out)

    try:
        await loop.run_in_executor(None, _run)
    finally:
        shutil.rmtree(tmp_out, ignore_errors=True)

    await emit(
        type="step",
        step="transcribe",
        status="done",
        detail=f"Saved -> {Path(output_path).name}",
    )
    return 1


# =============================================================================
# pYIN  (monophonic voice melody)
# =============================================================================


async def run_pyin_async(input_path, output_path, emit):
    """
    Monophonic melody extraction via pYIN.
    For pure singing voice -- outputs one note at a time.
    Result feeds Layer 2 for piano accompaniment generation.
    """
    await emit(
        type="step",
        step="transcribe",
        status="running",
        detail=f"pYIN monophonic melody -> {Path(input_path).name}",
    )

    _in = str(input_path)
    _out = str(output_path)
    loop = asyncio.get_running_loop()

    def _run():
        from pretty_midi import (  # noqa: PLC0415
            PrettyMIDI,
            Instrument,
            Note,
        )

        audio, sr = librosa.load(_in, sr=44100, mono=True)
        hop = 256
        f0_arr, voiced_flag, voiced_prob = librosa.pyin(
            audio,
            fmin=60.0,
            fmax=2000.0,
            sr=sr,
            hop_length=hop,
            frame_length=4096,
            fill_na=None,
        )
        hop_sec = hop / sr
        midi_obj = PrettyMIDI()
        inst = Instrument(program=0, name="Voice Melody")
        prev = -1
        t0 = 0.0
        _f0 = f0_arr if f0_arr is not None else []
        _vf = voiced_flag if voiced_flag is not None else []
        _vp = voiced_prob if voiced_prob is not None else []
        for i, (f0, v, p) in enumerate(zip(_f0, _vf, _vp)):
            t = i * hop_sec
            ok = (
                f0 is not None
                and not np.isnan(f0)
                and v
                and p >= PYIN_CONF_MIN
            )
            mn = -1
            if ok:
                raw = 12 * np.log2(f0 / 440.0) + 69
                mn = int(np.clip(round(raw) - 12, 21, 108))
            if mn != prev:
                if prev >= 0 and t - t0 > 0.04:
                    inst.notes.append(
                        Note(
                            velocity=80,
                            pitch=prev,
                            start=t0,
                            end=t,
                        )
                    )
                prev = mn
                t0 = t
        if prev >= 0:
            end = len(_f0) * hop_sec
            if end - t0 > 0.04:
                inst.notes.append(
                    Note(
                        velocity=80,
                        pitch=prev,
                        start=t0,
                        end=end,
                    )
                )
        midi_obj.instruments.append(inst)
        midi_obj.write(_out)
        return len(inst.notes)

    n = await loop.run_in_executor(None, _run)
    await emit(
        type="step",
        step="transcribe",
        status="done",
        detail=f"{n} notes -> {Path(output_path).name}",
    )
    return n


# =============================================================================
# CORE PIPELINE
# =============================================================================


async def _convert_core(
    input_path, output_path, emit, source_type="auto"
):
    """
    Full conversion pipeline.

    IMPORTANT: copies the upload to INPUT_DIR first so that Basic Pitch
    always reads from a persistent path -- the tmp upload dir is cleaned
    up independently and must not be passed to Basic Pitch.
    """
    input_path = Path(input_path).resolve()

    if input_path.suffix.lower() not in ACCEPTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported format '{input_path.suffix}'. "
            f"Accepted: {', '.join(sorted(ACCEPTED_EXTENSIONS))}"
        )
    if not input_path.exists():
        raise FileNotFoundError(f"Not found: {input_path}")

    stem = input_path.stem
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    INPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Copy to persistent INPUT_DIR before any processing
    persistent = INPUT_DIR / input_path.name
    shutil.copy2(str(input_path), str(persistent))
    print(f"Input saved -> {persistent}")

    if output_path is None:
        output_path = OUTPUT_DIR / f"{stem}_output.mid"
    output_path = Path(output_path).resolve()

    print(f"Convert: {persistent.name}  source={source_type}")

    await emit(
        type="step", step="load", status="done",
        detail=persistent.name,
    )

    vocals_file = None
    accom_file = None

    if source_type == "auto":
        loop = asyncio.get_running_loop()

        def _load_audio():
            return librosa.load(str(persistent), sr=44100, mono=True)
        audio, sr = await loop.run_in_executor(None, _load_audio)
        source_type = await classify_audio_source(audio, sr, emit)
    else:
        await emit(
            type="step",
            step="classify",
            status="done",
            detail=f"User selected: {source_type}",
            result=source_type,
        )

    if source_type == "voice":
        await run_pyin_async(
            str(persistent), str(output_path), emit
        )

    elif source_type == "instrumental":
        await run_basic_pitch_async(
            str(persistent), str(output_path), emit
        )

    else:  # mixed
        stems = await separate_sources_async(
            str(persistent), str(OUTPUT_DIR), stem, emit
        )
        if stems and os.path.exists(stems["accompaniment"]):
            await run_basic_pitch_async(
                stems["accompaniment"], str(output_path), emit
            )
            vocals_file = Path(stems["vocals"]).name
            accom_file = Path(stems["accompaniment"]).name
        else:
            # Demucs failed -- fall back to full mix
            await emit(
                type="step",
                step="separate",
                status="skipped",
                detail="Separation failed -- using full mix",
            )
            await run_basic_pitch_async(
                str(persistent), str(output_path), emit
            )

    await emit(
        type="step",
        step="output",
        status="done",
        detail=f"{output_path.name} ready",
    )

    await emit(
        type="done",
        source_type=source_type,
        midi_file=output_path.name,
        vocals_file=vocals_file,
        accom_file=accom_file,
    )
    return {
        "midi_path": str(output_path),
        "source_type": source_type,
        "vocals_file": vocals_file,
        "accom_file": accom_file,
    }


# =============================================================================
# SYNC WRAPPER  (CLI use)
# =============================================================================


def convert_file_sync(
    input_path, output_path=None, source_type="auto"
):
    """Synchronous wrapper for command-line use."""

    async def _run():
        q = asyncio.Queue()

        async def emit(**kwargs):
            await q.put(kwargs)

        task = asyncio.create_task(
            _convert_core(input_path, output_path, emit, source_type)
        )
        while not task.done() or not q.empty():
            try:
                item = await asyncio.wait_for(q.get(), timeout=0.2)
                step = item.get("step", item.get("type", "?"))
                stat = item.get("status", item.get("type", "?"))
                print(
                    f"  [{step}][{stat}] {item.get('detail', '')}"
                )
            except asyncio.TimeoutError:
                pass
        return await task

    return asyncio.run(_run())


# =============================================================================
# HTTP SERVER
# =============================================================================


def run_server(port=8000):
    """
    FastAPI SSE server.
    POST /convert/stream  accepts: file (upload), source_type (form)
    GET  /files/{filename}  serves MIDI and WAV stems from OUTPUT_DIR
    """
    try:
        import uvicorn  # noqa: PLC0415
        from fastapi import (  # noqa: PLC0415
            FastAPI,
            File,
            Form,
            UploadFile,
            HTTPException,
        )
        from fastapi.middleware.cors import (  # noqa: PLC0415
            CORSMiddleware,
        )
        from fastapi.responses import (  # noqa: PLC0415
            StreamingResponse,
            FileResponse,
        )
        from typing import Optional  # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError(
            "pip install fastapi uvicorn python-multipart"
        ) from exc

    app = FastAPI(title="Voice2Piano", version="1.8.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @app.get("/")
    def health():
        return {"status": "ok", "version": "1.8.0"}

    @app.get("/files/{filename}")
    def serve_file(filename: str):
        """Serve output files (MIDI, WAV stems) by name."""
        path = OUTPUT_DIR / filename
        if not path.exists() or not path.is_file():
            raise HTTPException(
                status_code=404,
                detail=f"{filename} not found",
            )
        try:
            path.resolve().relative_to(OUTPUT_DIR)
        except ValueError:
            raise HTTPException(status_code=403, detail="Forbidden")
        media = (
            "audio/midi"
            if filename.endswith(".mid")
            else "audio/wav"
        )
        return FileResponse(
            str(path), media_type=media, filename=filename
        )

    @app.post("/convert/stream")
    async def convert_stream(
        file: UploadFile = File(...),
        source_type: Optional[str] = Form(default="auto"),
    ):
        """
        SSE conversion endpoint.

        Writes the upload to a tmp file, then _convert_core copies it
        to INPUT_DIR (persistent) immediately.  The tmp dir is cleaned
        after the SSE stream ends -- INPUT_DIR copy is never deleted.
        """
        ext = Path(file.filename or "").suffix.lower()
        if ext not in ACCEPTED_EXTENSIONS:
            raise HTTPException(
                status_code=415,
                detail=f"Unsupported '{ext}'",
            )
        valid = {"auto", "voice", "instrumental", "mixed"}
        if source_type not in valid:
            source_type = "auto"

        # Write upload bytes to tmp file
        tmp_dir = tempfile.mkdtemp(prefix="v2p_upload_")
        in_path = os.path.join(tmp_dir, f"upload{ext}")
        content = await file.read()
        with open(in_path, "wb") as fh:
            fh.write(content)

        async def event_stream():
            q = asyncio.Queue()

            async def emit(**kwargs):
                await q.put(kwargs)

            task = asyncio.create_task(
                _convert_core(in_path, None, emit, source_type)
            )

            try:
                while True:
                    try:
                        item = await asyncio.wait_for(
                            q.get(), timeout=0.15
                        )
                        yield f"data: {json.dumps(item)}\n\n"
                        if item.get("type") in ("done", "error"):
                            break
                    except asyncio.TimeoutError:
                        if task.done():
                            while not q.empty():
                                item = q.get_nowait()
                                yield (
                                    f"data: {json.dumps(item)}\n\n"
                                )
                            break
                        # Keep connection alive while processing
                        yield ": keepalive\n\n"

                if task.done() and not task.cancelled():
                    exc = task.exception()
                    if exc is not None:
                        traceback.print_exc()
                        yield (
                            "data: "
                            + json.dumps(
                                {
                                    "type": "error",
                                    "detail": str(exc),
                                }
                            )
                            + "\n\n"
                        )

            except Exception as exc:
                traceback.print_exc()
                yield (
                    "data: "
                    + json.dumps(
                        {"type": "error", "detail": str(exc)}
                    )
                    + "\n\n"
                )
            finally:
                # Only delete the tmp upload dir.
                # INPUT_DIR copy is persistent -- never cleaned here.
                shutil.rmtree(tmp_dir, ignore_errors=True)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Access-Control-Allow-Origin": "*",
            },
        )

    print(f"Voice2Piano File Server  ->  http://localhost:{port}")
    print("POST /convert/stream  (fields: file, source_type)")
    print("GET  /files/<name>")
    print("Ctrl+C to stop.\n")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


# =============================================================================
# OPTIONAL PLAYBACK
# =============================================================================


def play_midi(midi_path):
    """Play a MIDI file via pygame (optional)."""
    try:
        import pygame  # noqa: PLC0415

        pygame.init()
        pygame.mixer.init()
        pygame.mixer.music.load(midi_path)
        pygame.mixer.music.play()
        print("Playing... Ctrl+C to stop.")
        while pygame.mixer.music.get_busy():
            pygame.time.Clock().tick(10)
    except ImportError:
        print("pip install pygame")
    except KeyboardInterrupt:
        print("\nStopped.")


# =============================================================================
# ENTRY POINT
# =============================================================================


def main():
    """Parse CLI arguments and dispatch."""
    parser = argparse.ArgumentParser(
        description="Voice2Piano -- audio to MIDI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
source_type: auto | voice | instrumental | mixed

Examples:
  python Vocal2MIDI_file.py song.mp3
  python Vocal2MIDI_file.py song.mp3 --source instrumental
  python Vocal2MIDI_file.py --server
        """,
    )
    parser.add_argument("input", nargs="?")
    parser.add_argument("--output", "-o", default=None)
    parser.add_argument(
        "--source",
        default="auto",
        choices=["auto", "voice", "instrumental", "mixed"],
    )
    parser.add_argument("--play", "-p", action="store_true")
    parser.add_argument("--server", "-s", action="store_true")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if args.server:
        run_server(port=args.port)
        return

    if not args.input:
        parser.print_help()
        sys.exit(1)

    result = convert_file_sync(
        args.input, args.output, args.source
    )
    if args.play:
        play_midi(result["midi_path"])


if __name__ == "__main__":
    main()
