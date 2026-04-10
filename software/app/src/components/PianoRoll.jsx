/**
 * PianoRoll.jsx  v3 — Waterfall
 * Notes fall downward onto a horizontal piano keyboard.
 * Time axis vertical: top=future, bottom=now (piano keys).
 * Melody = blue (read-only), Accomp = green (editable).
 */

import { SolenoidViz } from './SolenoidViz'
import React, {
  useRef, useEffect, useCallback, useState, useMemo,
} from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIDI_MIN   = 21
const MIDI_MAX   = 108
const BLACK_PCS  = new Set([1, 3, 6, 8, 10])
const NOTE_NAMES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']

const WHITE_W  = 14
const BLACK_W  = 9
const KEY_H    = 72
const BLACK_H  = 44
const PX_SEC   = 80
const ROLL_H   = 340

const STYLE_OPTIONS = [
  { id: 'pop',          label: 'Pop',         desc: 'Four-on-floor bass, chord stabs' },
  { id: 'rnb',          label: 'R&B',         desc: 'Lazy syncopated bass, lush chords' },
  { id: 'funk',         label: 'Funk',        desc: '16th-note ghost bass, staccato stabs' },
  { id: 'jazz',         label: 'Jazz',        desc: 'Walking bass, off-beat voicings' },
  { id: 'rock',         label: 'Rock',        desc: 'Power chords, crash on 2+4' },
  { id: 'classical',    label: 'Classical',   desc: 'Alberti bass, voice leading' },
  { id: 'fingerpicking',label: 'Fingerpick',  desc: 'Travis-style alternating thumb' },
  { id: 'bossa',        label: 'Bossa',       desc: 'Syncopated clave rhythm' },
]

// ─── Layout ───────────────────────────────────────────────────────────────────

function buildLayout() {
  const keys = []
  let wx = 0
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    const pc      = midi % 12
    const isBlack = BLACK_PCS.has(pc)
    if (isBlack) {
      keys.push({ midi, isBlack: true, x: wx * WHITE_W - BLACK_W / 2 - 1 })
    } else {
      keys.push({ midi, isBlack: false, x: wx * WHITE_W })
      wx++
    }
  }
  return { keys, totalWidth: wx * WHITE_W }
}

function xToMidi(x, keys) {
  // Black keys take priority
  for (let i = keys.length - 1; i >= 0; i--) {
    const k  = keys[i]
    const kw = k.isBlack ? BLACK_W : WHITE_W
    if (x >= k.x && x < k.x + kw) return k.midi
  }
  return -1
}

function noteName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────

function drawKeyboard(ctx, keys, totalWidth, activeSet) {
  ctx.clearRect(0, 0, totalWidth, KEY_H)
  for (const k of keys) {
    if (k.isBlack) continue
    const lit = activeSet.has(k.midi)
    ctx.fillStyle = lit ? '#3B6CF4' : '#F5F3EF'
    ctx.fillRect(k.x, 0, WHITE_W - 1, KEY_H)
    ctx.strokeStyle = '#CCCCCC'
    ctx.lineWidth = 0.5
    ctx.strokeRect(k.x, 0, WHITE_W - 1, KEY_H)
    if (k.midi % 12 === 0) {
      ctx.fillStyle = lit ? '#fff' : '#AAAAAA'
      ctx.font = '7px "IBM Plex Mono", monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(noteName(k.midi), k.x + WHITE_W / 2 - 0.5, KEY_H - 5)
    }
  }
  for (const k of keys) {
    if (!k.isBlack) continue
    const lit = activeSet.has(k.midi)
    ctx.fillStyle = lit ? '#3B6CF4' : '#1A1820'
    ctx.fillRect(k.x, 0, BLACK_W, BLACK_H)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 0.5
    ctx.strokeRect(k.x, 0, BLACK_W, BLACK_H)
  }
}

