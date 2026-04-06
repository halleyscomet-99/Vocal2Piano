/**
 * Piano88.jsx
 * -----------
 * Renders a full 88-key piano keyboard (MIDI 21 = A0 to MIDI 108 = C8).
 * Highlights the active note in amber, and faintly shows recently played
 * notes to give a "heat map" effect.
 *
 * Props:
 *   activeNote  {number|null}  - MIDI number of the currently lit key
 *   playedNotes {number[]}     - Array of recently played MIDI numbers
 */

import React, { useMemo } from 'react'

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
const BLACK_OFFSETS = new Set([1, 3, 6, 8, 10]) // C# D# F# G# A#

// Maps the note-within-octave index to the horizontal offset (fraction of a
// white-key width) for positioning each black key.
const BLACK_POSITION = { 1: 0.65, 3: 1.65, 6: 3.60, 8: 4.60, 10: 5.60 }

function isBlackKey(midi) {
  return BLACK_OFFSETS.has(midi % 12)
}

export function Piano88({ activeNote = null, playedNotes = [] }) {
  const playedSet = useMemo(() => new Set(playedNotes), [playedNotes])

  // Precompute key layout once
  const { whiteKeys, blackKeys, totalWhite } = useMemo(() => {
    const whites = []
    const blacks = []
    let wIdx = 0

    for (let midi = 21; midi <= 108; midi++) {
      const nInOct = midi % 12
      const octave = Math.floor(midi / 12) - 1
      const noteName = NOTE_NAMES[nInOct]

      if (BLACK_OFFSETS.has(nInOct)) {
        blacks.push({ midi, noteName: `${noteName}${octave}`, note: noteName, wIdx })
      } else {
        whites.push({ midi, noteName: `${noteName}${octave}`, note: noteName, wIdx })
        wIdx++
      }
    }

    return { whiteKeys: whites, blackKeys: blacks, totalWhite: wIdx }
  }, [])

  const wPct = 100 / totalWhite // width of one white key as %

  return (
    <div className="piano-wrap">
      {/* White keys */}
      {whiteKeys.map((k) => {
        const active = k.midi === activeNote
        const played = playedSet.has(k.midi)
        return (
          <div
            key={k.midi}
            className={`piano-white${active ? ' active' : played ? ' played' : ''}`}
            style={{ left: `${k.wIdx * wPct}%`, width: `${wPct}%` }}
          >
            {/* Show note name label only on C keys and the active key */}
            {(k.note === 'C' || active) && (
              <span className="key-label">
                {active ? k.noteName : k.noteName}
              </span>
            )}
          </div>
        )
      })}

      {/* Black keys -- positioned relative to their preceding white key */}
      {blackKeys.map((k) => {
        const active = k.midi === activeNote
        const played = playedSet.has(k.midi)
        // Find the white key immediately before this black key
        const prevWhiteIdx = k.wIdx - 1
        const leftPct = (prevWhiteIdx + (BLACK_POSITION[k.midi % 12] || 0.65)) * wPct

        return (
          <div
            key={k.midi}
            className={`piano-black${active ? ' active' : played ? ' played' : ''}`}
            style={{ left: `${leftPct}%`, width: `${wPct * 0.62}%` }}
          />
        )
      })}
    </div>
  )
}
