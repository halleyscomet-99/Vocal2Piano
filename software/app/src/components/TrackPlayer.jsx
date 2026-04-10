/**
 * TrackPlayer.jsx  v2
 * -------------------
 * Unified track block: progress scrubber, volume, play/pause.
 * Handles audio-not-ready gracefully (Infinity duration).
 */

import React, { useCallback, useRef } from 'react'
import { Waveform } from './Waveform'

function fmt(sec) {
  if (!sec || !isFinite(sec) || sec <= 0) return ''
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(1)
  return m > 0 ? `${m}:${s.padStart(4,'0')}` : `${s}s`
}

export function TrackPlayer({
  label       = 'Track',
  color       = '#3B6CF4',
  audioRef    = null,
  audioBlob   = null,
  duration    = 0,
  currentTime = 0,
  playing     = false,
  disabled    = false,
  onPlay      = () => {},
  onSeek      = () => {},
  volume      = 1,
  onVolume    = () => {},
  checked     = true,
  onCheck     = () => {},
  children,
}) {
  const barRef = useRef(null)

  // Safe duration: guard against Infinity / NaN
  const safeDur = isFinite(duration) && duration > 0 ? duration : 0
  const progress = safeDur > 0 ? Math.min(1, currentTime / safeDur) : 0

  const calcTime = useCallback((e) => {
    if (!barRef.current || !safeDur) return null
    const rect  = barRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    return ratio * safeDur
  }, [safeDur])

  const handleMouseDown = useCallback((e) => {
    const t = calcTime(e)
    if (t === null) return
    onSeek(t)

    const onMove = (ev) => {
      const tt = calcTime(ev)
      if (tt !== null) onSeek(tt)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [calcTime, onSeek])

  return (
    <div className="track-block">
      {/* Header */}
      <div className="track-header">
        <input type="checkbox" className="track-check"
          checked={checked} onChange={onCheck} />
        <div className="track-color-bar" style={{ background: color }} />
        <span className="track-name">{label}</span>

        <span className="track-meta" style={{ minWidth: 80, textAlign: 'right' }}>
          {playing && currentTime > 0 && safeDur > 0
            ? `${fmt(currentTime)} / ${fmt(safeDur)}`
            : fmt(safeDur)}
        </span>

        {/* Volume */}
        <input type="range" min={0} max={1} step={0.05} value={volume}
          onChange={e => onVolume(Number(e.target.value))}
          style={{ width: 56, accentColor: color, cursor: 'pointer', flexShrink: 0 }}
          title={`Volume ${Math.round(volume * 100)}%`}
        />

        {/* Play */}
        <button className="track-play-btn" style={{ background: color }}
          onClick={onPlay} disabled={disabled}>
          {playing ? '■' : '▶'}
        </button>
      </div>

      {/* Scrubber — only when we have a real duration */}
      <div
        ref={barRef}
        onMouseDown={safeDur > 0 ? handleMouseDown : undefined}
        style={{
          height: 5,
          background: 'var(--bg2)',
          cursor: safeDur > 0 ? 'pointer' : 'default',
          position: 'relative',
          userSelect: 'none',
        }}
      >
        <div style={{
          position: 'absolute', left: 0, top: 0,
          width: `${progress * 100}%`, height: '100%',
          background: color, opacity: 0.75,
        }} />
        {safeDur > 0 && (
          <div style={{
            position: 'absolute',
            left: `${progress * 100}%`, top: '50%',
            transform: 'translate(-50%,-50%)',
            width: 11, height: 11, borderRadius: '50%',
            background: color, boxShadow: '0 0 0 2px white',
            pointerEvents: 'none',
          }} />
        )}
      </div>

      {/* Waveform */}
      <div className="track-wave">
        <Waveform
          audioBlob={audioBlob}
          currentTime={currentTime}
          duration={safeDur}
          color={color}
          label={label.split('—')[0].trim().toUpperCase()}
          isActive={playing && !audioBlob}
        />
      </div>

      {children}
    </div>
  )
}