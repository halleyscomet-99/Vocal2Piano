/**
 * PianoRollSection.jsx  v3
 * -------------------------
 * - source prop: 'voice' → clean + arrange, other → clean only
 * - Exposes playRef so parent can trigger playback for multi-play
 * - Volume control connected to Tone.js
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { PianoRoll } from './PianoRoll'
import { playMidiNotes } from '../utils/midiUtils'

const CLEAN_URL = import.meta.env.VITE_CLEAN_URL || 'http://localhost:8001'

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result.split(',')[1])
    r.onerror = rej
    r.readAsDataURL(blob)
  })
}

/**
 * Props:
 *   midiBlob      Blob|null
 *   melodyNotes   note[]        the melody (vocals or lead instrument)
 *   initialBpm    number
 *   source        'voice'|'instrumental'|'mixed'|'auto'
 *                 voice → /clean + /arrange (generate new accomp from melody)
 *                 others → /clean only (preserve original transcription)
 *   visible       bool
 *   onSend        () => void
 *   playRef       ref           parent sets playRef.current = {play, stop}
 *   volume        number        0-1
 */
export function PianoRollSection({
  midiBlob      = null,
  melodyNotes   = [],
  initialBpm    = 120,
  source        = 'voice',
  visible       = false,
  onSend        = () => {},
  playRef       = null,
  volume        = 1,
}) {
  const [bpm,       setBpm]       = useState(initialBpm)
  const [transpose, setTranspose] = useState(0)
  const [style,     setStyle]     = useState('pop')
  const [accomp,    setAccomp]    = useState([])
  const [melody,    setMelody]    = useState([])
  const [removed,   setRemoved]   = useState([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [sending,   setSending]   = useState(false)
  const [sendStatus, setSendStatus] = useState(null)
  const [playing,   setPlaying]   = useState(false)
  const [playheadTime, setPlayheadTime] = useState(0)

  const cancelRef = useRef(null)
  const rafRef    = useRef(null)
  const t0Ref     = useRef(null)

  // voice mode → generate new accompaniment from melody
  // instrumental/mixed → just clean the existing MIDI
  const needsArrange = source === 'voice' || source === 'auto'

  useEffect(() => {
    if (!midiBlob || !visible) return
    const run = async () => {
      setLoading(true); setError(null)
      try {
        const b64 = await blobToBase64(midiBlob)
        const res = await fetch(`${CLEAN_URL}/clean`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ midi_b64: b64, bpm, transpose }),
        })
        if (!res.ok) throw new Error(`Clean server ${res.status}`)
        const data = await res.json()
        setRemoved(data.removed || [])

        if (needsArrange) {
          // Voice: use melody notes to generate fresh accompaniment
          const mel = melodyNotes.length ? melodyNotes : (data.melody || [])
          setMelody(mel)
          const arr = await fetch(`${CLEAN_URL}/arrange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ melody: mel, bpm, style, transpose }),
          })
          if (!arr.ok) throw new Error(`Arrange server ${arr.status}`)
          const arrData = await arr.json()
          setAccomp(arrData.accomp || [])
        } else {
          // Instrumental/mixed: use cleaned original MIDI as-is
          const allNotes = [...(data.melody || []), ...(data.accomp || [])]
          setMelody(data.melody || [])
          setAccomp(allNotes)
          setRemoved(data.removed || [])
        }
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    run()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, midiBlob, bpm, transpose, style, needsArrange])

  // Debug
  useEffect(() => {
    console.log('[PianoRoll] visible:', visible, 'midiBlob:', !!midiBlob)
  }, [visible, midiBlob])

  const stopPlayback = useCallback(() => {
    if (cancelRef.current) cancelRef.current()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false); setPlayheadTime(0)
    t0Ref.current = null
  }, [])

  const startPlayback = useCallback(async (vol = 1) => {
    if (!accomp.length) return
    if (playing) { stopPlayback() }
    setPlaying(true)
    t0Ref.current = performance.now()
    const tick = () => {
      if (!t0Ref.current) return
      setPlayheadTime((performance.now() - t0Ref.current) / 1000)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    cancelRef.current = await playMidiNotes(
      accomp,
      () => {},
      () => { setPlaying(false); setPlayheadTime(0); t0Ref.current = null },
      vol
    )
  }, [playing, accomp])

  // Expose play/stop to parent via playRef
  useEffect(() => {
    if (!playRef) return
    playRef.current = {
      play:  (vol) => startPlayback(vol),
      stop:  stopPlayback,
      notes: accomp,
    }
  }, [playRef, startPlayback, stopPlayback, accomp])


  const handleSend = useCallback(async () => {
    setSending(true); setSendStatus(null)
    try {
      const res = await fetch(`${CLEAN_URL}/send_teensy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accomp, bpm, transpose }),
      })
      if (!res.ok) throw new Error(`Send failed ${res.status}`)
      const data = await res.json()
      setSendStatus(`Sent ${data.notes} notes`)
      onSend()
    } catch (e) {
      setSendStatus(`Error: ${e.message}`)
    } finally {
      setSending(false)
    }
  }, [accomp, bpm, transpose, onSend])

  if (!visible || !midiBlob) return null

  const modeLabel = needsArrange
    ? 'Generated accompaniment from melody'
    : 'Cleaned original transcription'

  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="card-header">
        <span className="card-title">Piano Roll — Edit & Preview</span>
        <span style={{ fontSize: '0.65rem', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
          {modeLabel}
        </span>

        {loading && (
          <span style={{
            fontSize: '0.68rem', color: 'var(--amber)',
            fontFamily: 'var(--font-mono)',
          }}>
            ⟳ Generating…
          </span>
        )}
        {error && (
          <span style={{ fontSize: '0.68rem', color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>
            ⚠ {error} — run: python software/engine/MIDI2Clean.py --server --port 8001
          </span>
        )}
      </div>

      <div style={{ padding: 14 }}>
        <PianoRoll
          melodyNotes={melody}
          removedNotes={removed}
          accompNotes={accomp}
          onAccompChange={setAccomp}
          bpm={bpm} onBpmChange={setBpm}
          transpose={transpose} onTransposeChange={setTranspose}
          style={style} onStyleChange={setStyle}
          playing={playing} playheadTime={playheadTime}
          onPlay={() => { stopPlayback(); startPlayback(volume) }}
          onStop={stopPlayback}
          onSendToTeensy={handleSend}
        />
      </div>

      {sendStatus && (
        <div style={{
          padding: '8px 14px', fontSize: '0.72rem', fontFamily: 'var(--font-mono)',
          color: sendStatus.startsWith('Error') ? 'var(--red)' : 'var(--green)',
          borderTop: '1px solid var(--border)',
        }}>
          {sendStatus}
        </div>
      )}
    </div>
  )
}