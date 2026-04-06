/**
 * usePitchDetect.js
 * ------------------
 * Real-time pitch detection + actual audio recording.
 *
 * Uses two parallel systems:
 *   1. Web Audio API AnalyserNode  → pitch detection every frame
 *   2. MediaRecorder                → captures raw audio as a Blob
 *
 * When stop() is called it returns both the recorded audio blob
 * (for waveform display and playback) and the array of MIDI note
 * events (for MIDI file export and piano animation).
 *
 * Returns
 * -------
 * currentNote   { midi, name, note, octave, freq } | null
 * isListening   boolean
 * noteHistory   Array (last 60 detected notes, for history strip)
 * analyserNode  AnalyserNode | null  (for live Waveform)
 * start()       → void
 * stop()        → { notes: NoteEvent[], audioBlob: Blob | null }
 */

import { useRef, useState, useCallback } from 'react'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function freqToMidi(freq) {
  if (freq <= 0) return -1
  return Math.round(12 * Math.log2(freq / 440) + 69)
}

function midiToInfo(midi) {
  if (midi < 0 || midi > 127) return null
  const n = midi % 12
  const oct = Math.floor(midi / 12) - 1
  return { midi, note: NOTE_NAMES[n], name: `${NOTE_NAMES[n]}${oct}`, octave: oct }
}

/** Autocorrelation pitch estimator (same as Chrome Music Lab). */
function autoCorrelate(buf, sr) {
  const SIZE = buf.length
  const MAX = Math.floor(SIZE / 2)
  let rms = 0
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i]
  if (Math.sqrt(rms / SIZE) < 0.008) return -1

  let best = -1, bestCorr = 0, lastCorr = 1, found = false
  for (let offset = 1; offset < MAX; offset++) {
    let corr = 0
    for (let i = 0; i < MAX; i++) corr += Math.abs(buf[i] - buf[i + offset])
    corr = 1 - corr / MAX
    if (corr > 0.9 && corr > lastCorr) {
      found = true
      if (corr > bestCorr) { bestCorr = corr; best = offset }
    } else if (found) break
    lastCorr = corr
  }
  return best === -1 ? -1 : sr / best
}

export function usePitchDetect() {
  const [currentNote, setCurrentNote] = useState(null)
  const [isListening, setIsListening] = useState(false)
  const [noteHistory, setNoteHistory] = useState([])
  const [analyserNode, setAnalyserNode] = useState(null)

  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const micStreamRef = useRef(null)
  const mediaRecRef = useRef(null)   // MediaRecorder for audio capture
  const rafRef = useRef(null)
  const bufRef = useRef(null)
  const audioChunksRef = useRef([])  // raw audio chunks

  const lastMidiRef = useRef(-1)
  const noteOnsetRef = useRef(null)
  const startTimeRef = useRef(null)
  const recordedRef = useRef([])

  const detect = useCallback(() => {
    if (!analyserRef.current) return
    analyserRef.current.getFloatTimeDomainData(bufRef.current)
    const freq = autoCorrelate(bufRef.current, audioCtxRef.current.sampleRate)
    const now = audioCtxRef.current.currentTime

    if (freq > 0) {
      const midi = freqToMidi(freq)
      if (midi >= 21 && midi <= 108) {
        const info = midiToInfo(midi)
        setCurrentNote({ ...info, freq })

        if (midi !== lastMidiRef.current) {
          if (lastMidiRef.current >= 0 && noteOnsetRef.current !== null) {
            const dur = now - noteOnsetRef.current
            if (dur > 0.04) {
              recordedRef.current.push({
                midi: lastMidiRef.current,
                time: noteOnsetRef.current - startTimeRef.current,
                duration: dur,
              })
              const i = midiToInfo(lastMidiRef.current)
              setNoteHistory(prev => [...prev.slice(-59), { ...i, id: Date.now() }])
            }
          }
          lastMidiRef.current = midi
          noteOnsetRef.current = now
        }
      }
    } else {
      setCurrentNote(null)
      if (lastMidiRef.current >= 0 && noteOnsetRef.current !== null) {
        const dur = now - noteOnsetRef.current
        if (dur > 0.04) {
          recordedRef.current.push({
            midi: lastMidiRef.current,
            time: noteOnsetRef.current - startTimeRef.current,
            duration: dur,
          })
          const i = midiToInfo(lastMidiRef.current)
          setNoteHistory(prev => [...prev.slice(-59), { ...i, id: Date.now() }])
        }
        lastMidiRef.current = -1
        noteOnsetRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(detect)
  }, [])

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true, video: false,
      })
      micStreamRef.current = stream

      // Web Audio for pitch detection
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyserRef.current = analyser
      bufRef.current = new Float32Array(analyser.fftSize)
      ctx.createMediaStreamSource(stream).connect(analyser)

      // MediaRecorder for audio capture
      audioChunksRef.current = []
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const rec = new MediaRecorder(stream, { mimeType })
      rec.ondataavailable = e => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      rec.start(100)  // collect in 100ms chunks
      mediaRecRef.current = rec

      recordedRef.current = []
      lastMidiRef.current = -1
      noteOnsetRef.current = null
      startTimeRef.current = ctx.currentTime
      setNoteHistory([])
      setIsListening(true)
      setAnalyserNode(analyser)

      rafRef.current = requestAnimationFrame(detect)
    } catch (err) {
      alert(`Microphone access denied: ${err.message}`)
    }
  }, [detect])

  /**
   * Stop recording.
   * @returns {Promise<{notes: NoteEvent[], audioBlob: Blob|null}>}
   */
  const stop = useCallback(() => {
    return new Promise(resolve => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)

      const notes = [...recordedRef.current]
      recordedRef.current = []

      // Stop MediaRecorder and collect remaining chunks
      const rec = mediaRecRef.current
      if (rec && rec.state !== 'inactive') {
        rec.onstop = () => {
          const mimeType = rec.mimeType || 'audio/webm'
          const audioBlob = audioChunksRef.current.length > 0
            ? new Blob(audioChunksRef.current, { type: mimeType })
            : null
          audioChunksRef.current = []

          if (micStreamRef.current) {
            micStreamRef.current.getTracks().forEach(t => t.stop())
          }
          if (audioCtxRef.current) audioCtxRef.current.close()

          setIsListening(false)
          setCurrentNote(null)
          setAnalyserNode(null)

          resolve({ notes, audioBlob })
        }
        rec.stop()
      } else {
        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach(t => t.stop())
        }
        if (audioCtxRef.current) audioCtxRef.current.close()
        setIsListening(false)
        setCurrentNote(null)
        setAnalyserNode(null)
        resolve({ notes, audioBlob: null })
      }
    })
  }, [])

  return { currentNote, isListening, noteHistory, analyserNode, start, stop }
}
