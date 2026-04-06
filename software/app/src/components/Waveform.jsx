/**
 * Waveform.jsx  v3
 * -----------------
 * Two modes:
 *
 *   LIVE (analyserNode prop):
 *     Reads AnalyserNode every rAF.
 *     Draws time-domain waveform + subtle FFT bars.
 *     No progress bar (real time).
 *
 *   PLAYBACK (audioBlob or isActive prop):
 *     Decodes audioBlob once → draws static waveform.
 *     Progress bar overlay moves with currentTime / duration.
 *     Falls back to animated bars when no blob (MIDI playback).
 *
 * Improvements in v3:
 *   - Waveform amplitude scaled up (×2.2) so quiet signals are visible
 *   - Filled waveform below centerline for visual weight
 *   - Progress bar: translucent tint + bright tick line
 *   - MIDI playback mode: animated bouncing bars
 */

import React, { useRef, useEffect, useCallback } from 'react'

const H = 72        // canvas height px
const BAR_W = 2     // FFT bar width
const BAR_GAP = 1   // FFT bar gap
const AMP_SCALE = 2.2  // amplify waveform so quiet signals are visible

export function Waveform({
  analyserNode = null,
  audioBlob = null,
  currentTime = 0,
  duration = 0,
  isActive = false,
  color = '#3B6CF4',
  label = '',
}) {
  const canvasRef = useRef(null)
  const rafRef = useRef(null)
  const staticDataRef = useRef(null)   // decoded Float32Array for static mode
  const blobRef = useRef(null)

  // ---- decode blob once ----
  useEffect(() => {
    if (!audioBlob || audioBlob === blobRef.current) return
    blobRef.current = audioBlob
    staticDataRef.current = null

    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const ctx = new OfflineAudioContext(1, 1, 44100)
        const buf = await ctx.decodeAudioData(e.target.result)
        const raw = buf.getChannelData(0)
        // Downsample to ~600 points
        const step = Math.max(1, Math.floor(raw.length / 600))
        const pts = []
        for (let i = 0; i < raw.length; i += step) {
          let max = 0
          for (let j = i; j < Math.min(i + step, raw.length); j++) {
            max = Math.max(max, Math.abs(raw[j]))
          }
          pts.push(max)
        }
        staticDataRef.current = pts
      } catch {}
    }
    reader.readAsArrayBuffer(audioBlob)
  }, [audioBlob])

  // ---- draw static waveform ----
  const drawStatic = useCallback((canvas, progress) => {
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const cy = H / 2
    ctx.clearRect(0, 0, W, H)

    const pts = staticDataRef.current
    if (!pts || pts.length === 0) {
      drawPlaceholder(ctx, W, color)
    } else {
      // Background
      ctx.fillStyle = '#0F1728'
      ctx.fillRect(0, 0, W, H)

      const step = W / pts.length
      const progressX = progress * W

      // Played region (brighter)
      ctx.fillStyle = color + 'CC'
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(0, cy)
      for (let i = 0; i < pts.length; i++) {
        const x = i * step
        const amp = Math.min(pts[i] * AMP_SCALE, 1.0) * (cy - 4)
        if (x <= progressX) {
          ctx.lineTo(x, cy - amp)
        }
      }
      for (let i = pts.length - 1; i >= 0; i--) {
        const x = i * step
        const amp = Math.min(pts[i] * AMP_SCALE, 1.0) * (cy - 4)
        if (x <= progressX) {
          ctx.lineTo(x, cy + amp)
        }
      }
      ctx.closePath()
      ctx.fill()

      // Unplayed region (dimmer)
      ctx.fillStyle = color + '33'
      ctx.beginPath()
      ctx.moveTo(progressX, cy)
      for (let i = 0; i < pts.length; i++) {
        const x = i * step
        if (x >= progressX) {
          const amp = Math.min(pts[i] * AMP_SCALE, 1.0) * (cy - 4)
          ctx.lineTo(x, cy - amp)
        }
      }
      for (let i = pts.length - 1; i >= 0; i--) {
        const x = i * step
        if (x >= progressX) {
          const amp = Math.min(pts[i] * AMP_SCALE, 1.0) * (cy - 4)
          ctx.lineTo(x, cy + amp)
        }
      }
      ctx.closePath()
      ctx.fill()

      // Centerline
      ctx.strokeStyle = color + '20'
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(0, cy)
      ctx.lineTo(W, cy)
      ctx.stroke()
    }

    // Progress tint overlay
    if (progress > 0) {
      ctx.fillStyle = color + '18'
      ctx.fillRect(0, 0, progress * W, H)
      // Bright tick
      ctx.fillStyle = color
      ctx.fillRect(Math.max(0, progress * W - 1.5), 0, 2, H)
    }

    // Label
    if (label) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = '500 10px "IBM Plex Mono", monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(label, 10, 7)
    }
  }, [color, label])

  // ---- draw placeholder (no blob yet) ----
  function drawPlaceholder(ctx, W, col) {
    ctx.fillStyle = '#0F1728'
    ctx.fillRect(0, 0, W, H)
    const cy = H / 2
    ctx.strokeStyle = col + '30'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, cy)
    ctx.lineTo(W, cy)
    ctx.stroke()
  }

  // ---- draw MIDI animated bars ----
  const drawMidiBars = useCallback((canvas, t) => {
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0F1728'
    ctx.fillRect(0, 0, W, H)

    const total = Math.floor(W / (BAR_W + BAR_GAP))
    for (let i = 0; i < total; i++) {
      const phase = (i / total) * Math.PI * 2 + t * 3.5
      const amp = (Math.sin(phase) * 0.5 + 0.5) * (H * 0.38) + H * 0.08
      const x = i * (BAR_W + BAR_GAP)
      const alpha = 0.3 + Math.sin(phase) * 0.25
      ctx.fillStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0')
      ctx.fillRect(x, (H - amp) / 2, BAR_W, amp)
    }

    if (label) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = '500 10px "IBM Plex Mono", monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(label, 10, 7)
    }
  }, [color, label])

  // ---- draw live analyser ----
  const drawLive = useCallback((canvas, analyser) => {
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const cy = H / 2

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0F1728'
    ctx.fillRect(0, 0, W, H)

    const timeBuf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(timeBuf)

    // Filled waveform
    ctx.fillStyle = color + '55'
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    const sliceW = W / timeBuf.length
    ctx.moveTo(0, cy)
    for (let i = 0; i < timeBuf.length; i++) {
      const v = Math.max(-1, Math.min(1, timeBuf[i] * AMP_SCALE))
      ctx.lineTo(i * sliceW, cy - v * (cy - 4))
    }
    for (let i = timeBuf.length - 1; i >= 0; i--) {
      const v = Math.max(-1, Math.min(1, timeBuf[i] * AMP_SCALE))
      ctx.lineTo(i * sliceW, cy + v * (cy - 4))
    }
    ctx.closePath()
    ctx.fill()
    // outline
    ctx.beginPath()
    for (let i = 0; i < timeBuf.length; i++) {
      const v = Math.max(-1, Math.min(1, timeBuf[i] * AMP_SCALE))
      const x = i * sliceW
      const y = cy - v * (cy - 4)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Subtle FFT bars at bottom
    const freqBuf = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(freqBuf)
    const barCount = 80
    const barW = W / barCount
    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor((i / barCount) * freqBuf.length * 0.4)
      const amp = (freqBuf[idx] / 255) * H * 0.22
      ctx.fillStyle = color + '44'
      ctx.fillRect(i * barW, H - amp, barW - 1, amp)
    }

    if (label) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = '500 10px "IBM Plex Mono", monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(label, 10, 7)
    }
  }, [color, label])

  // ---- animation loop ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    if (analyserNode) {
      // Live mode
      const loop = () => {
        drawLive(canvas, analyserNode)
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(rafRef.current)
    }

    if (isActive && !audioBlob) {
      // MIDI playback — animated bars
      const start = performance.now()
      const loop = () => {
        drawMidiBars(canvas, (performance.now() - start) / 1000)
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(rafRef.current)
    }

    // Static / playback mode
    const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0
    if (audioBlob && staticDataRef.current) {
      drawStatic(canvas, progress)
    } else if (audioBlob) {
      // Not decoded yet -- try again shortly
      const t = setTimeout(() => {
        if (staticDataRef.current) drawStatic(canvas, progress)
      }, 200)
      return () => clearTimeout(t)
    } else {
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#0F1728'
      ctx.fillRect(0, 0, canvas.width, H)
      if (label) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)'
        ctx.font = '500 10px "IBM Plex Mono", monospace'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(label, 10, 7)
      }
    }
  }, [analyserNode, audioBlob, currentTime, duration, isActive,
      drawLive, drawStatic, drawMidiBars, label])

  return (
    <div className="waveform-wrap">
      <canvas
        ref={canvasRef}
        width={1200}
        height={H}
        style={{ width: '100%', height: `${H}px`, display: 'block' }}
      />
    </div>
  )
}