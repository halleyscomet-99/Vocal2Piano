/**
 * usePitchDetect.js
 * -----------------
 * Real-time pitch detection using the Web Audio API and an
 * autocorrelation algorithm (similar to Chrome Music Lab Spectrogram).
 *
 * Detects the fundamental frequency of the microphone input every
 * animation frame, converts it to a MIDI note number, and records
 * note events (onset time + duration) for MIDI file export.
 *
 * Returns:
 *   currentNote  - { midi, name, note, octave, freq } or null
 *   isListening  - boolean
 *   noteHistory  - array of last 60 detected notes (for history view)
 *   start()      - open mic, begin detection
 *   stop()       - close mic, return recorded note array
 */

import { useRef, useState, useCallback } from 'react'

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

/** Convert Hz to MIDI note number (equal temperament, A4=440) */
function freqToMidi(freq) {
  if (freq <= 0) return -1
  return Math.round(12 * Math.log2(freq / 440) + 69)
}

/** Return note name info for a MIDI number */
function midiToInfo(midi) {
  if (midi < 0 || midi > 127) return null
  const noteInOctave = midi % 12
  const octave = Math.floor(midi / 12) - 1
  return {
    midi,
    note: NOTE_NAMES[noteInOctave],
    name: `${NOTE_NAMES[noteInOctave]}${octave}`,
    octave,
  }
}

/**
 * Autocorrelation-based pitch estimator.
 * Works by finding the lag (offset) at which the signal best correlates
 * with a delayed copy of itself -- that lag is the period of the wave.
 *
 * Returns frequency in Hz, or -1 if no pitch detected.
 */
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length
  const MAX_SAMPLES = Math.floor(SIZE / 2)

  // RMS check -- ignore silent frames
  let rms = 0
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i]
  rms = Math.sqrt(rms / SIZE)
  if (rms < 0.008) return -1

  let bestOffset = -1
  let bestCorrelation = 0
  let lastCorrelation = 1
  let foundGood = false

  for (let offset = 1; offset < MAX_SAMPLES; offset++) {
    let correlation = 0
    for (let i = 0; i < MAX_SAMPLES; i++) {
      correlation += Math.abs(buf[i] - buf[i + offset])
    }
    correlation = 1 - correlation / MAX_SAMPLES

    if (correlation > 0.9 && correlation > lastCorrelation) {
      foundGood = true
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestOffset = offset
      }
    } else if (foundGood) {
      break // Peak found and passed; stop early
    }
    lastCorrelation = correlation
  }

  if (bestOffset === -1) return -1
  return sampleRate / bestOffset
}

export function usePitchDetect() {
  const [currentNote, setCurrentNote] = useState(null)
  const [isListening, setIsListening] = useState(false)
  const [noteHistory, setNoteHistory] = useState([]) // last N notes for display

  // Refs for audio objects (not state -- we don't want re-renders)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const micStreamRef = useRef(null)
  const rafRef = useRef(null)
  const bufRef = useRef(null)

  // Pitch tracking state (also refs to avoid stale closures in rAF)
  const lastMidiRef = useRef(-1)
  const noteOnsetRef = useRef(null) // AudioContext time of note start
  const startTimeRef = useRef(null) // AudioContext time when recording began
  const recordedRef = useRef([])    // { midi, time, duration } tuples

  /** Called every animation frame -- reads analyser, detects pitch */
  const detect = useCallback(() => {
    if (!analyserRef.current) return
    analyserRef.current.getFloatTimeDomainData(bufRef.current)
    const freq = autoCorrelate(bufRef.current, audioCtxRef.current.sampleRate)
    const now = audioCtxRef.current.currentTime

    if (freq > 0) {
      const midi = freqToMidi(freq)
      // Restrict to standard piano range A0-C8 (MIDI 21-108)
      if (midi >= 21 && midi <= 108) {
        const info = midiToInfo(midi)
        setCurrentNote({ ...info, freq })

        if (midi !== lastMidiRef.current) {
          // Note changed: close previous note
          if (lastMidiRef.current >= 0 && noteOnsetRef.current !== null) {
            const dur = now - noteOnsetRef.current
            if (dur > 0.04) {
              // Only record notes longer than 40 ms (filter blips)
              const noteEvent = {
                midi: lastMidiRef.current,
                time: noteOnsetRef.current - startTimeRef.current,
                duration: dur,
              }
              recordedRef.current.push(noteEvent)
              setNoteHistory(prev => {
                const info = midiToInfo(lastMidiRef.current)
                return [...prev.slice(-59), { ...info, id: Date.now() }]
              })
            }
          }
          lastMidiRef.current = midi
          noteOnsetRef.current = now
        }
      }
    } else {
      // Silence: close any open note
      setCurrentNote(null)
      if (lastMidiRef.current >= 0 && noteOnsetRef.current !== null) {
        const dur = now - noteOnsetRef.current
        if (dur > 0.04) {
          recordedRef.current.push({
            midi: lastMidiRef.current,
            time: noteOnsetRef.current - startTimeRef.current,
            duration: dur,
          })
          setNoteHistory(prev => {
            const info = midiToInfo(lastMidiRef.current)
            return [...prev.slice(-59), { ...info, id: Date.now() }]
          })
        }
        lastMidiRef.current = -1
        noteOnsetRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(detect)
  }, [])

  /** Open microphone and begin pitch detection */
  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      micStreamRef.current = stream

      const ctx = new AudioContext()
      audioCtxRef.current = ctx

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyserRef.current = analyser
      bufRef.current = new Float32Array(analyser.fftSize)

      const source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)

      // Reset recording state
      recordedRef.current = []
      lastMidiRef.current = -1
      noteOnsetRef.current = null
      startTimeRef.current = ctx.currentTime
      setNoteHistory([])
      setIsListening(true)

      rafRef.current = requestAnimationFrame(detect)
    } catch (err) {
      alert(`Microphone access denied: ${err.message}`)
    }
  }, [detect])

  /**
   * Stop pitch detection and return recorded notes.
   * @returns {Array} Array of { midi, time, duration } objects
   */
  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop())
    if (audioCtxRef.current) audioCtxRef.current.close()

    setIsListening(false)
    setCurrentNote(null)

    // Close any note that was still held
    const notes = [...recordedRef.current]
    recordedRef.current = []
    return notes
  }, [])

  return { currentNote, isListening, noteHistory, start, stop }
}
