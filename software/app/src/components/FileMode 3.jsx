/**
 * FileMode.jsx
 * ------------
 * Audio file → MIDI with the same dual-track comparison as LiveMode.
 *
 * Track A = uploaded audio file, played via HTMLAudioElement
 * Track B = converted MIDI, played via Tone.js
 * Both have Waveform display and independent play buttons.
 *
 * BACKEND: python software/engine/Vocal2MIDI_file.py --server
 * .env:    VITE_BACKEND_URL=http://localhost:8000
 */

import React, { useState, useRef, useCallback } from 'react'
import { Piano88 } from './Piano88'
import { Waveform } from './Waveform'
import { parseMidiNotes, downloadMidi, playMidiNotes } from '../utils/midiUtils'

const BACKEND = import.meta.env.VITE_BACKEND_URL || ''
const ACCEPTED = '.mp3,.wav,.flac,.m4a,.ogg,.aiff'
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteLabel(midi) {
  if (midi == null) return null
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

const SOURCE_META = {
  voice:        { color: '#3B6CF4', desc: 'Pure vocal → pYIN melody → Layer 2' },
  instrumental: { color: '#F59E0B', desc: 'Instrumental → Basic Pitch piano MIDI' },
  mixed:        { color: '#8B5CF6', desc: 'Mixed → Demucs separation → piano MIDI' },
}

export function FileMode() {
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState(null)
  const [stem, setStem] = useState(null)
  const [status, setStatus] = useState('idle')  // idle|uploading|done|error
  const [errorMsg, setErrorMsg] = useState('')
  const [sourceType, setSourceType] = useState(null)
  const [midiNotes, setMidiNotes] = useState([])
  const [midiBlob, setMidiBlob] = useState(null)
  const [uploadedFile, setUploadedFile] = useState(null)  // original File object

  // Track A (original audio)
  const audioElemRef = useRef(null)
  const [audioTime, setAudioTime] = useState(0)
  const [audioDur, setAudioDur] = useState(0)
  const [audioBlob, setAudioBlob] = useState(null)
  const [playingA, setPlayingA] = useState(false)
  const audioRafRef = useRef(null)

  // Track B (MIDI)
  const [playingB, setPlayingB] = useState(false)
  const [midiNote, setMidiNote] = useState(null)
  const cancelMidiRef = useRef(null)

  const [comparing, setComparing] = useState(false)

  const inputRef = useRef(null)

  const uniqueNotes = [...new Set(midiNotes.map(n => n.midi))].sort((a, b) => a - b)

  // ---- File processing ----
  const processFile = useCallback(async (file) => {
    if (!BACKEND) {
      setStatus('error')
      setErrorMsg(
        'Backend not running.\n\nStart it with:\npython software/engine/Vocal2MIDI_file.py --server\n\nAlso make sure software/app/.env contains:\nVITE_BACKEND_URL=http://localhost:8000'
      )
      return
    }

    setFileName(file.name)
    setStem(file.name.replace(/\.[^.]+$/, ''))
    setStatus('uploading')
    setMidiNotes([])
    setMidiBlob(null)
    setMidiNote(null)
    setAudioTime(0)
    setUploadedFile(file)

    // Set up audio element for the original file
    const fileUrl = URL.createObjectURL(file)
    setAudioBlob(file)  // store as blob for Waveform decoder
    if (audioElemRef.current) {
      audioElemRef.current.src = fileUrl
      audioElemRef.current.onloadedmetadata = () => {
        setAudioDur(audioElemRef.current.duration)
      }
    }

    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${BACKEND}/convert`, { method: 'POST', body: form })

      if (!res.ok) {
        throw new Error(`Server error ${res.status}: ${await res.text()}`)
      }

      const detected = res.headers.get('X-Source-Type') || 'instrumental'
      setSourceType(detected)

      const blob = await res.blob()
      setMidiBlob(blob)
      const notes = await parseMidiNotes(blob)
      setMidiNotes(notes)
      setStatus('done')

      // Auto-download
      downloadMidi(blob, `${file.name.replace(/\.[^.]+$/, '')}_output.mid`)
    } catch (err) {
      setStatus('error')
      setErrorMsg(err.message)
    }
  }, [])

  const handleDrop = useCallback(e => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]; if (f) processFile(f)
  }, [processFile])

  const handleInput = useCallback(e => {
    const f = e.target.files[0]; if (f) processFile(f)
  }, [processFile])

  // ---- Track A ----
  const stopA = useCallback(() => {
    if (audioElemRef.current) {
      audioElemRef.current.pause()
      audioElemRef.current.currentTime = 0
    }
    if (audioRafRef.current) cancelAnimationFrame(audioRafRef.current)
    setPlayingA(false); setAudioTime(0)
  }, [])

  const startA = useCallback(() => {
    if (!audioElemRef.current) return
    audioElemRef.current.currentTime = 0
    audioElemRef.current.play()
    setPlayingA(true)
    const tick = () => {
      if (!audioElemRef.current) return
      setAudioTime(audioElemRef.current.currentTime)
      if (!audioElemRef.current.paused) {
        audioRafRef.current = requestAnimationFrame(tick)
      } else { setPlayingA(false); setAudioTime(0) }
    }
    audioRafRef.current = requestAnimationFrame(tick)
  }, [])

  // ---- Track B ----
  const stopB = useCallback(() => {
    if (cancelMidiRef.current) cancelMidiRef.current()
    setPlayingB(false); setMidiNote(null)
  }, [])

  const startB = useCallback(async () => {
    if (!midiNotes.length) return
    setPlayingB(true)
    cancelMidiRef.current = await playMidiNotes(
      midiNotes,
      midi => setMidiNote(midi),
      () => { setPlayingB(false); setMidiNote(null) }
    )
  }, [midiNotes])

  const stopAll = useCallback(() => {
    stopA(); stopB(); setComparing(false)
  }, [stopA, stopB])

  const handlePlayA = useCallback(() => {
    if (playingA) { stopA(); return }
    stopAll(); startA()
  }, [playingA, stopA, stopAll, startA])

  const handlePlayB = useCallback(() => {
    if (playingB) { stopB(); return }
    stopAll(); startB()
  }, [playingB, stopB, stopAll, startB])

  const handleCompare = useCallback(async () => {
    if (comparing) { stopAll(); return }
    stopAll(); setComparing(true)
    startA(); await startB()
  }, [comparing, stopAll, startA, startB])

  const dur = midiNotes.length
    ? (midiNotes[midiNotes.length - 1].time +
       midiNotes[midiNotes.length - 1].duration).toFixed(1)
    : '0'

  return (
    <div className="mode-panel">

      {/* Drop zone */}
      <div
        className={`drop-zone ${dragging ? 'drag-over' : ''} ${status === 'done' ? 'done' : ''} ${status === 'error' ? 'errored' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept={ACCEPTED}
          style={{ display: 'none' }} onChange={handleInput} />

        {status === 'idle' && (
          <>
            <div className="drop-icon">♩</div>
            <div className="drop-primary">Drop audio file here</div>
            <div className="drop-secondary">MP3 · WAV · FLAC · M4A · OGG</div>
          </>
        )}
        {status === 'uploading' && (
          <>
            <div className="drop-icon spin">⟳</div>
            <div className="drop-primary">Converting…</div>
            <div className="drop-secondary">{fileName}</div>
          </>
        )}
        {status === 'done' && (
          <>
            <div className="drop-icon ok">✓</div>
            <div className="drop-primary">{fileName}</div>
            <div className="drop-secondary">
              {midiNotes.length} notes · {dur}s · click to replace
            </div>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="drop-icon err">!</div>
            <div className="drop-primary">Error</div>
            <div className="drop-secondary" style={{ whiteSpace: 'pre-line' }}>
              {errorMsg}
            </div>
          </>
        )}
      </div>

      {/* Source type badge */}
      {sourceType && SOURCE_META[sourceType] && (
        <div className="source-badge"
          style={{ '--badge-color': SOURCE_META[sourceType].color }}>
          <div className="badge-dot" />
          <span className="badge-label">{sourceType}</span>
          <span className="badge-desc">{SOURCE_META[sourceType].desc}</span>
        </div>
      )}

      {/* Comparison card */}
      {status === 'done' && midiNotes.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Compare · Original vs MIDI Output</span>
          </div>

          <div className="compare-section">
            {/* Track A: original audio */}
            <div className="track-block">
              <div className="track-header">
                <div className="track-color-bar" style={{ background: '#3B6CF4' }} />
                <span className="track-name">Track A — {fileName}</span>
                <span className="track-meta">
                  {audioDur > 0 ? `${audioDur.toFixed(1)}s` : ''}
                </span>
                <button
                  className="track-play-btn"
                  style={{ background: '#3B6CF4' }}
                  onClick={handlePlayA}
                >
                  {playingA ? '■' : '▶'}
                </button>
              </div>
              <div className="track-wave">
                <Waveform
                  audioBlob={uploadedFile}
                  currentTime={audioTime}
                  duration={audioDur}
                  color="#3B6CF4"
                  label="AUDIO"
                />
              </div>
            </div>

            {/* Track B: MIDI */}
            <div className="track-block">
              <div className="track-header">
                <div className="track-color-bar" style={{ background: '#22C55E' }} />
                <span className="track-name">
                  Track B — {stem}_output.mid
                </span>
                <span className="track-meta">{midiNotes.length} notes</span>
                <button
                  className="track-play-btn"
                  style={{ background: '#22C55E' }}
                  onClick={handlePlayB}
                  disabled={!midiNotes.length}
                >
                  {playingB ? '■' : '▶'}
                </button>
              </div>
              <div className="track-wave">
                <Waveform
                  isActive={playingB}
                  color="#22C55E"
                  label="MIDI"
                />
              </div>
              {/* Piano shows current MIDI note during playback */}
              <Piano88 activeNote={midiNote} />

              {/* Note chips */}
              <div className="note-chips">
                {uniqueNotes.map(midi => {
                  const count = midiNotes.filter(n => n.midi === midi).length
                  return (
                    <div key={midi}
                      className={`note-chip ${midiNote === midi ? 'lit' : ''}`}>
                      <span className="chip-name">{noteLabel(midi)}</span>
                      <span className="chip-count">×{count}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Compare + download */}
            <div className="compare-btn-row">
              <button
                className="compare-toggle"
                onClick={handleCompare}
                disabled={!midiNotes.length}
              >
                ⇄ {comparing ? 'Stop' : 'Play Both Together'}
              </button>
              <button
                className="btn btn-outline"
                style={{ marginLeft: 8 }}
                onClick={() => downloadMidi(midiBlob, `${stem}_output.mid`)}
              >
                ↓ Download MIDI
              </button>
            </div>
          </div>
        </div>
      )}

      <audio ref={audioElemRef} style={{ display: 'none' }} />
    </div>
  )
}
