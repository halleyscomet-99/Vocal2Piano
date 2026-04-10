/**
 * LiveMode.jsx  v6
 * ----------------
 * - TrackPlayer for Track A (recording) with scrubber + volume
 * - Track B (MIDI) with scrubber via Tone.js position
 * - PianoRoll track included in Play Selected
 * - All tracks can play simultaneously
 */

import React, { useState, useRef, useCallback } from 'react'
import { Piano88 }         from './Piano88'
import { Waveform }        from './Waveform'
import { TrackPlayer }     from './TrackPlayer'
import { PianoRollSection } from './PianoRollSection'
import { usePitchDetect }  from '../hooks/usePitchDetect'
import { notesToMidiBlob, playMidiNotes } from '../utils/midiUtils'

const BACKEND = import.meta.env.VITE_BACKEND_URL || ''

const MODES = [
  { id: 'instrument', icon: '🎹', label: 'Instrument',
    desc: 'Piano, guitar — aubio 6ms fast response', cmd: '--mode instrument' },
  { id: 'voice', icon: '🎤', label: 'Voice',
    desc: 'Singing, humming — pYIN 200ms accurate', cmd: '--mode voice' },
  { id: 'chord', icon: '🎵', label: 'Chord',
    desc: 'Accompaniment, chords — CQT polyphonic up to 6 notes', cmd: '--mode chord' },
]

