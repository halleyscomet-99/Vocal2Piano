/**
 * midiUtils.js
 * ------------
 * Utilities for creating MIDI files from detected note events
 * and playing them back with Tone.js.
 *
 * Uses @tonejs/midi for MIDI file encoding/decoding and
 * Tone.js for scheduling note playback through the Web Audio API.
 */

import { Midi } from '@tonejs/midi'
import * as Tone from 'tone'

const BPM = 120

/**
 * Convert an array of note events to a MIDI file blob.
 * NOTE: ppq is read-only in newer @tonejs/midi — do NOT set it directly.
 *
 * @param {Array}  notes - Array of { midi, time, duration } in seconds
 * @param {number} bpm   - Tempo for the MIDI file (default 120)
 * @returns {Blob}       - MIDI file as a Blob (type 'audio/midi')
 */
export function notesToMidiBlob(notes, bpm = BPM) {
  const midi = new Midi()
  midi.header.setTempo(bpm)
  // ppq is read-only — do not assign, default (480) is fine

  const track = midi.addTrack()
  track.name = 'Voice2Piano'

  for (const n of notes) {
    if (n.midi < 0 || n.duration < 0.04) continue
    track.addNote({
      midi:     n.midi,
      time:     n.time,
      duration: n.duration,
      velocity: n.velocity != null ? n.velocity / 127 : 0.65,
    })
  }

  const arr = midi.toArray()
  return new Blob([arr], { type: 'audio/midi' })
}

/**
 * Trigger a browser download of a MIDI file.
 *
 * @param {Blob}   blob     - MIDI blob from notesToMidiBlob()
 * @param {string} filename - Suggested filename
 */
export function downloadMidi(blob, filename = 'voice2piano.mid') {
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Parse a MIDI Blob or ArrayBuffer and extract note events.
 *
 * @param {Blob|ArrayBuffer} source
 * @returns {Promise<Array>} Array of { midi, time, duration, velocity }
 */
export async function parseMidiNotes(source) {
  let buf
  if (source instanceof Blob) {
    buf = await source.arrayBuffer()
  } else {
    buf = source
  }
  const midi = new Midi(buf)
  const notes = []
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        midi:     n.midi,
        time:     n.time,
        duration: n.duration,
        velocity: Math.round((n.velocity || 0.65) * 127),
      })
    }
  }
  return notes.sort((a, b) => a.time - b.time)
}

/**
 * Play MIDI notes through Tone.js synth.
 * Returns a cancel function.
 *
 * @param {Array}    notes      - Array of { midi, time, duration, velocity }
 * @param {Function} onNote     - Called on each note: (midi) => void
 * @param {Function} onComplete - Called when playback ends
 * @returns {Function}          - Cancel function
 */
export async function playMidiNotes(notes, onNote, onComplete, volume = 0.65) {
  await Tone.start()
  Tone.getTransport().stop()
  Tone.getTransport().cancel()

  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope:   { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.8 },
    volume:     Math.round(20 * Math.log10(Math.max(0.001, volume))),
  }).toDestination()

  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

  let cancelled = false
  const endTime = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0)

  for (const n of notes) {
    if (n.midi < 21 || n.midi > 108) continue
    const octave   = Math.floor(n.midi / 12) - 1
    const noteName = `${NOTE_NAMES[n.midi % 12]}${octave}`
    const vel      = n.velocity != null ? n.velocity / 127 : 0.65

    Tone.getTransport().schedule((time) => {
      if (cancelled) return
      synth.triggerAttackRelease(noteName, n.duration, time, vel)
      Tone.getDraw().schedule(() => {
        if (!cancelled && onNote) onNote(n.midi)
      }, time)
    }, n.time)
  }

  Tone.getTransport().schedule(() => {
    if (!cancelled && onComplete) onComplete()
  }, endTime + 0.5)

  Tone.getTransport().start()

  return () => {
    cancelled = true
    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    synth.dispose()
  }
}