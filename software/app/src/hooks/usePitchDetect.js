/**
 * usePitchDetect.js  v3.1
 * ----------------------
 * Fixed: `onChordNotes` undefined reference in ws.onmessage
 * Added: chordMidis state, returned from hook
 * Added: chordMidis cleared on stop/silence
 */

import { useRef, useState, useCallback, useEffect } from 'react'

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
const WS_URL = 'ws://localhost:8765'
const WS_TIMEOUT_MS = 1500

function midiToInfo(midi) {
  if (midi < 0 || midi > 127) return null
  const n = midi % 12
  const oct = Math.floor(midi / 12) - 1
  return { midi, note: NOTE_NAMES[n], name: `${NOTE_NAMES[n]}${oct}`, octave: oct }
}

function freqToMidi(freq) {
  if (freq <= 0) return -1
  return Math.round(12 * Math.log2(freq / 440) + 69)
}

function detectPitch(buf, sr, mode) {
  const SIZE = buf.length
  const MAX_LAG = Math.floor(SIZE / 2)
  const MIN_LAG = Math.floor(sr / 2000)
  const MAX_LAG_PITCH = Math.floor(sr / 60)

  let rms = 0
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i]
  rms = Math.sqrt(rms / SIZE)
  if (rms < 0.015) return -1

  const d = new Float32Array(MAX_LAG)
  for (let tau = 1; tau < MAX_LAG; tau++) {
    let s = 0
    for (let i = 0; i < MAX_LAG; i++) {
      const diff = buf[i] - buf[i + tau]
      s += diff * diff
    }
    d[tau] = s
  }

  const cmnd = new Float32Array(MAX_LAG)
  cmnd[0] = 1
  let runSum = 0
  for (let tau = 1; tau < MAX_LAG; tau++) {
    runSum += d[tau]
    cmnd[tau] = runSum > 0 ? (d[tau] * tau) / runSum : 1
  }

  const threshold = mode === 'voice' ? 0.12 : 0.10
  let tau = -1
  for (let t = MIN_LAG; t < Math.min(MAX_LAG_PITCH, MAX_LAG - 2); t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 < MAX_LAG - 1 && cmnd[t + 1] < cmnd[t]) t++
      tau = t
      break
    }
  }
  if (tau < 0) return -1

  const x0 = tau > 0 ? cmnd[tau - 1] : cmnd[tau]
  const x2 = tau < MAX_LAG - 1 ? cmnd[tau + 1] : cmnd[tau]
  const betterTau = tau + (x2 - x0) / (2 * (2 * cmnd[tau] - x2 - x0) + 1e-10)
  return sr / betterTau
}

