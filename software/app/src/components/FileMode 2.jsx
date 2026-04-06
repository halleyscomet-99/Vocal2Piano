/**
 * FileMode.jsx
 * ------------
 * Audio file → MIDI conversion mode.
 *
 * Flow:
 *   1. User drops or selects an audio file (mp3, wav, flac, m4a, ogg)
 *   2. File is sent to the backend (/convert) using Basic Pitch
 *   3. Returned MIDI file is parsed and displayed as a note list
 *   4. User can play back the MIDI with piano animation
 *   5. User can download the MIDI file
 *
 * BACKEND URL: set VITE_BACKEND_URL in a .env file (or Vercel env var).
 * If no backend is configured, the component shows a friendly message.
 *
 * Example .env:
 *   VITE_BACKEND_URL=https://your-app.onrender.com
 */

import React, { useState, useRef, useCallback } from 'react'
import { Piano88 } from './Piano88'
import { parseMidiNotes, downloadMidi, playMidiNotes } from '../utils/midiUtils'

const BACKEND = import.meta.env.VITE_BACKEND_URL || ''
const ACCEPTED = '.mp3,.wav,.flac,.m4a,.ogg,.aiff'
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

function noteInfo(midi) {
  const octave = Math.floor(midi / 12) - 1
  const note = NOTE_NAMES[midi % 12]
  return { midi, name: `${note}${octave}`, note, octave }
}

export function FileMode() {
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState(null)
  const [status, setStatus] = useState('idle') // idle | uploading | done | error
  const [errorMsg, setErrorMsg] = useState('')
  const [midiNotes, setMidiNotes] = useState([])
  const [midiBlob, setMidiBlob] = useState(null)

  // Playback
  const [isPlaying, setIsPlaying] = useState(false)
  const [playingNote, setPlayingNote] = useState(null)
  const cancelRef = useRef(null)

  const inputRef = useRef(null)

  // ---- File handling ----

  const processFile = useCallback(async (file) => {
    if (!BACKEND) {
      setStatus('error')
      setErrorMsg(
        'No backend configured. ' +
        'Set VITE_BACKEND_URL to your deployed FastAPI URL. ' +
        'See README for deployment instructions.'
      )
      return
    }

    setFileName(file.name)
    setStatus('uploading')
    setMidiNotes([])
    setMidiBlob(null)
    setPlayingNote(null)

    try {
      const form = new FormData()
      form.append('file', file)

      const res = await fetch(`${BACKEND}/convert`, {
        method: 'POST',
        body: form,
      })

      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || `Server error ${res.status}`)
      }

      // Backend returns a MIDI file
      const blob = await res.blob()
      setMidiBlob(blob)

      const notes = await parseMidiNotes(blob)
      setMidiNotes(notes)
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setErrorMsg(err.message)
    }
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }, [processFile])

  const handleInputChange = useCallback((e) => {
    const file = e.target.files[0]
    if (file) processFile(file)
  }, [processFile])

  // ---- Playback ----

  const handlePlay = useCallback(async () => {
    if (isPlaying) {
      if (cancelRef.current) cancelRef.current()
      setIsPlaying(false)
      setPlayingNote(null)
      return
    }
    setIsPlaying(true)
    cancelRef.current = await playMidiNotes(
      midiNotes,
      (midi) => setPlayingNote(midi),
      () => { setIsPlaying(false); setPlayingNote(null) }
    )
  }, [isPlaying, midiNotes])

  const handleDownload = useCallback(() => {
    if (midiBlob) downloadMidi(midiBlob, `${fileName?.replace(/\.[^.]+$/, '') ?? 'output'}.mid`)
  }, [midiBlob, fileName])

  // ---- Note summary list ----
  const uniqueNotes = [...new Set(midiNotes.map(n => n.midi))].sort((a, b) => a - b)
  const duration = midiNotes.length
    ? (midiNotes[midiNotes.length - 1].time + midiNotes[midiNotes.length - 1].duration).toFixed(1)
    : 0

  return (
    <div className="mode-panel">

      {/* Drop zone */}
      <div
        className={`drop-zone ${dragging ? 'drag-over' : ''} ${status === 'done' ? 'done' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          style={{ display: 'none' }}
          onChange={handleInputChange}
        />
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
            <div className="drop-primary">Converting with Basic Pitch…</div>
            <div className="drop-secondary">{fileName}</div>
          </>
        )}
        {status === 'done' && (
          <>
            <div className="drop-icon">✓</div>
            <div className="drop-primary">{fileName}</div>
            <div className="drop-secondary">
              {midiNotes.length} notes · {duration}s · click to replace
            </div>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="drop-icon error">!</div>
            <div className="drop-primary">Error</div>
            <div className="drop-secondary error-text">{errorMsg}</div>
          </>
        )}
      </div>

      {/* Results */}
      {status === 'done' && midiNotes.length > 0 && (
        <>
          {/* Piano */}
          <div className="piano-section">
            <Piano88
              activeNote={playingNote}
              playedNotes={uniqueNotes}
            />
          </div>

          {/* Note summary */}
          <div className="file-note-summary">
            {uniqueNotes.map(midi => {
              const { name } = noteInfo(midi)
              const count = midiNotes.filter(n => n.midi === midi).length
              return (
                <div
                  key={midi}
                  className={`summary-chip ${playingNote === midi ? 'active' : ''}`}
                >
                  <span className="chip-name">{name}</span>
                  <span className="chip-count">×{count}</span>
                </div>
              )
            })}
          </div>

          {/* Controls */}
          <div className="controls-row">
            <button
              className={`btn ${isPlaying ? 'btn-stop' : 'btn-play'}`}
              onClick={handlePlay}
            >
              {isPlaying ? '■ Stop' : '▶ Play MIDI'}
            </button>
            <button className="btn btn-outline" onClick={handleDownload}>
              ↓ Download .mid
            </button>
          </div>
        </>
      )}

      {!BACKEND && status === 'idle' && (
        <div className="backend-notice">
          <strong>Backend not configured.</strong>
          <br />
          Deploy the FastAPI backend to Render and set{' '}
          <code>VITE_BACKEND_URL</code> in Vercel environment variables.
          See <code>backend/README.md</code>.
        </div>
      )}
    </div>
  )
}
