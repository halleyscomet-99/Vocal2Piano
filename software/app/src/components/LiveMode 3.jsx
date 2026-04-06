/**
 * LiveMode.jsx
 * ------------
 * Real-time microphone recording with dual waveform comparison.
 *
 * Track A = original audio recording (MediaRecorder Blob)
 *           → played back via HTMLAudioElement
 *           → waveform decoded from Blob
 *
 * Track B = MIDI output (synthesized via Tone.js)
 *           → animated waveform driven by note events
 *
 * Both tracks have independent play buttons and a Compare button
 * that plays them simultaneously.
 */

import React, { useState, useRef, useCallback } from 'react'
import { Piano88 } from './Piano88'
import { Waveform } from './Waveform'
import { usePitchDetect } from '../hooks/usePitchDetect'
import { notesToMidiBlob, downloadMidi, playMidiNotes } from '../utils/midiUtils'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteLabel(midi) {
  if (midi == null) return null
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

export function LiveMode() {
  const { currentNote, isListening, noteHistory, analyserNode, start, stop } =
    usePitchDetect()

  // Session state
  const [recordedNotes, setRecordedNotes] = useState([])
  const [audioBlob, setAudioBlob] = useState(null)
  const [midiBlob, setMidiBlob] = useState(null)
  const [sessionName] = useState(
    () => `live_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}`
  )

  // Track A playback (audio)
  const audioElemRef = useRef(null)
  const [audioTime, setAudioTime] = useState(0)
  const [audioDur, setAudioDur] = useState(0)
  const [playingA, setPlayingA] = useState(false)
  const audioRafRef = useRef(null)

  // Track B playback (MIDI)
  const [playingB, setPlayingB] = useState(false)
  const [midiNote, setMidiNote] = useState(null)
  const cancelMidiRef = useRef(null)

  // Compare state
  const [comparing, setComparing] = useState(false)

  // Piano active note
  const activeNote = isListening
    ? (currentNote?.midi ?? null)
    : (midiNote ?? null)

  const recentPlayed = noteHistory.slice(-30).map(n => n.midi)

  // ---- Recording ----

  const handleStart = useCallback(async () => {
    setRecordedNotes([])
    setAudioBlob(null)
    setMidiBlob(null)
    setMidiNote(null)
    setAudioTime(0)
    await start()
  }, [start])

  const handleStop = useCallback(async () => {
    const { notes, audioBlob: blob } = await stop()
    setRecordedNotes(notes)
    setAudioBlob(blob)

    if (blob) {
      const url = URL.createObjectURL(blob)
      if (audioElemRef.current) {
        audioElemRef.current.src = url
        audioElemRef.current.onloadedmetadata = () => {
          setAudioDur(audioElemRef.current.duration)
        }
      }
    }

    if (notes.length > 0) {
      const midi = notesToMidiBlob(notes, 120)
      setMidiBlob(midi)
      downloadMidi(midi, `${sessionName}_output.mid`)
    }
  }, [stop, sessionName])

  // ---- Track A: original audio ----

  const stopTrackA = useCallback(() => {
    if (audioElemRef.current) {
      audioElemRef.current.pause()
      audioElemRef.current.currentTime = 0
    }
    if (audioRafRef.current) cancelAnimationFrame(audioRafRef.current)
    setPlayingA(false)
    setAudioTime(0)
  }, [])

  const playTrackA = useCallback(() => {
    if (playingA) { stopTrackA(); return }
    if (!audioElemRef.current || !audioBlob) return

    audioElemRef.current.currentTime = 0
    audioElemRef.current.play()
    setPlayingA(true)

    const tick = () => {
      if (!audioElemRef.current) return
      setAudioTime(audioElemRef.current.currentTime)
      if (!audioElemRef.current.paused) {
        audioRafRef.current = requestAnimationFrame(tick)
      } else {
        setPlayingA(false)
        setAudioTime(0)
      }
    }
    audioRafRef.current = requestAnimationFrame(tick)
  }, [playingA, audioBlob, stopTrackA])

  // ---- Track B: MIDI ----

  const stopTrackB = useCallback(() => {
    if (cancelMidiRef.current) cancelMidiRef.current()
    setPlayingB(false)
    setMidiNote(null)
  }, [])

  const playTrackB = useCallback(async () => {
    if (playingB) { stopTrackB(); return }
    if (!recordedNotes.length) return
    setPlayingB(true)
    cancelMidiRef.current = await playMidiNotes(
      recordedNotes,
      midi => setMidiNote(midi),
      () => { setPlayingB(false); setMidiNote(null) }
    )
  }, [playingB, recordedNotes, stopTrackB])

  // ---- Compare ----

  const stopCompare = useCallback(() => {
    stopTrackA()
    stopTrackB()
    setComparing(false)
  }, [stopTrackA, stopTrackB])

  const handleCompare = useCallback(async () => {
    if (comparing) { stopCompare(); return }
    stopTrackA(); stopTrackB()
    setComparing(true)

    // Start both simultaneously
    if (audioElemRef.current && audioBlob) {
      audioElemRef.current.currentTime = 0
      audioElemRef.current.play()
      setPlayingA(true)
      const tick = () => {
        if (!audioElemRef.current) return
        setAudioTime(audioElemRef.current.currentTime)
        if (!audioElemRef.current.paused) {
          audioRafRef.current = requestAnimationFrame(tick)
        } else {
          setPlayingA(false)
          setAudioTime(0)
        }
      }
      audioRafRef.current = requestAnimationFrame(tick)
    }

    cancelMidiRef.current = await playMidiNotes(
      recordedNotes,
      midi => setMidiNote(midi),
      () => {
        setPlayingB(false)
        setMidiNote(null)
        setComparing(false)
      }
    )
    setPlayingB(true)
  }, [comparing, audioBlob, recordedNotes, stopTrackA, stopTrackB, stopCompare])

  const hasRecording = recordedNotes.length > 0

  return (
    <div className="mode-panel">

      {/* Recording card */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Input · Microphone</span>
          <span className={`card-badge ${isListening ? 'live' : 'idle'}`}>
            {isListening ? '● LIVE' : 'IDLE'}
          </span>
        </div>

        <div className="status-bar">
          <div className={`rec-dot ${isListening ? 'recording' : ''}`} />
          <span>
            {isListening
              ? 'RECORDING'
              : hasRecording
                ? `${recordedNotes.length} NOTES  ·  ${
                    (recordedNotes[recordedNotes.length - 1].time +
                     recordedNotes[recordedNotes.length - 1].duration).toFixed(1)}S`
                : 'READY'}
          </span>
          {currentNote && isListening && (
            <span className="status-right">{currentNote.freq.toFixed(1)} Hz</span>
          )}
        </div>

        {/* Live note display */}
        <div className="note-display">
          {currentNote && isListening ? (
            <>
              <span className="note-big">{currentNote.name}</span>
              <span className="note-midi">MIDI {currentNote.midi}</span>
              <span className="note-hz">{currentNote.freq.toFixed(1)} Hz</span>
            </>
          ) : (
            <span className="note-empty">
              {isListening ? 'Listening…' : 'Press Record to start'}
            </span>
          )}
        </div>

        {/* Live waveform */}
        <Waveform
          analyserNode={analyserNode}
          isActive={isListening}
          color="#3B6CF4"
          label="LIVE INPUT"
        />

        {/* Piano */}
        <div className="piano-wrap">
          <Piano88 activeNote={activeNote} playedNotes={recentPlayed} />
        </div>

        {/* Note history */}
        {noteHistory.length > 0 && (
          <div className="history-strip">
            {noteHistory.map(n => (
              <div key={n.id} className="history-chip">
                <span className="chip-name">{n.name}</span>
                <span className="chip-midi">{n.midi}</span>
              </div>
            ))}
          </div>
        )}

        {/* Controls */}
        <div style={{ padding: '12px 16px', display: 'flex', gap: '8px' }}>
          {!isListening && (
            <button className="btn btn-record" onClick={handleStart}>
              <span className="btn-dot" /> Record
            </button>
          )}
          {isListening && (
            <button className="btn btn-stop" onClick={handleStop}>
              ■ Stop
            </button>
          )}
          {midiBlob && !isListening && (
            <button className="btn btn-outline"
              onClick={() => downloadMidi(midiBlob, `${sessionName}_output.mid`)}>
              ↓ Download MIDI
            </button>
          )}
        </div>
      </div>

      {/* Hidden audio element for playback */}
      <audio ref={audioElemRef} style={{ display: 'none' }} />

      {/* Comparison card */}
      {hasRecording && !isListening && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Compare · Recording vs MIDI</span>
          </div>

          <div className="compare-section">
            {/* Track A: original audio */}
            <div className="track-block">
              <div className="track-header"
                style={{ '--track-color': '#3B6CF4' }}>
                <div className="track-color-bar"
                  style={{ background: '#3B6CF4' }} />
                <span className="track-name">Track A — Original Recording</span>
                <span className="track-meta">
                  {audioDur > 0 ? `${audioDur.toFixed(1)}s` : ''}
                </span>
                <button
                  className="track-play-btn"
                  style={{ background: '#3B6CF4' }}
                  onClick={playTrackA}
                  disabled={!audioBlob}
                >
                  {playingA ? '■' : '▶'}
                </button>
              </div>
              <div className="track-wave">
                <Waveform
                  audioBlob={audioBlob}
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
                <div className="track-color-bar"
                  style={{ background: '#22C55E' }} />
                <span className="track-name">Track B — MIDI Output</span>
                <span className="track-meta">
                  {recordedNotes.length} notes
                </span>
                <button
                  className="track-play-btn"
                  style={{ background: '#22C55E' }}
                  onClick={playTrackB}
                  disabled={!recordedNotes.length}
                >
                  {playingB ? '■' : '▶'}
                </button>
              </div>
              <div className="track-wave">
                {/* MIDI waveform: live canvas driven by playback note events */}
                <Waveform
                  isActive={playingB}
                  analyserNode={null}
                  color="#22C55E"
                  label="MIDI"
                />
              </div>
            </div>

            {/* Compare button */}
            <div className="compare-btn-row">
              <button
                className="compare-toggle"
                onClick={handleCompare}
                disabled={!audioBlob || !recordedNotes.length}
              >
                ⇄ {comparing ? 'Stop Compare' : 'Play Both Together'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