function drawGrid(ctx, totalWidth, bpm, viewStart, viewDur) {
  ctx.fillStyle = '#0F1728'
  ctx.fillRect(0, 0, totalWidth, ROLL_H)
  const beatSec = 60 / bpm
  const barSec  = beatSec * 4
  const vEnd    = viewStart + viewDur
  for (let t = Math.floor(viewStart / beatSec) * beatSec; t <= vEnd; t += beatSec) {
    const y     = ROLL_H - (t - viewStart) / viewDur * ROLL_H
    const isBar = (t % barSec) < 0.01 || (barSec - t % barSec) < 0.01
    ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)'
    ctx.lineWidth   = isBar ? 1 : 0.5
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(totalWidth, y); ctx.stroke()
  }
  ctx.strokeStyle = '#EF4444'
  ctx.lineWidth   = 2
  ctx.beginPath(); ctx.moveTo(0, ROLL_H); ctx.lineTo(totalWidth, ROLL_H); ctx.stroke()
}

function drawNotes(ctx, notes, keys, fillColor, strokeColor, viewStart, viewDur, dashed = false) {
  const vEnd = viewStart + viewDur
  for (const n of notes) {
    if (n.time + n.duration < viewStart || n.time > vEnd) continue
    const k = keys.find(k => k.midi === n.midi)
    if (!k) continue
    const kw = k.isBlack ? BLACK_W : WHITE_W - 1
    const t0 = Math.max(n.time, viewStart)
    const t1 = Math.min(n.time + n.duration, vEnd)
    const y0 = ROLL_H - (t1 - viewStart) / viewDur * ROLL_H
    const h  = Math.max((t1 - t0) / viewDur * ROLL_H, 3)
    ctx.fillStyle   = fillColor
    ctx.strokeStyle = strokeColor
    ctx.lineWidth   = 0.8
    if (dashed) ctx.setLineDash([3, 2])
    ctx.beginPath()
    ctx.roundRect(k.x + 1, y0, kw - 2, h, 3)
    ctx.fill(); ctx.stroke()
    if (dashed) ctx.setLineDash([])
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PianoRoll({
  melodyNotes    = [],
  accompNotes    = [],
  removedNotes   = [],
  onAccompChange = () => {},
  bpm            = 120,
  onBpmChange    = () => {},
  transpose      = 0,
  onTransposeChange = () => {},
  style          = 'pop',
  onStyleChange  = () => {},
  playing        = false,
  playheadTime   = 0,
  onPlay         = () => {},
  onStop         = () => {},
  onSendToTeensy = () => {},
  readOnly       = false,
}) {
  const kbRef   = useRef(null)
  const rollRef = useRef(null)
  const drag    = useRef(null)

  const [editNotes, setEditNotes] = useState(accompNotes)
  const [tool,      setTool]      = useState('draw')
  const [zoom,      setZoom]      = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const [showRemoved, setShowRemoved] = useState(true)
  const [view, setView] = useState('roll') // 'roll' | 'solenoid'

  const { keys, totalWidth } = useMemo(buildLayout, [])

  const totalSec = useMemo(() => {
    const all = [...melodyNotes, ...editNotes]
    return all.length ? Math.max(...all.map(n => n.time + n.duration)) + 2 : 16
  }, [melodyNotes, editNotes])

  const viewDur = (ROLL_H / PX_SEC) / zoom

  // Sync prop → state
  useEffect(() => { setEditNotes(accompNotes) }, [accompNotes])

  // Auto-advance: current time always at bottom of roll
  useEffect(() => {
    if (!playing) return
    setViewStart(Math.max(0, playheadTime))
  }, [playing, playheadTime])

  // Active keys at playhead
  const activeSet = useMemo(() => {
    if (!playing) return new Set()
    const all = [...melodyNotes, ...editNotes]
    return new Set(
      all.filter(n => n.time <= playheadTime && n.time + n.duration >= playheadTime)
         .map(n => n.midi)
    )
  }, [playing, playheadTime, melodyNotes, editNotes])

  // Draw keyboard
  useEffect(() => {
    const c = kbRef.current; if (!c) return
    drawKeyboard(c.getContext('2d'), keys, totalWidth, activeSet)
  }, [keys, totalWidth, activeSet])

  // Draw waterfall
  useEffect(() => {
    const c = rollRef.current; if (!c) return
    const ctx = c.getContext('2d')
    drawGrid(ctx, totalWidth, bpm, viewStart, viewDur)
    if (showRemoved) {
      drawNotes(ctx, removedNotes.filter(n => n.remove_reason === 'too_short'),
        keys, 'rgba(239,68,68,0.45)', '#EF4444', viewStart, viewDur, true)
      drawNotes(ctx, removedNotes.filter(n => n.remove_reason === 'too_quiet'),
        keys, 'rgba(245,158,11,0.45)', '#F59E0B', viewStart, viewDur, true)
      drawNotes(ctx, removedNotes.filter(n => n.remove_reason === 'duplicate'),
        keys, 'rgba(139,92,246,0.4)', '#8B5CF6', viewStart, viewDur, true)
    }
    drawNotes(ctx, melodyNotes, keys, 'rgba(59,108,244,0.55)', '#2554D4', viewStart, viewDur)
    drawNotes(ctx, editNotes,   keys, 'rgba(34,197,94,0.82)',  '#16A34A', viewStart, viewDur)

  }, [editNotes, melodyNotes, removedNotes, showRemoved, keys, totalWidth, bpm, viewStart, viewDur, playing, playheadTime])

  // ── Handlers (all defined before useEffect that depends on them) ───────────

  const handleWheel = useCallback((e) => {
    setViewStart(v => Math.max(0, Math.min(totalSec - viewDur, v + e.deltaY / 120)))
  }, [totalSec, viewDur])

  // Passive-safe wheel listener
  useEffect(() => {
    const canvas = rollRef.current; if (!canvas) return
    const handler = (e) => { e.preventDefault(); handleWheel(e) }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [handleWheel])

  const handleMouseDown = useCallback((e) => {
    if (readOnly || tool !== 'move') return
    const rect = rollRef.current.getBoundingClientRect()
    const x    = e.clientX - rect.left
    const y    = e.clientY - rect.top
    const midi = xToMidi(x, keys)
    const t    = viewStart + (ROLL_H - y) / ROLL_H * viewDur
    const idx  = editNotes.findIndex(n =>
      n.midi === midi && t >= n.time && t <= n.time + n.duration
    )
    if (idx >= 0) drag.current = { idx, startT: t, origTime: editNotes[idx].time }
  }, [readOnly, tool, keys, viewStart, viewDur, editNotes])

  const handleMouseMove = useCallback((e) => {
    if (!drag.current) return
    const rect = rollRef.current.getBoundingClientRect()
    const y    = e.clientY - rect.top
    const t    = viewStart + (ROLL_H - y) / ROLL_H * viewDur
    const dt   = t - drag.current.startT
    setEditNotes(prev => prev.map((n, i) =>
      i === drag.current.idx
        ? { ...n, time: Math.max(0, drag.current.origTime + dt) }
        : n
    ))
  }, [viewStart, viewDur])

  const handleMouseUp = useCallback(() => {
    if (drag.current) { onAccompChange(editNotes); drag.current = null }
  }, [editNotes, onAccompChange])

  const handleClick = useCallback((e) => {
    if (readOnly || tool === 'move') return
    const rect = rollRef.current.getBoundingClientRect()
    const x    = e.clientX - rect.left
    const y    = e.clientY - rect.top
    const midi = xToMidi(x, keys)
    if (midi < 0) return
    const t       = viewStart + (ROLL_H - y) / ROLL_H * viewDur
    const beatSec = 60 / bpm
    const snapped = Math.max(0, Math.round(t / (beatSec / 2)) * (beatSec / 2))

    if (tool === 'erase' || e.button === 2) {
      const idx = editNotes.findIndex(n =>
        n.midi === midi && snapped >= n.time && snapped <= n.time + n.duration
      )
      if (idx >= 0) {
        const next = editNotes.filter((_, i) => i !== idx)
        setEditNotes(next); onAccompChange(next)
      }
      return
    }
    const next = [...editNotes, { midi, time: snapped, duration: beatSec, velocity: 80 }]
    setEditNotes(next); onAccompChange(next)
  }, [readOnly, tool, keys, viewStart, viewDur, bpm, editNotes, onAccompChange])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '8px 12px', background: 'var(--bg)',
        border: '1px solid var(--border)', borderRadius: 8,
      }}>
        <button onClick={playing ? onStop : onPlay} style={{
          width: 30, height: 30, borderRadius: '50%',
          background: playing ? 'var(--red-dim)' : 'var(--accent-dim)',
          border: `1px solid ${playing ? 'var(--red)' : 'var(--accent)'}`,
          color: playing ? 'var(--red)' : 'var(--accent)',
          fontSize: '0.75rem', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{playing ? '■' : '▶'}</button>

        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />

        {!readOnly && ['draw', 'move', 'erase'].map(t => (
          <button key={t} onClick={() => setTool(t)} style={{
            padding: '3px 9px', borderRadius: 5, fontSize: '0.7rem',
            fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            border: `1px solid ${tool === t ? 'var(--accent)' : 'var(--border)'}`,
            background: tool === t ? 'var(--accent-dim)' : 'transparent',
            color: tool === t ? 'var(--accent)' : 'var(--text3)',
          }}>{{ draw: '✏ Draw', move: '↖ Move', erase: '⌫ Erase' }[t]}</button>
        ))}

        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />

        {[
          { label: 'BPM', min: 40,  max: 240, step: 1,   value: bpm,       onChange: onBpmChange,       width: 80, fmt: v => v },
          { label: 'Key', min: -12, max: 12,  step: 1,   value: transpose, onChange: onTransposeChange, width: 70, fmt: v => v > 0 ? `+${v}` : v },
          { label: 'Zoom',min: 0.4, max: 4,   step: 0.1, value: zoom,      onChange: setZoom,           width: 60, fmt: v => `${v.toFixed(1)}×` },
        ].map(({ label, min, max, step, value, onChange, width, fmt }) => (
          <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{label}</span>
            <input type="range" min={min} max={max} step={step} value={value}
              onChange={e => onChange(Number(e.target.value))}
              style={{ width, accentColor: 'var(--accent)' }} />
            <span style={{ fontSize: '0.72rem', color: 'var(--text2)', fontFamily: 'var(--font-mono)', minWidth: 32 }}>{fmt(value)}</span>
          </label>
        ))}

        <div style={{ display: 'flex', gap: 3 }}>
          {STYLE_OPTIONS.map(s => (
            <button key={s.id} onClick={() => onStyleChange(s.id)} title={s.desc} style={{
              padding: '3px 8px', borderRadius: 5, fontSize: '0.7rem',
              fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
              border: `1px solid ${style === s.id ? 'var(--accent)' : 'var(--border)'}`,
              background: style === s.id ? 'var(--accent-dim)' : 'transparent',
              color: style === s.id ? 'var(--accent)' : 'var(--text3)',
            }}>{s.label}</button>
          ))}
        </div>

        {/* View toggle */}
        <div style={{ display: 'flex', gap: 3, marginLeft: 4 }}>
          {[['roll', '🎹 Roll'], ['solenoid', '⚙ Solenoid']].map(([v, l]) => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '3px 9px', borderRadius: 5, fontSize: '0.7rem',
              fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
              border: `1px solid ${view === v ? 'var(--accent)' : 'var(--border)'}`,
              background: view === v ? 'var(--accent-dim)' : 'transparent',
              color: view === v ? 'var(--accent)' : 'var(--text3)',
            }}>{l}</button>
          ))}
        </div>

        <button onClick={onSendToTeensy} style={{
          marginLeft: 'auto', padding: '5px 12px', borderRadius: 6,
          background: 'var(--green)', border: 'none', color: '#fff',
          fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
        }}>▶ Send to Piano</button>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, paddingLeft: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        {[['#3B6CF4', 'Melody (read-only)'], ['#22C55E', 'Accompaniment (editable)']].map(([c, l]) => (
          <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 10, height: 8, borderRadius: 2, background: c, opacity: 0.8 }} />
            <span style={{ fontSize: '0.66rem', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{l}</span>
          </div>
        ))}
        <span style={{ fontSize: '0.64rem', color: 'var(--text4)', fontFamily: 'var(--font-mono)', marginLeft: 6 }}>
          Scroll to pan · {tool === 'draw' ? 'Click to add' : tool === 'move' ? 'Drag to move' : 'Click to erase'}
        </span>
        {removedNotes.length > 0 && (
          <>
            <div style={{ width: 1, height: 14, background: 'var(--border)' }} />
            {[['#EF4444', `${removedNotes.filter(n=>n.remove_reason==='too_short').length} too short`],
              ['#F59E0B', `${removedNotes.filter(n=>n.remove_reason==='too_quiet').length} too quiet`],
              ['#8B5CF6', `${removedNotes.filter(n=>n.remove_reason==='duplicate').length} duplicate`],
            ].filter(([,l]) => !l.startsWith('0')).map(([c, l]) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 10, height: 8, borderRadius: 2, background: c, opacity: 0.6,
                  border: `1px dashed ${c}` }} />
                <span style={{ fontSize: '0.63rem', color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{l}</span>
              </div>
            ))}
            <button onClick={() => setShowRemoved(v => !v)} style={{
              padding: '2px 8px', borderRadius: 4, fontSize: '0.63rem',
              border: '1px solid var(--border)', background: 'transparent',
              color: showRemoved ? 'var(--accent)' : 'var(--text4)',
              cursor: 'pointer', fontFamily: 'var(--font-mono)',
            }}>
              {showRemoved ? '● shown' : '○ hidden'}
            </button>
          </>
        )}
      </div>

      {/* Solenoid View */}
      {view === 'solenoid' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', boxShadow: 'var(--shadow-sm)', padding: '12px 8px 4px' }}>
          <SolenoidViz
            accompNotes={editNotes}
            melodyNotes={melodyNotes}
            activeNotes={playing
              ? [...melodyNotes, ...editNotes]
                  .filter(n => n.time <= playheadTime && n.time + n.duration >= playheadTime)
                  .map(n => n.midi)
              : []}
          />
        </div>
      )}

      {/* Waterfall + Keyboard */}
      {view === 'roll' && <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ overflowX: 'auto', background: '#0F1728', width: '100%' }}>
          <canvas
            ref={rollRef}
            width={totalWidth}
            height={ROLL_H}
            style={{ display: 'block', cursor: readOnly ? 'default' : tool === 'move' ? 'grab' : 'crosshair', minWidth: '100%' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onClick={handleClick}
            onContextMenu={e => { e.preventDefault(); handleClick(e) }}
          />
        </div>
        <div style={{ overflowX: 'auto', background: '#E8E4DC', width: '100%' }}>
          <canvas ref={kbRef} width={totalWidth} height={KEY_H} style={{ display: 'block', minWidth: '100%' }} />
        </div>
      </div>}


      {/* Stats */}
      <div style={{ fontSize: '0.66rem', color: 'var(--text3)', fontFamily: 'var(--font-mono)', paddingLeft: 2 }}>
        {melodyNotes.length} melody · {editNotes.length} accompaniment · {totalSec.toFixed(1)}s
      </div>
    </div>
  )
}