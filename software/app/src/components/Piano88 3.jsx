/**
 * Piano88.jsx  --  Canvas-based 88-key piano keyboard
 * =====================================================
 * Renders MIDI 21 (A0) through MIDI 108 (C8) with
 * pixel-accurate key proportions and positions.
 *
 * Layout math
 * -----------
 * 52 white keys total.  Each white key width = canvasWidth / 52.
 * Black key width = 0.62 × white key width.
 * Black key height = 62% of canvas height.
 *
 * Black key left-edge position:
 *   left = (prevWhiteIndex + 0.65) × whiteKeyWidth
 * where prevWhiteIndex is the count of white keys seen
 * before this black key.  This gives the standard piano
 * offset where black keys sit 65% into the preceding
 * white key, matching the visual appearance of a real
 * acoustic piano.
 *
 * Props
 * -----
 * activeNote  {number|null}   MIDI note currently lit (amber)
 * playedNotes {number[]}      Recently played MIDI notes (faint amber)
 */

import React, { useRef, useEffect, useMemo } from 'react'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK_NOTES = new Set([1, 3, 6, 8, 10])

/**
 * Precompute the layout for all 88 keys once.
 * Returns an array of key descriptors and the total white key count.
 */
function buildLayout() {
  const keys = []
  let whiteIdx = 0

  for (let midi = 21; midi <= 108; midi++) {
    const note = midi % 12
    const octave = Math.floor(midi / 12) - 1
    const name = `${NOTE_NAMES[note]}${octave}`
    const isBlack = BLACK_NOTES.has(note)

    if (isBlack) {
      // Black key: remember the white key count at this moment
      // so we can position it relative to the preceding white key.
      keys.push({ midi, isBlack: true, prevWhite: whiteIdx - 1, name })
    } else {
      keys.push({ midi, isBlack: false, whiteIdx, name })
      whiteIdx++
    }
  }

  return { keys, totalWhite: whiteIdx }
}

export function Piano88({ activeNote = null, playedNotes = [] }) {
  const canvasRef = useRef(null)
  const { keys, totalWhite } = useMemo(buildLayout, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const H = canvas.height

    // Key dimensions
    const ww = W / totalWhite    // white key width
    const bw = ww * 0.62         // black key width
    const bh = H * 0.62          // black key height

    const played = new Set(playedNotes)
    ctx.clearRect(0, 0, W, H)

    // ---- Pass 1: white keys ----
    for (const k of keys) {
      if (k.isBlack) continue
      const x = k.whiteIdx * ww

      if (k.midi === activeNote) {
        ctx.fillStyle = '#E8A030'
      } else if (played.has(k.midi)) {
        ctx.fillStyle = '#E8A03022'
      } else {
        ctx.fillStyle = '#EDEBE6'
      }
      ctx.fillRect(x + 0.5, 0.5, ww - 1, H - 1)

      ctx.strokeStyle = '#999'
      ctx.lineWidth = 0.5
      ctx.strokeRect(x + 0.5, 0.5, ww - 1, H - 1)

      // Label: show note name on C keys and on the active key
      const isC = k.name.startsWith('C') && !k.name.includes('#')
      if (isC || k.midi === activeNote) {
        ctx.fillStyle = k.midi === activeNote ? '#1a1a1a' : '#888'
        ctx.font = `${Math.max(6, Math.floor(ww * 0.5))}px "DM Mono", monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(k.name, x + ww / 2, H - 5)
      }
    }

    // ---- Pass 2: black keys (drawn on top of white) ----
    for (const k of keys) {
      if (!k.isBlack) continue

      // Position: 65% into the preceding white key
      const x = (k.prevWhite + 0.65) * ww

      if (k.midi === activeNote) {
        ctx.fillStyle = '#E8A030'
      } else if (played.has(k.midi)) {
        ctx.fillStyle = '#7a5010'
      } else {
        ctx.fillStyle = '#1C1820'
      }
      ctx.fillRect(x, 0, bw, bh)

      ctx.strokeStyle = '#000'
      ctx.lineWidth = 0.5
      ctx.strokeRect(x, 0, bw, bh)

      // Subtle shine line on black keys
      if (k.midi !== activeNote && !played.has(k.midi)) {
        ctx.strokeStyle = '#333'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x + bw * 0.35, 3)
        ctx.lineTo(x + bw * 0.35, bh * 0.6)
        ctx.stroke()
      }
    }
  }, [activeNote, playedNotes, keys, totalWhite])

  return (
    <canvas
      ref={canvasRef}
      width={1040}
      height={130}
      style={{ width: '100%', height: '130px', display: 'block', borderRadius: '0 0 6px 6px' }}
    />
  )
}
