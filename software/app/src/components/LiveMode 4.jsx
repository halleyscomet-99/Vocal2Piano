/**
 * LiveMode.jsx
 * ------------
 * Layout fix: controls row is outside the piano card, no overlap.
 * Piano shows only the single active note (no ghost keys).
 * Track A = real recorded audio blob played via HTMLAudioElement.
 * Track B = MIDI synthesized via Tone.js.
 * Both tracks have waveform display.
 */

import React, { useState, useRef, useCallback } from 'react'
import { Piano88 } from './Piano88'
import { Waveform } from './Waveform'
import { usePitchDetect } from '../hooks/usePitchDetect'
import { notesToMidiBlob, downloadMidi, playMidiNotes } from '../utils/midiUtils'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function LiveMode() {
  const { currentNote, isListening, noteHistory, analyserNode, start, stop } =
    usePitchDetect()

  const [recordedNotes, setRecordedNotes] = useState([])
  const [audioBlob, setAudioBlob] = useState(null)
  const [midiBlob, setMidiBlob] = useState(null)
  const [sessionName] = useState(
    () => `live_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}`
  )

  // Track A (audio)
  const audioElemRef = useRef(null)
  const [audioTime, setAudioTime] = useState(0)
  const [audioDur, setAudioDur] = useState(0)
  const [playingA, setPlayingA] = useState(false)
  const audioRafRef = useRef(null)

  // Track B (MIDI)
  const [playingB, setPlayingB] = useState(false)
  const [midiNote, setMidiNote] = useState(null)
  const cancelMidiRef = useRef(null)

  const [comparing, setComparing] = useState(false)

  // During recording show live note; during MIDI playback show MIDI note
  const pianoNote = isListening
    ? (currentNote?.midi ?? null)
    : (midiNote ?? null)

  // ---- Recording ----
  const handleStart = useCallback(async () => {
    setRecordedNotes([])
    setAudioBlob(null)
    setMidiBlob(null)
    setMidiNote(null)
    setAudioTime(0)
    setAudioDur(0)
    await start()
  }, [start])

  const handleStop = useCallback(async () => {
    const { notes, audioBlob: blob } = await stop()
    setRecordedNotes(notes)
    setAudioBlob(blob)

    if (blob && audioElemRef.current) {
      const url = URL.createObjectURL(blob)
      audioElemRef.current.src = url
      audioElemRef.current.onloadedmetadata = () => {
        setAudioDur(audioElemRef.current.duration)
      }
    }

    if (notes.length > 0) {
      const midi = notesToMidiBlob(notes, 120)
      setMidiBlob(midi)
      downloadMidi(midi, `${sessionName}_output.mid`)
    }
  }, [stop, sessionName])

  // ---- Track A ----
  const stopA = useCallback(() => {
    if (audioElemRef.current) {
      audioElemRef.current.pause()
      audioElemRef.current.currentTime = 0
    }
    if (audioRafRef.current) cancelAnimationFrame(audioRafRef.current)
    setPlayingA(false)
    setAudioTime(0)
  }, [])

  const startA = useCallback(() => {
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
  }, [audioBlob])

  const handlePlayA = useCallback(() => {
    if (playingA) { stopA(); return }
    stopAll(); startA()
  }, [playingA, stopA, startA]) // eslint-disable-line

  // ---- Track B ----
  const stopB = useCallback(() => {
    if (cancelMidiRef.current) cancelMidiRef.current()
    setPlayingB(false)
    setMidiNote(null)
  }, [])

  const startB = useCallback(async () => {
    if (!recordedNotes.length) return
    setPlayingB(true)
    cancelMidiRef.current = await playMidiNotes(
      recordedNotes,
      midi => setMidiNote(midi),
      () => { setPlayingB(false); setMidiNote(null) }
    )
  }, [recordedNotes])

  const handlePlayB = useCallback(() => {
    if (playingB) { stopB(); return }
    stopAll(); startB() // eslint-disable-line
  }, [playingB, stopB, startB]) // eslint-disable-line

  // ---- Stop all ----
  const stopAll = useCallback(() => {
    stopA(); stopB(); setComparing(false)
  }, [stopA, stopB])

  // ---- Compare ----
  const handleCompare = useCallback(async () => {
    if (comparing) { stopAll(); return }
    stopAll()
    setComparing(true)
    startA()
    await startB()
  }, [comparing, stopAll, startA, startB])

  const hasRecording = recordedNotes.length > 0
  const recDuration = hasRecording
    ? (recordedNotes[recordedNotes.length - 1].time +
       recordedNotes[recordedNotes.length - 1].duration).toFixed(1)
    : '0'

  return (
    <div className="mode-panel">

      {/* Input card: waveform + note display + piano -- NO controls inside */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Input · Microphone</span>
          <span className={`card-badge ${isListening ? 'live' : 'idle'}`}>
            {isListening ? '● REC' : hasRecording ? 'RECORDED' : 'IDLE'}
          </span>
        </div>

        {/* Live waveform */}
        <Waveform
          analyserNode={analyserNode}
          isActive={isListening}
          color="#3B6CF4"
          label="LIVE INPUT"
        />

        {/* Note display */}
        <div className="note-display">
          {currentNote && isListening ? (
            <>
              <span className="note-big">{currentNote.name}</span>
              <span className="note-midi">MIDI {currentNote.midi}</span>
              <span className="note-hz">{currentNote.freq.toFixed(1)} Hz</span>
            </>
          ) : hasRecording && !isListening ? (
            <>
              <span className="note-big" style={{ fontSize: '1.6rem', color: 'var(--text2)' }}>
                {recordedNotes.length} notes
              </span>
              <span className="note-midi">{recDuration}s recorded</span>
            </>
          ) : (
            <span className="note-empty">
              {isListening ? 'Listening…' : 'Press Record to start'}
            </span>
          )}
        </div>

        {/* Piano - single key, no ghost */}
        <Piano88 activeNote={pianoNote} />

        {/* Note history strip */}
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
      </div>

      {/* Controls: OUTSIDE the card, clearly separated */}
      <div className="controls-row">
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
          <button
            className="btn btn-outline"
            onClick={() => downloadMidi(midiBlob, `${sessionName}_output.mid`)}
          >
            ↓ Download MIDI
          </button>
        )}
      </div>

      {/* Hidden audio element */}
      <audio ref={audioElemRef} style={{ display: 'none' }} />

      {/* Compare card: only shown after recording */}
      {hasRecording && !isListening && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Compare · Recording vs MIDI Output</span>
          </div>

          <div className="compare-section">
            {/* Track A */}
            <div className="track-block">
              <div className="track-header">
                <div className="track-color-bar" style={{ background: '#3B6CF4' }} />
                <span className="track-name">Track A — Original Recording</span>
                <span className="track-meta">
                  {audioDur > 0 ? `${audioDur.toFixed(1)}s` : ''}
                </span>
                <button
                  className="track-play-btn"
                  style={{ background: '#3B6CF4' }}
                  onClick={handlePlayA}
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

            {/* Track B */}
            <div className="track-block">
              <div className="track-header">
                <div className="track-color-bar" style={{ background: '#22C55E' }} />
                <span className="track-name">Track B — MIDI Output</span>
                <span className="track-meta">{recordedNotes.length} notes</span>
                <button
                  className="track-play-btn"
                  style={{ background: '#22C55E' }}
                  onClick={handlePlayB}
                  disabled={!recordedNotes.length}
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
              {/* Piano shows MIDI playback note */}
              {midiNote && (
                <Piano88 activeNote={midiNote} />
              )}
            </div>

            <div className="compare-btn-row">
              <button
                className="compare-toggle"
                onClick={handleCompare}
                disabled={!audioBlob || !recordedNotes.length}
              >
                ⇄ {comparing ? 'Stop' : 'Play Both Together'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
