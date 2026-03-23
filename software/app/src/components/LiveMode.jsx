/**
 * LiveMode.jsx  v5.1
 * ------------------
 * Changes from v5:
 *   - Added Chord mode to MODES array
 *   - Destructure chordMidis from usePitchDetect hook
 *   - Pass activeNotes={chordMidis} to Piano88 during live recording
 *   - Show Python command hint for selected mode
 */

import React, { useState, useRef, useCallback } from 'react'
import { Piano88 } from './Piano88'
import { Waveform } from './Waveform'
import { usePitchDetect } from '../hooks/usePitchDetect'
import { notesToMidiBlob, playMidiNotes } from '../utils/midiUtils'

const BACKEND = import.meta.env.VITE_BACKEND_URL || ''

const MODES = [
  {
    id: 'instrument', icon: '🎹', label: 'Instrument',
    desc: 'Piano, guitar — aubio 6ms fast response',
    cmd: '--mode instrument',
  },
  {
    id: 'voice', icon: '🎤', label: 'Voice',
    desc: 'Singing, humming — pYIN 200ms accurate',
    cmd: '--mode voice',
  },
  {
    id: 'chord', icon: '🎵', label: 'Chord',
    desc: 'Accompaniment, chords — CQT polyphonic up to 6 notes',
    cmd: '--mode chord',
  },
]

