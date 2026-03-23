/**
 * TrackPlayer.jsx  --  Two-track comparison playback
 * ====================================================
 * Shows two labelled audio/MIDI tracks side by side.
 * Each track has an independent play/pause button.
 * A "Compare" button plays both simultaneously (offset
 * by a small visual delay so the user can tell them apart).
 *
 * Props
 * -----
 * trackA  { label, notes, blob, color }   original / input
 * trackB  { label, notes, blob, color }   converted MIDI
 * onNoteA {(midi)=>void}   called while track A plays each note
 * onNoteB {(midi)=>void}   called while track B plays each note
 */

import React, { useState, useRef, useCallback } from 'react'
import { playMidiNotes } from '../utils/midiUtils'

export function TrackPlayer({ trackA, trackB, onNoteA, onNoteB }) {
  const [playingA, setPlayingA] = useState(false)
  const [playingB, setPlayingB] = useState(false)
  const [comparing, setComparing] = useState(false)

  const cancelA = useRef(null)
  const cancelB = useRef(null)

  const stopAll = useCallback(() => {
    if (cancelA.current) cancelA.current()
    if (cancelB.current) cancelB.current()
    setPlayingA(false)
    setPlayingB(false)
    setComparing(false)
    if (onNoteA) onNoteA(null)
    if (onNoteB) onNoteB(null)
  }, [onNoteA, onNoteB])

  const playTrack = useCallback(async (track, setPlaying, cancelRef, onNote) => {
    if (!track?.notes?.length) return
    setPlaying(true)
    cancelRef.current = await playMidiNotes(
      track.notes,
      onNote,
      () => {
        setPlaying(false)
        if (onNote) onNote(null)
      }
    )
  }, [])

  const handlePlayA = useCallback(async () => {
    if (playingA) { stopAll(); return }
    stopAll()
    await playTrack(trackA, setPlayingA, cancelA, onNoteA)
  }, [playingA, trackA, stopAll, playTrack, onNoteA])

  const handlePlayB = useCallback(async () => {
    if (playingB) { stopAll(); return }
    stopAll()
    await playTrack(trackB, setPlayingB, cancelB, onNoteB)
  }, [playingB, trackB, stopAll, playTrack, onNoteB])

  const handleCompare = useCallback(async () => {
    if (comparing) { stopAll(); return }
    stopAll()
    setComparing(true)
    // Play both tracks; they share Tone.js Transport so they're in sync
    cancelA.current = await playMidiNotes(
      trackA?.notes || [],
      onNoteA,
      () => setPlayingA(false)
    )
    cancelB.current = await playMidiNotes(
      trackB?.notes || [],
      onNoteB,
      () => {
        setPlayingB(false)
        setComparing(false)
        if (onNoteA) onNoteA(null)
        if (onNoteB) onNoteB(null)
      }
    )
  }, [comparing, trackA, trackB, stopAll, onNoteA, onNoteB])

  const hasA = trackA?.notes?.length > 0
  const hasB = trackB?.notes?.length > 0

  return (
    <div className="track-player">
      <div className="track-row">
        {/* Track A */}
        <div className={`track-card ${playingA ? 'active' : ''}`}
          style={{ '--track-color': trackA?.color || '#4DAAFF' }}>
          <div className="track-label">{trackA?.label || 'Track A'}</div>
          <div className="track-meta">
            {hasA
              ? `${trackA.notes.length} notes`
              : 'No data'}
          </div>
          <button
            className="track-btn"
            onClick={handlePlayA}
            disabled={!hasA}
          >
            {playingA ? '■' : '▶'}
          </button>
        </div>

        {/* Compare button (centre) */}
        <button
          className={`compare-btn ${comparing ? 'active' : ''}`}
          onClick={handleCompare}
          disabled={!hasA || !hasB}
          title="Play both tracks simultaneously"
        >
          {comparing ? '■' : '⇄'}
          <span className="compare-label">
            {comparing ? 'Stop' : 'Compare'}
          </span>
        </button>

        {/* Track B */}
        <div className={`track-card ${playingB ? 'active' : ''}`}
          style={{ '--track-color': trackB?.color || '#E8A030' }}>
          <div className="track-label">{trackB?.label || 'Track B'}</div>
          <div className="track-meta">
            {hasB
              ? `${trackB.notes.length} notes`
              : 'No data'}
          </div>
          <button
            className="track-btn"
            onClick={handlePlayB}
            disabled={!hasB}
          >
            {playingB ? '■' : '▶'}
          </button>
        </div>
      </div>
    </div>
  )
}