export function LiveMode() {
  const [inputMode, setInputMode] = useState('instrument')

  const {
    currentNote, isListening, noteHistory,
    chordMidis, analyserNode, sourceMode, start, stop,
  } = usePitchDetect(inputMode)

  const [recordedNotes, setRecordedNotes] = useState([])
  const [audioBlob,     setAudioBlob]     = useState(null)
  const [midiBlob,      setMidiBlob]      = useState(null)
  const [sessionName]   = useState(
    () => `live_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}`
  )
  const [savedMidiName,  setSavedMidiName]  = useState(null)
  const [savedAudioName, setSavedAudioName] = useState(null)

  // Track A (recording audio)
  const audioRefA  = useRef(null)
  const urlARef    = useRef(null)
  const rafA       = useRef(null)
  const [durA,     setDurA]    = useState(0)
  const [timeA,    setTimeA]   = useState(0)
  const [playingA, setPlayingA] = useState(false)
  const [volA,     setVolA]    = useState(1)

  // Track B (MIDI playback)
  const cancelMidiRef = useRef(null)
  const rafB          = useRef(null)
  const t0B           = useRef(null)
  const [playingB, setPlayingB] = useState(false)
  const [timeB,    setTimeB]   = useState(0)
  const [midiNote, setMidiNote] = useState(null)
  const [volB,     setVolB]    = useState(1)

  const [checked,     setChecked]     = useState({ a: true, b: true })
  const [multiPlaying, setMultiPlaying] = useState(false)
  const [checkedPiano, setCheckedPiano] = useState(true)
  const [volPiano,     setVolPiano]     = useState(1)
  const pianoRollPlayRef               = useRef(null)

  const pianoNote  = isListening ? (currentNote?.midi ?? null) : (midiNote ?? null)
  const hasRecording = recordedNotes.length > 0
  const recDur     = hasRecording
    ? (recordedNotes[recordedNotes.length - 1].time +
       recordedNotes[recordedNotes.length - 1].duration)
    : 0

  // ── Audio helpers ────────────────────────────────────────────────────────

  function startAudioA(seekTo = 0) {
    if (!audioRefA.current || !audioRefA.current.src) return
    audioRefA.current.volume  = volA
    audioRefA.current.currentTime = seekTo
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

  function stopAudioA() {
    if (rafA.current) { cancelAnimationFrame(rafA.current); rafA.current = null }
    if (audioRefA.current) { audioRefA.current.pause(); audioRefA.current.currentTime = 0 }
    setPlayingA(false); setTimeA(0)
  }

  const stopAll = useCallback(() => {
    stopAudioA()
    if (cancelMidiRef.current) { cancelMidiRef.current(); cancelMidiRef.current = null }
    if (rafB.current) { cancelAnimationFrame(rafB.current); rafB.current = null }
    setPlayingB(false); setTimeB(0); setMidiNote(null)
    setMultiPlaying(false)
    if (pianoRollPlayRef.current?.stop) pianoRollPlayRef.current.stop()
  }, [])

  const handlePlayA = useCallback(() => {
    if (playingA) { stopAudioA(); return }
    stopAll(); startAudioA(0)
  }, [playingA, stopAll, volA])

  const handleSeekA = useCallback((t) => {
    setTimeA(t)
    if (playingA) {
      stopAudioA()
      startAudioA(t)
    }
  }, [playingA, volA])

  const handleVolA = useCallback((v) => {
    setVolA(v)
    if (audioRefA.current) audioRefA.current.volume = v
  }, [])

  const handlePlayB = useCallback(async () => {
    if (playingB) { stopAll(); return }
    if (!recordedNotes.length) return
    stopAll(); setPlayingB(true)
    t0B.current = performance.now()
    const tick = () => {
      if (!t0B.current) return
      setTimeB((performance.now() - t0B.current) / 1000)
      rafB.current = requestAnimationFrame(tick)
    }
    rafB.current = requestAnimationFrame(tick)
    cancelMidiRef.current = await playMidiNotes(
      recordedNotes,
      midi => setMidiNote(midi),
      () => {
        setPlayingB(false); setTimeB(0); setMidiNote(null)
        if (rafB.current) cancelAnimationFrame(rafB.current)
        t0B.current = null
      }
    )
  }, [playingB, recordedNotes, stopAll])

  const handleMultiPlay = useCallback(async () => {
    if (multiPlaying) { stopAll(); return }
    stopAll(); setMultiPlaying(true)
    let running = 0
    const done = () => { running--; if (running <= 0) setMultiPlaying(false) }

    if (checked.a && audioBlob && audioRefA.current?.src) {
      running++
      audioRefA.current.volume = volA
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
      running++; setPlayingB(true)
      t0B.current = performance.now()
      const tick = () => {
        if (!t0B.current) return
        setTimeB((performance.now() - t0B.current) / 1000)
        rafB.current = requestAnimationFrame(tick)
      }
      rafB.current = requestAnimationFrame(tick)
      cancelMidiRef.current = await playMidiNotes(
        recordedNotes,
        midi => setMidiNote(midi),
        () => { setPlayingB(false); setTimeB(0); setMidiNote(null); done() }
      )
    }

    if (checkedPiano && pianoRollPlayRef.current?.notes?.length) {
      running++
      pianoRollPlayRef.current.play(volPiano).then(() => done()).catch(() => done())
    }

    if (running === 0) setMultiPlaying(false)
  }, [multiPlaying, checked, checkedPiano, audioBlob, recordedNotes, volA, volPiano, stopAll])

  const toggleCheck = (id) => setChecked(prev => ({ ...prev, [id]: !prev[id] }))

  // ── Recording controls ───────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    setRecordedNotes([]); setAudioBlob(null); setMidiBlob(null)
    setSavedMidiName(null); setSavedAudioName(null)
    setMidiNote(null); setTimeA(0); setDurA(0); setTimeB(0)
    await start()
  }, [start])

  const handleStop = useCallback(async () => {
    const { notes, audioBlob: blob } = await stop()
    setRecordedNotes(notes)
    setAudioBlob(blob)

    if (blob && audioRefA.current) {
      if (urlARef.current) URL.revokeObjectURL(urlARef.current)
      const url = URL.createObjectURL(blob)
      urlARef.current = url
      audioRefA.current.src = url
      audioRefA.current.load()
      audioRefA.current.onloadedmetadata = () => {
        if (audioRefA.current) setDurA(audioRefA.current.duration)
      }
    }

    if (notes.length > 0) {
      const midi = notesToMidiBlob(notes, 120)
      setMidiBlob(midi)
    }
  }, [stop])

  const modeInfo = MODES.find(m => m.id === inputMode)

  return (
    <div className="mode-panel">

      {/* Mode selector */}
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
          {modeInfo?.cmd && (
            <div style={{
              padding: '0 16px 12px', fontSize: '0.68rem',
              color: 'var(--text3)', fontFamily: 'var(--font-mono)',
            }}>
              For best accuracy:&nbsp;
              <span style={{ color: 'var(--accent)' }}>
                python software/engine/Vocal2MIDI_live.py {modeInfo.cmd} --ws
              </span>
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

        <Waveform analyserNode={analyserNode} isActive={isListening}
          color="#3B6CF4" label="LIVE INPUT" />

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
              <span className="note-big" style={{ fontSize: '1.6rem', color: 'var(--text2)' }}>
                {recordedNotes.length} notes
              </span>
              <span className="note-midi">{recDur.toFixed(1)}s recorded</span>
            </>
          ) : (
            <span className="note-empty">
              {isListening ? 'Listening...' : 'Press Record to start'}
            </span>
          )}
        </div>

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

      {/* Compare tracks */}
      {hasRecording && !isListening && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Compare · Recording vs MIDI</span>
          </div>
          <div className="compare-section">

            <TrackPlayer
              id="a" label="Track A — Recording" color="#3B6CF4"
              audioRef={audioRefA} audioBlob={audioBlob}
              duration={durA} currentTime={timeA}
              playing={playingA} disabled={!audioBlob}
              onPlay={handlePlayA} onSeek={handleSeekA}
              volume={volA} onVolume={handleVolA}
              checked={checked.a} onCheck={() => toggleCheck('a')}
            />

            <TrackPlayer
              id="b" label="Track B — MIDI Output" color="#22C55E"
              duration={recDur} currentTime={timeB}
              playing={playingB} disabled={!recordedNotes.length}
              onPlay={handlePlayB}
              onSeek={() => {}}
              volume={volB} onVolume={setVolB}
              checked={checked.b} onCheck={() => toggleCheck('b')}
            >
              {midiNote != null && <Piano88 activeNote={midiNote} />}
            </TrackPlayer>

            {/* Piano Roll track */}
            {!!midiBlob && (
              <div className="track-block" style={{ background: 'var(--accent-glow)' }}>
                <div className="track-header">
                  <input type="checkbox" className="track-check"
                    checked={checkedPiano} onChange={() => setCheckedPiano(p => !p)} />
                  <div className="track-color-bar" style={{ background: 'var(--purple)' }} />
                  <span className="track-name">Track C — Piano Roll (Layer 2)</span>
                  <span className="track-meta" style={{ fontSize: '0.65rem' }}>generated</span>
                  <input type="range" min={0} max={1} step={0.05} value={volPiano}
                    onChange={e => setVolPiano(Number(e.target.value))}
                    style={{ width: 56, accentColor: 'var(--purple)' }} title="Volume" />
                  <button className="track-play-btn" style={{ background: 'var(--purple)' }}
                    onClick={() => pianoRollPlayRef.current?.play(volPiano)}>▶</button>
                </div>
              </div>
            )}

            <div className="compare-btn-row">
              <span style={{ fontSize: '0.68rem', color: 'var(--text3)',
                fontFamily: 'var(--font-mono)', marginRight: 8 }}>
                Play checked tracks together:
              </span>
              <button className="compare-toggle" onClick={handleMultiPlay}>
                ⇄ {multiPlaying ? 'Stop' : 'Play Selected'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Piano Roll — Layer 2 */}
      <PianoRollSection
        midiBlob={midiBlob}
        melodyNotes={recordedNotes}
        initialBpm={120}
        source={inputMode === "voice" ? "voice" : "instrumental"}
        visible={hasRecording && !isListening && !!midiBlob}
        onSend={() => {}}
        playRef={pianoRollPlayRef}
        volume={volPiano}
      />

      <audio ref={audioRefA} style={{ display: 'none' }} preload="auto" />
    </div>
  )
}