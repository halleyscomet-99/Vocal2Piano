/**
 * Waveform.jsx
 * ------------
 * Canvas waveform renderer.  Two modes:
 *
 *   Live mode (analyserNode != null):
 *     Reads the Web Audio AnalyserNode every animation frame and
 *     draws the real-time time-domain waveform + FFT spectrum.
 *
 *   Playback mode (audioBlob != null):
 *     Decodes the audio blob once, renders a static waveform of
 *     the full recording, and draws a playhead that moves with
 *     the currentTime prop.
 *
 * Props
 * -----
 * analyserNode  AnalyserNode | null   live Web Audio analyser
 * isActive      boolean               animate the live waveform
 * audioBlob     Blob | null           decoded for static display
 * currentTime   number                playhead position in seconds
 * duration      number                total audio duration
 * color         string                waveform line colour
 * label         string                top-left overlay label
 */

import React, { useRef, useEffect, useState } from 'react'

export function Waveform({
  analyserNode = null,
  isActive = false,
  audioBlob = null,
  currentTime = 0,
  duration = 0,
  color = '#4D9CFF',
  label = '',
}) {
  const canvasRef = useRef(null)
  const rafRef = useRef(null)
  const staticDataRef = useRef(null)   // decoded PCM for static waveform

  // Decode audio blob into PCM data for static rendering
  useEffect(() => {
    if (!audioBlob) { staticDataRef.current = null; return }
    const ctx = new AudioContext()
    audioBlob.arrayBuffer().then(buf => ctx.decodeAudioData(buf)).then(decoded => {
      // Down-sample to canvas width for rendering
      staticDataRef.current = decoded.getChannelData(0)
    }).catch(() => {
      staticDataRef.current = null
    })
  }, [audioBlob])

  // Draw loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const H = canvas.height
    const mid = H * 0.55

    let timeBuf = null
    let freqBuf = null

    function drawBackground() {
      ctx.fillStyle = '#0F1728'
      ctx.fillRect(0, 0, W, H)
      // Subtle grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'
      ctx.lineWidth = 0.5
      for (let y = 0; y < H; y += H / 4) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
      }
    }

    function drawIdle() {
      drawBackground()
      ctx.strokeStyle = `${color}30`
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke()
    }

    function drawLive() {
      if (!analyserNode) return
      const bufLen = analyserNode.frequencyBinCount

      if (!timeBuf || timeBuf.length !== bufLen) timeBuf = new Float32Array(bufLen)
      if (!freqBuf || freqBuf.length !== bufLen) freqBuf = new Uint8Array(bufLen)

      analyserNode.getFloatTimeDomainData(timeBuf)
      analyserNode.getByteFrequencyData(freqBuf)

      drawBackground()

      // Frequency bars (bottom 35%)
      const barW = W / 128
      const specH = H * 0.35
      for (let i = 0; i < 128; i++) {
        const v = freqBuf[i] / 255
        const bh = v * specH
        ctx.fillStyle = `${color}${Math.round((0.25 + v * 0.55) * 255).toString(16).padStart(2, '0')}`
        ctx.fillRect(i * barW, H - bh, barW - 0.5, bh)
      }

      // Time-domain waveform
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.shadowColor = color
      ctx.shadowBlur = 6
      ctx.beginPath()
      const step = W / bufLen
      for (let i = 0; i < bufLen; i++) {
        const x = i * step
        const y = mid - timeBuf[i] * mid * 0.8
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.shadowBlur = 0

      rafRef.current = requestAnimationFrame(drawLive)
    }

    function drawStatic() {
      drawBackground()
      const data = staticDataRef.current
      if (!data) { drawIdle(); return }

      // Draw full waveform
      const step = Math.floor(data.length / W)
      ctx.strokeStyle = `${color}70`
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x < W; x++) {
        const i = x * step
        const v = data[i] || 0
        const y = mid - v * mid * 0.85
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Played portion (brighter)
      const playX = duration > 0 ? (currentTime / duration) * W : 0
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, playX, H)
      ctx.clip()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let x = 0; x < W; x++) {
        const i = x * step
        const v = data[i] || 0
        const y = mid - v * mid * 0.85
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()

      // Playhead
      if (playX > 0) {
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 1.5
        ctx.globalAlpha = 0.8
        ctx.beginPath()
        ctx.moveTo(playX, 0); ctx.lineTo(playX, H)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }

    if (isActive && analyserNode) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(drawLive)
    } else if (audioBlob) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      drawStatic()
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      drawIdle()
    }

    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [analyserNode, isActive, audioBlob, currentTime, duration, color])

  return (
    <div className="waveform-wrap">
      <canvas
        ref={canvasRef}
        width={1040}
        height={88}
        style={{ width: '100%', height: '88px', display: 'block' }}
      />
      {label && <div className="waveform-label">{label}</div>}
    </div>
  )
}