export function usePitchDetect(inputMode = 'instrument') {
  const [currentNote, setCurrentNote] = useState(null)
  const [isListening, setIsListening] = useState(false)
  const [noteHistory, setNoteHistory] = useState([])
  const [chordMidis, setChordMidis] = useState([])   // ← polyphonic chord notes
  const [analyserNode, setAnalyserNode] = useState(null)
  const [sourceMode, setSourceMode] = useState('browser')

  const audioCtxRef    = useRef(null)
  const analyserRef    = useRef(null)
  const micStreamRef   = useRef(null)
  const mediaRecRef    = useRef(null)
  const rafRef         = useRef(null)
  const bufRef         = useRef(null)
  const wsRef          = useRef(null)
  const audioChunksRef = useRef([])

  const noiseFloorRef     = useRef(0.015)
  const rmsHistoryRef     = useRef([])
  const candidateNoteRef  = useRef(-1)
  const candidateCountRef = useRef(0)
  const STABILITY_FRAMES  = inputMode === 'voice' ? 4 : 2
  const midiHistoryRef    = useRef([])
  const MIDI_HISTORY      = inputMode === 'voice' ? 5 : 3
  const lastMidiRef       = useRef(-1)
  const noteOnsetRef      = useRef(null)
  const startTimeRef      = useRef(null)
  const recordedRef       = useRef([])

  const updateNoiseFloor = useCallback((rms) => {
    const h = rmsHistoryRef.current
    h.push(rms)
    if (h.length > 40) h.shift()
    const sorted = [...h].sort((a, b) => a - b)
    const p20 = sorted[Math.floor(sorted.length * 0.2)]
    noiseFloorRef.current = Math.max(0.012, p20 * 2.0)
  }, [])

  const handleNoteEvent = useCallback((midi, freq, conf) => {
    if (!audioCtxRef.current) return
    const now = audioCtxRef.current.currentTime

    if (midi >= 21 && midi <= 108) {
      const info = midiToInfo(midi)
      setCurrentNote({ ...info, freq, conf })

      if (midi !== lastMidiRef.current) {
        if (lastMidiRef.current >= 0 && noteOnsetRef.current !== null) {
          const dur = now - noteOnsetRef.current
          if (dur > 0.05) {
            recordedRef.current.push({
              midi: lastMidiRef.current,
              time: noteOnsetRef.current - (startTimeRef.current || 0),
              duration: dur,
            })
            const i = midiToInfo(lastMidiRef.current)
            if (i) setNoteHistory(prev => [...prev.slice(-59), { ...i, id: Date.now() }])
          }
        }
        lastMidiRef.current = midi
        noteOnsetRef.current = now
      }
    } else {
      setCurrentNote(null)
      if (lastMidiRef.current >= 0 && noteOnsetRef.current !== null) {
        const dur = now - noteOnsetRef.current
        if (dur > 0.05) {
          recordedRef.current.push({
            midi: lastMidiRef.current,
            time: noteOnsetRef.current - (startTimeRef.current || 0),
            duration: dur,
          })
          const i = midiToInfo(lastMidiRef.current)
          if (i) setNoteHistory(prev => [...prev.slice(-59), { ...i, id: Date.now() }])
        }
        lastMidiRef.current = -1
        noteOnsetRef.current = null
      }
    }
  }, [])

  const detectLoop = useCallback(() => {
    if (!analyserRef.current || !audioCtxRef.current) return

    analyserRef.current.getFloatTimeDomainData(bufRef.current)
    const buf = bufRef.current

    let rms = 0
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i]
    rms = Math.sqrt(rms / buf.length)

    updateNoiseFloor(rms)

    if (rms < noiseFloorRef.current) {
      candidateNoteRef.current = -1
      candidateCountRef.current = 0
      setChordMidis([])
      handleNoteEvent(-1, 0, 0)
      rafRef.current = requestAnimationFrame(detectLoop)
      return
    }

    const freq = detectPitch(buf, audioCtxRef.current.sampleRate, inputMode)
    const midi = freq > 0 ? freqToMidi(freq) : -1

    if (midi >= 21 && midi <= 108) {
      if (midi === candidateNoteRef.current) {
        candidateCountRef.current++
      } else {
        candidateNoteRef.current = midi
        candidateCountRef.current = 1
      }
      if (candidateCountRef.current >= STABILITY_FRAMES) {
        midiHistoryRef.current.push(midi)
        if (midiHistoryRef.current.length > MIDI_HISTORY) midiHistoryRef.current.shift()
        const sorted = [...midiHistoryRef.current].sort((a, b) => a - b)
        const medianMidi = sorted[Math.floor(sorted.length / 2)]
        handleNoteEvent(medianMidi, freq, 0.7)
      }
    } else {
      candidateNoteRef.current = -1
      candidateCountRef.current = 0
      midiHistoryRef.current = []
      setChordMidis([])
      handleNoteEvent(-1, 0, 0)
    }

    rafRef.current = requestAnimationFrame(detectLoop)
  }, [inputMode, updateNoiseFloor, handleNoteEvent, STABILITY_FRAMES, MIDI_HISTORY])

  const tryWebSocket = useCallback(() => {
    return new Promise(resolve => {
      const ws = new WebSocket(WS_URL)
      const timer = setTimeout(() => { ws.close(); resolve(false) }, WS_TIMEOUT_MS)

      ws.onopen = () => {
        clearTimeout(timer)
        wsRef.current = ws
        setSourceMode('python')
        resolve(true)
      }

      ws.onmessage = e => {
        try {
          const d = JSON.parse(e.data)
          // FIX: was `if (onChordNotes)` which is undefined -- now uses setChordMidis directly
          const chordNotes = d.chord_notes || []
          setChordMidis(chordNotes.map(n => n.midi))
          handleNoteEvent(d.midi ?? -1, d.freq ?? 0, d.conf ?? 0)
        } catch {}
      }

      ws.onerror = () => { clearTimeout(timer); resolve(false) }

      ws.onclose = () => {
        wsRef.current = null
        setSourceMode('browser')
        setChordMidis([])
        if (analyserRef.current) {
          rafRef.current = requestAnimationFrame(detectLoop)
        }
      }
    })
  }, [handleNoteEvent, detectLoop])

  useEffect(() => {
    candidateNoteRef.current = -1
    candidateCountRef.current = 0
    midiHistoryRef.current = []
    setChordMidis([])
  }, [inputMode])

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          sampleRate: 44100,
        },
        video: false,
      })
      micStreamRef.current = stream

      const ctx = new AudioContext({ sampleRate: 44100 })
      audioCtxRef.current = ctx

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 4096
      analyserRef.current = analyser
      bufRef.current = new Float32Array(analyser.fftSize)
      ctx.createMediaStreamSource(stream).connect(analyser)

      audioChunksRef.current = []
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm'
      const rec = new MediaRecorder(stream, { mimeType })
      rec.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      rec.start(100)
      mediaRecRef.current = rec

      recordedRef.current = []
      lastMidiRef.current = -1
      noteOnsetRef.current = null
      startTimeRef.current = ctx.currentTime
      rmsHistoryRef.current = []
      candidateNoteRef.current = -1
      candidateCountRef.current = 0
      midiHistoryRef.current = []
      setNoteHistory([])
      setChordMidis([])
      setIsListening(true)
      setAnalyserNode(analyser)

      const wsOk = await tryWebSocket()
      if (!wsOk) {
        setSourceMode('browser')
        rafRef.current = requestAnimationFrame(detectLoop)
      }
    } catch (err) {
      alert(`Microphone error: ${err.message}`)
    }
  }, [tryWebSocket, detectLoop])

  const stop = useCallback(() => new Promise(resolve => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }

    const notes = [...recordedRef.current]
    recordedRef.current = []

    const rec = mediaRecRef.current
    const finish = (audioBlob) => {
      if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop())
      if (audioCtxRef.current) audioCtxRef.current.close()
      setIsListening(false)
      setCurrentNote(null)
      setAnalyserNode(null)
      setChordMidis([])
      resolve({ notes, audioBlob })
    }

    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => {
        const mime = rec.mimeType || 'audio/webm'
        const blob = audioChunksRef.current.length > 0
          ? new Blob(audioChunksRef.current, { type: mime }) : null
        audioChunksRef.current = []
        finish(blob)
      }
      rec.stop()
    } else {
      finish(null)
    }
  }), [])

  return {
    currentNote, isListening, noteHistory,
    chordMidis,    // ← new: array of MIDI notes for polyphonic chord display
    analyserNode, sourceMode, start, stop,
  }
}
