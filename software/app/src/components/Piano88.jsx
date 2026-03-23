/**
 * Piano88.jsx  v2 -- polyphonic
 * Supports activeNote (single) OR activeNotes (array) for chord display.
 *
 * Props
 * -----
 * activeNote   number | null         single active MIDI note
 * activeNotes  number[]              multiple active notes (chord mode)
 */

import React, { useRef, useEffect, useMemo } from 'react'

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
const BLACK_NOTES = new Set([1,3,6,8,10])

function buildLayout() {
  const keys = []
  let wi = 0
  for (let midi = 21; midi <= 108; midi++) {
    const n = midi % 12
    const oct = Math.floor(midi / 12) - 1
    const name = `${NOTE_NAMES[n]}${oct}`
    if (BLACK_NOTES.has(n)) {
      keys.push({ midi, isBlack: true, prevWhite: wi - 1, name, note: NOTE_NAMES[n] })
    } else {
      keys.push({ midi, isBlack: false, wi, name, note: NOTE_NAMES[n] })
      wi++
    }
  }
  return { keys, totalWhite: wi }
}

export function Piano88({ activeNote = null, activeNotes = [] }) {
  const canvasRef = useRef(null)
  const { keys, totalWhite } = useMemo(buildLayout, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const H = canvas.height

    const ww = W / totalWhite
    const bw = ww * 0.62
    const bh = H * 0.62

    // Build active set
    const activeSet = new Set()
    if (activeNote != null && activeNote >= 0) activeSet.add(activeNote)
    for (const m of activeNotes) if (m >= 0) activeSet.add(m)

    ctx.clearRect(0, 0, W, H)

    // White keys
    for (const k of keys) {
      if (k.isBlack) continue
      const x = k.wi * ww
      const active = activeSet.has(k.midi)
      ctx.fillStyle = active ? '#3B6CF4' : '#EDEAE4'
      ctx.fillRect(x + 0.5, 0.5, ww - 1, H - 1)
      ctx.strokeStyle = '#AAAAAA'
      ctx.lineWidth = 0.5
      ctx.strokeRect(x + 0.5, 0.5, ww - 1, H - 1)
      if (k.note === 'C' || active) {
        ctx.fillStyle = active ? '#FFFFFF' : '#999999'
        ctx.font = `${Math.max(6, Math.floor(ww * 0.48))}px "IBM Plex Mono",monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(k.name, x + ww / 2, H - 4)
      }
    }

    // Black keys
    for (const k of keys) {
      if (!k.isBlack) continue
      const x = (k.prevWhite + 0.65) * ww
      const active = activeSet.has(k.midi)
      ctx.fillStyle = active ? '#3B6CF4' : '#1C1820'
      ctx.fillRect(x, 0, bw, bh)
      ctx.strokeStyle = '#000000'
      ctx.lineWidth = 0.5
      ctx.strokeRect(x, 0, bw, bh)
      if (!active) {
        ctx.strokeStyle = '#444'
        ctx.lineWidth = 0.8
        ctx.beginPath()
        ctx.moveTo(x + bw * 0.35, 3)
        ctx.lineTo(x + bw * 0.35, bh * 0.6)
        ctx.stroke()
      }
    }
  }, [activeNote, activeNotes, keys, totalWhite])

  return (
    <canvas
      ref={canvasRef}
      width={1040}
      height={110}
      style={{ width: '100%', height: '110px', display: 'block' }}
    />
  )
}
