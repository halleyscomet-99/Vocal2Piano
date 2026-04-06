/**
 * LiveMode.jsx
 * ------------
 * Real-time microphone recording mode.
 *
 * Flow:
 *   1. User clicks "Start Recording"
 *   2. Mic opens, pitch detector runs every animation frame
 *   3. Active piano key highlights in real time
 *   4. Note history builds up in the scrolling history strip
 *   5. User clicks "Stop Recording"
 *   6. Detected notes are converted to a MIDI file
 *   7. User can play back the MIDI (with piano animation) or download it
 */

import React, { useState, useRef, useCallback } from 'react'
import { Piano88 } from './Piano88'
import { usePitchDetect } from '../hooks/usePitchDetect'
import { notesToMidiBlob, downloadMidi, playMidiNotes } from '../utils/midiUtils'

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

export function LiveMode() {
  const { currentNote, isListening, noteHistory, start, stop } = usePitchDetect()

  // Recorded session state
  const [recordedNotes, setRecordedNotes] = useState([])
  const [midiBlob, setMidiBlob] = useState(null)

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false)
  const [playingNote, setPlayingNote] = useState(null)
  const cancelPlayRef = useRef(null)

  // Recently played notes for piano "heat map"
  const recentPlayed = noteHistory.slice(-20).map(n => n.midi)

  // ---- Recording controls ----

  const handleStart = useCallback(async () => {
    setRecordedNotes([])
    setMidiBlob(null)
    setPlayingNote(null)
    await start()
  }, [start])

  const handleStop = useCallback(() => {
    const notes = stop()
    setRecordedNotes(notes)
    if (notes.length > 0) {
      const blob = notesToMidiBlob(notes, 120)
      setMidiBlob(blob)
    }
  }, [stop])

  // ---- Playback controls ----

  const handlePlay = useCallback(async () => {
    if (isPlaying) {
      if (cancelPlayRef.current) cancelPlayRef.current()
      setIsPlaying(false)
      setPlayingNote(null)
      return
    }

    setIsPlaying(true)
    cancelPlayRef.current = await playMidiNotes(
      recordedNotes,
      (midi) => setPlayingNote(midi),
      () => {
        setIsPlaying(false)
        setPlayingNote(null)
      }
    )
  }, [isPlaying, recordedNotes])

  const handleDownload = useCallback(() => {
    if (midiBlob) downloadMidi(midiBlob, 'voice2piano-live.mid')
  }, [midiBlob])

  // Active piano key: live note while recording, playback note while playing
  const activeNote = isPlaying ? playingNote : (currentNote?.midi ?? null)

  // Note info display
  const displayNote = isPlaying
    ? (playingNote ? noteInfo(playingNote) : null)
    : currentNote

  return (
    <div className="mode-panel">

      {/* Status bar */}
      <div className="status-bar">
        <div className={`status-dot ${isListening ? 'active' : ''}`} />
        <span className="status-text">
          {isListening ? 'RECORDING' : isPlaying ? 'PLAYING BACK' : 'READY'}
        </span>
        {currentNote && isListening && (
          <span className="status-freq">{currentNote.freq.toFixed(1)} Hz</span>
        )}
      </div>

      {/* Main note display */}
      <div className="note-display">
        {displayNote ? (
          <>
            <span className="note-big">{displayNote.name || displayNote.noteName}</span>
            <span className="note-midi">MIDI {displayNote.midi}</span>
            <span className="note-detail">
              {NOTE_NAMES[displayNote.midi % 12]} &nbsp;·&nbsp;
              Oct {Math.floor(displayNote.midi / 12) - 1}
            </span>
          </>
        ) : (
          <span className="note-empty">
            {isListening ? 'Listening...' : 'No input'}
          </span>
        )}
      </div>

      {/* 88-key piano */}
      <div className="piano-section">
        <Piano88 activeNote={activeNote} playedNotes={recentPlayed} />
      </div>

      {/* Note history strip */}
      {noteHistory.length > 0 && (
        <div className="history-strip">
          {noteHistory.map((n) => (
            <div key={n.id} className="history-chip">
              <span className="chip-name">{n.name}</span>
              <span className="chip-midi">{n.midi}</span>
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="controls-row">
        {!isListening && !isPlaying && (
          <button className="btn btn-record" onClick={handleStart}>
            <span className="btn-dot" />
            Start Recording
          </button>
        )}

        {isListening && (
          <button className="btn btn-stop" onClick={handleStop}>
            <span className="btn-square" />
            Stop Recording
          </button>
        )}

        {midiBlob && !isListening && (
          <>
            <button
              className={`btn ${isPlaying ? 'btn-stop' : 'btn-play'}`}
              onClick={handlePlay}
            >
              {isPlaying ? '■ Stop' : '▶ Play MIDI'}
            </button>
            <button className="btn btn-outline" onClick={handleDownload}>
              ↓ Download .mid
            </button>
          </>
        )}
      </div>

      {/* Recorded note count */}
      {recordedNotes.length > 0 && !isListening && (
        <div className="record-info">
          {recordedNotes.length} notes recorded &nbsp;·&nbsp;
          {(recordedNotes[recordedNotes.length - 1].time +
            recordedNotes[recordedNotes.length - 1].duration).toFixed(1)}s
        </div>
      )}
    </div>
  )
}

/** Helper: build note info from MIDI number */
function noteInfo(midi) {
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
  const octave = Math.floor(midi / 12) - 1
  const note = NOTE_NAMES[midi % 12]
  return { midi, name: `${note}${octave}`, note, octave }
}