export function LiveMode() {
  const [inputMode, setInputMode] = useState('instrument')

  // chordMidis is now returned directly from the hook
  const {
    currentNote, isListening, noteHistory,
    chordMidis,
    analyserNode, sourceMode, start, stop,
  } = usePitchDetect(inputMode)

  const [recordedNotes, setRecordedNotes] = useState([])
  const [audioBlob, setAudioBlob] = useState(null)
  const [midiBlob, setMidiBlob] = useState(null)
  const [savedMidiName, setSavedMidiName] = useState(null)
  const [savedAudioName, setSavedAudioName] = useState(null)
  const [sessionName] = useState(
    () => `live_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}`
  )

  const audioRefA = useRef(null)
  const [durA, setDurA] = useState(0)
  const [timeA, setTimeA] = useState(0)
  const [playingA, setPlayingA] = useState(false)
  const rafA = useRef(null)
  const audioBlobUrlRef = useRef(null)

  const [playingB, setPlayingB] = useState(false)
  const [midiNote, setMidiNote] = useState(null)
  const cancelMidiRef = useRef(null)

  const [checked, setChecked] = useState({ a: true, b: true })
  const [multiPlaying, setMultiPlaying] = useState(false)

  const pianoNote = isListening ? (currentNote?.midi ?? null) : (midiNote ?? null)
  const hasRecording = recordedNotes.length > 0
  const recDur = hasRecording
    ? (
        recordedNotes[recordedNotes.length - 1].time +
        recordedNotes[recordedNotes.length - 1].duration
      ).toFixed(1)
    : '0'

  function startTrackA() {
    if (!audioRefA.current) return
    audioRefA.current.currentTime = 0
    audioRefA.current.play().catch(e => console.warn('play err:', e))
    setPlayingA(true)
    const tick = () => {
      if (!audioRefA.current) return
      setTimeA(audioRefA.current.currentTime)
      if (!audioRefA.current.paused && !audioRefA.current.ended) {
        rafA.current = requestAnimationFrame(tick)
      } else { setPlayingA(false); setTimeA(0) }
    }
    rafA.current = requestAnimationFrame(tick)
  }

  function stopTrackA() {
    if (rafA.current) { cancelAnimationFrame(rafA.current); rafA.current = null }
    if (audioRefA.current) {
      audioRefA.current.pause(); audioRefA.current.currentTime = 0
    }
    setPlayingA(false); setTimeA(0)
  }

  const stopAll = useCallback(() => {
    stopTrackA()
    if (cancelMidiRef.current) { cancelMidiRef.current(); cancelMidiRef.current = null }
    setPlayingB(false); setMidiNote(null); setMultiPlaying(false)
  }, [])

  const handlePlayA = useCallback(() => {
    if (playingA) { stopTrackA(); return }
    stopAll(); startTrackA()
  }, [playingA, stopAll])

  const handlePlayB = useCallback(async () => {
    if (playingB) { stopAll(); return }
    if (!recordedNotes.length) return
    stopAll(); setPlayingB(true)
    cancelMidiRef.current = await playMidiNotes(
      recordedNotes,
      midi => setMidiNote(midi),
      () => { setPlayingB(false); setMidiNote(null) }
    )
  }, [playingB, recordedNotes, stopAll])

  const handleMultiPlay = useCallback(async () => {
    if (multiPlaying) { stopAll(); return }
    stopAll(); setMultiPlaying(true)
    let running = 0
    const done = () => { running--; if (running <= 0) setMultiPlaying(false) }

    if (checked.a && audioRefA.current && audioBlob) {
      running++
      audioRefA.current.currentTime = 0
      audioRefA.current.play().catch(() => {})
      setPlayingA(true)
      const tick = () => {
        if (!audioRefA.current) return
        setTimeA(audioRefA.current.currentTime)
        if (!audioRefA.current.paused && !audioRefA.current.ended) {
          rafA.current = requestAnimationFrame(tick)
        } else { setPlayingA(false); setTimeA(0); done() }
      }
      rafA.current = requestAnimationFrame(tick)
    }

    if (checked.b && recordedNotes.length) {
      running++
      setPlayingB(true)
      cancelMidiRef.current = await playMidiNotes(
        recordedNotes,
        midi => setMidiNote(midi),
        () => { setPlayingB(false); setMidiNote(null); done() }
      )
    }

    if (running === 0) setMultiPlaying(false)
  }, [multiPlaying, checked, audioBlob, recordedNotes, stopAll])

  const handleStart = useCallback(async () => {
    setRecordedNotes([]); setAudioBlob(null); setMidiBlob(null)
    setSavedMidiName(null); setSavedAudioName(null)
    setMidiNote(null); setTimeA(0); setDurA(0)
    await start()
  }, [start])

  const handleStop = useCallback(async () => {
    const { notes, audioBlob: blob } = await stop()
    setRecordedNotes(notes)
    setAudioBlob(blob)

    if (blob && audioRefA.current) {
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current)
      const url = URL.createObjectURL(blob)
      audioBlobUrlRef.current = url
      audioRefA.current.src = url
      audioRefA.current.load()
      audioRefA.current.onloadedmetadata = () => {
        if (audioRefA.current) setDurA(audioRefA.current.duration)
      }
    }

    if (notes.length > 0) {
      const midi = notesToMidiBlob(notes, 120)
      setMidiBlob(midi)
      if (BACKEND) {
        const midiName = `${sessionName}_output.mid`
        const form = new FormData()
        form.append('file', new File([midi], midiName, { type: 'audio/midi' }))
        form.append('folder', 'output')
        fetch(`${BACKEND}/save`, { method: 'POST', body: form })
          .then(() => setSavedMidiName(midiName))
          .catch(() => {})
      }
    }

    if (blob && BACKEND) {
      const audioName = `${sessionName}_recording.webm`
      const form = new FormData()
      form.append('file', new File([blob], audioName, { type: blob.type }))
      form.append('folder', 'input')
      fetch(`${BACKEND}/save`, { method: 'POST', body: form })
        .then(() => setSavedAudioName(audioName))
        .catch(() => {})
    }
  }, [stop, sessionName])

  const toggleCheck = (id) => setChecked(prev => ({ ...prev, [id]: !prev[id] }))
  const modeInfo = MODES.find(m => m.id === inputMode)

  return (
    <div className="mode-panel">

      {/* Mode selector — only shown when not recording */}
      {!isListening && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Input Mode</span>
          </div>
          <div className="mode-selector">
            {MODES.map(m => (
              <button key={m.id}
                className={`mode-option ${inputMode === m.id ? 'selected' : ''}`}
                onClick={() => setInputMode(m.id)}>
                <span className="mode-icon">{m.icon}</span>
                <span className="mode-label">{m.label}</span>
                <span className="mode-desc">{m.desc}</span>
              </button>
            ))}
          </div>
          {/* Python command hint */}
          {modeInfo?.cmd && (
            <div style={{
              padding: '0 16px 12px',
              fontSize: '0.65rem',
              color: 'var(--text3)',
              fontFamily: 'var(--font-mono)',
            }}>
              For best accuracy run:&nbsp;
              python software/engine/Vocal2MIDI_live.py {modeInfo.cmd} --ws
            </div>
          )}
        </div>
      )}

      {/* Input card */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            {modeInfo?.icon} Input · {modeInfo?.label}
          </span>
          <span className={`card-badge ${isListening ? 'live' : 'idle'}`}>
            {isListening ? '● REC' : hasRecording ? 'RECORDED' : 'IDLE'}
          </span>
          {isListening && (
            <span className="card-badge" style={{
              background: sourceMode === 'python'
                ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
              color: sourceMode === 'python' ? '#22C55E' : '#F59E0B',
            }}>
              {sourceMode === 'python' ? 'Python' : 'Browser'}
            </span>
          )}
        </div>

        <Waveform
          analyserNode={analyserNode} isActive={isListening}
          color="#3B6CF4" label="LIVE INPUT"
        />

        <div className="note-display">
          {currentNote && isListening ? (
            <>
              <span className="note-big">{currentNote.name}</span>
              <span className="note-midi">MIDI {currentNote.midi}</span>
              {currentNote.freq > 0 && (
                <span className="note-hz">{currentNote.freq.toFixed(1)} Hz</span>
              )}
            </>
          ) : hasRecording && !isListening ? (
            <>
              <span className="note-big"
                style={{ fontSize: '1.6rem', color: 'var(--text2)' }}>
                {recordedNotes.length} notes
              </span>
              <span className="note-midi">{recDur}s recorded</span>
            </>
          ) : (
            <span className="note-empty">
              {isListening ? 'Listening...' : 'Press Record to start'}
            </span>
          )}
        </div>

        {/*
          Pass chordMidis for polyphonic chord display in chord mode.
          In voice/instrument mode chordMidis will always be [],
          so Piano88 falls back to single-note display via activeNote.
        */}
        <Piano88
          activeNote={pianoNote}
          activeNotes={isListening ? chordMidis : []}
        />

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

      {/* Controls */}
      <div className="controls-row">
        {!isListening && (
          <button className="btn btn-record" onClick={handleStart}>
            <span className="btn-dot" /> Record
          </button>
        )}
        {isListening && (
          <button className="btn btn-stop" onClick={handleStop}>■ Stop</button>
        )}
      </div>

      {/* Save status */}
      {(savedMidiName || savedAudioName) && (
        <div style={{
          fontSize: '0.68rem', color: 'var(--text3)',
          fontFamily: 'var(--font-mono)',
        }}>
          {savedAudioName && (
            <>Recording → software/files/input/{savedAudioName}<br /></>
          )}
          {savedMidiName && <>MIDI → software/files/output/{savedMidiName}</>}
        </div>
      )}

      <audio ref={audioRefA} style={{ display: 'none' }} preload="auto" />

      {/* Compare */}
      {hasRecording && !isListening && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Compare · Recording vs MIDI</span>
          </div>
          <div className="compare-section">

            <div className="track-block">
              <div className="track-header">
                <input type="checkbox" className="track-check"
                  checked={checked.a} onChange={() => toggleCheck('a')} />
                <div className="track-color-bar" style={{ background: '#3B6CF4' }} />
                <span className="track-name">Track A — Recording</span>
                <span className="track-meta">
                  {durA > 0 ? `${durA.toFixed(1)}s` : ''}
                </span>
                <button className="track-play-btn" style={{ background: '#3B6CF4' }}
                  onClick={handlePlayA} disabled={!audioBlob}>
                  {playingA ? '■' : '▶'}
                </button>
              </div>
              <div className="track-wave">
                <Waveform audioBlob={audioBlob} currentTime={timeA}
                  duration={durA} color="#3B6CF4" label="AUDIO" />
              </div>
              {savedAudioName && BACKEND && (
                <div style={{ padding: '4px 14px 8px' }}>
                  <a className="dl-link"
                    href={`${BACKEND}/files/input/${savedAudioName}`}
                    download={savedAudioName}>↓ {savedAudioName}</a>
                </div>
              )}
            </div>

            <div className="track-block">
              <div className="track-header">
                <input type="checkbox" className="track-check"
                  checked={checked.b} onChange={() => toggleCheck('b')} />
                <div className="track-color-bar" style={{ background: '#22C55E' }} />
                <span className="track-name">Track B — MIDI Output</span>
                <span className="track-meta">{recordedNotes.length} notes</span>
                <button className="track-play-btn" style={{ background: '#22C55E' }}
                  onClick={handlePlayB} disabled={!recordedNotes.length}>
                  {playingB ? '■' : '▶'}
                </button>
              </div>
              <div className="track-wave">
                <Waveform isActive={playingB} color="#22C55E" label="MIDI" />
              </div>
              {midiNote != null && <Piano88 activeNote={midiNote} />}
              {savedMidiName && BACKEND && (
                <div style={{ padding: '4px 14px 8px' }}>
                  <a className="dl-link"
                    href={`${BACKEND}/files/${savedMidiName}`}
                    download={savedMidiName}>↓ {savedMidiName}</a>
                </div>
              )}
            </div>

            <div className="compare-btn-row">
              <span style={{ fontSize: '0.68rem', color: 'var(--text3)', marginRight: 8 }}>
                Play checked tracks together:
              </span>
              <button className="compare-toggle" onClick={handleMultiPlay}>
                ⇄ {multiPlaying ? 'Stop' : 'Play Selected'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}