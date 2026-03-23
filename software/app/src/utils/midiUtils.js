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
const PPQ = 480 // pulses per quarter note (standard MIDI resolution)

/**
 * Convert an array of note events to a MIDI file blob.
 *
 * @param {Array} notes - Array of { midi, time, duration } in seconds
 * @param {number} bpm  - Tempo for the MIDI file (default 120)
 * @returns {Blob}      - MIDI file as a Blob (type 'audio/midi')
 */
export function notesToMidiBlob(notes, bpm = BPM) {
  const midi = new Midi()
  midi.header.setTempo(bpm)
  midi.header.ppq = PPQ

  const track = midi.addTrack()
  track.name = 'Voice2Piano'

  for (const n of notes) {
    if (n.midi < 0 || n.duration < 0.04) continue
    track.addNote({
      midi: n.midi,
      time: n.time,       // seconds from start
      duration: n.duration,
      velocity: 0.65,
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
        midi: n.midi,
        time: n.time,
        duration: n.duration,
        velocity: n.velocity,
      })
    }
  }
  return notes.sort((a, b) => a.time - b.time)
}

/**
 * Play MIDI notes through Tone.js synth.
 * Returns a cancel function.
 *
 * @param {Array}    notes       - Array of { midi, time, duration }
 * @param {Function} onNote      - Called on each note: (midi, time) => void
 * @param {Function} onComplete  - Called when playback ends
 * @returns {Function}           - Cancel function
 */
export async function playMidiNotes(notes, onNote, onComplete) {
  await Tone.start()
  Tone.Transport.stop()
  Tone.Transport.cancel()

  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.8 },
    volume: -12,
  }).toDestination()

  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

  let cancelled = false
  const endTime = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0)

  for (const n of notes) {
    if (n.midi < 21 || n.midi > 108) continue
    const noteInOctave = n.midi % 12
    const octave = Math.floor(n.midi / 12) - 1
    const noteName = `${NOTE_NAMES[noteInOctave]}${octave}`

    Tone.Transport.schedule((time) => {
      if (cancelled) return
      synth.triggerAttackRelease(noteName, n.duration, time, n.velocity || 0.65)
      Tone.getDraw().schedule(() => {
        if (!cancelled && onNote) onNote(n.midi, n.time)
      }, time)
    }, n.time)
  }

  Tone.Transport.schedule(() => {
    if (!cancelled && onComplete) onComplete()
  }, endTime + 0.5)

  Tone.Transport.start()

  return () => {
    cancelled = true
    Tone.Transport.stop()
    Tone.Transport.cancel()
    synth.dispose()
  }
}
