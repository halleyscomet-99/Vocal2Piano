// Live singing pitch (YIN) and vocal-range → key suggestion.

/** YIN pitch estimate in Hz, or null when unvoiced/unclear. */
export function yin(buf: Float32Array, sampleRate: number, threshold = 0.12): number | null {
  const maxLag = Math.min(Math.floor(sampleRate / 65), Math.floor(buf.length / 2)); // down to ~C2
  const minLag = Math.floor(sampleRate / 1100);
  const W = buf.length - maxLag;
  const d = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const diff = buf[i] - buf[i + lag];
      s += diff * diff;
    }
    d[lag] = s;
  }
  // Cumulative mean normalized difference
  let run = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    run += d[lag];
    d[lag] = (d[lag] * lag) / (run || 1);
  }
  for (let lag = minLag; lag < maxLag; lag++) {
    if (d[lag] < threshold) {
      while (lag + 1 < maxLag && d[lag + 1] < d[lag]) lag++;
      const a = d[lag - 1];
      const b = d[lag];
      const c = d[lag + 1];
      const den = a - 2 * b + c;
      const exact = lag + (den !== 0 ? (0.5 * (a - c)) / den : 0);
      return sampleRate / exact;
    }
  }
  return null;
}

export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);

export interface VoiceProfile {
  low: number; // MIDI, comfortable bottom (10th percentile)
  high: number; // comfortable top (90th percentile)
  center: number; // median
  samples: number;
}

export function profileFrom(pitches: number[]): VoiceProfile | null {
  if (pitches.length < 20) return null;
  const s = [...pitches].sort((a, b) => a - b);
  const q = (k: number) => s[Math.min(s.length - 1, Math.floor(k * s.length))];
  return { low: Math.round(q(0.1)), high: Math.round(q(0.9)), center: Math.round(q(0.5)), samples: s.length };
}

/** Wrap a shift into −6..+5 semitones (the piano part can always move an octave). */
const wrap = (n: number) => ((((n + 6) % 12) + 12) % 12) - 6;

/**
 * Transpose that fits a song to the singer.
 * With a melody (MIDI skyline), match its median to the singer's median.
 * With only a key (chord charts), place the tonic about a fourth above the singer's low note,
 * where typical pop melodies sit.
 */
export function suggestTranspose(p: VoiceProfile, ref: { melodyCenter?: number; tonic?: number }): number {
  if (ref.melodyCenter !== undefined) return wrap(p.center - ref.melodyCenter);
  const idealTonic = p.low + 5;
  return wrap(idealTonic - (ref.tonic ?? 0));
}

/** Median of the top line above the hand split: a rough stand-in for the melody. */
export function melodyCenter(notes: { midi: number; time: number }[], split: number): number | undefined {
  const top = new Map<number, number>();
  for (const n of notes) {
    if (n.midi < split) continue;
    const t = Math.round(n.time * 20);
    top.set(t, Math.max(top.get(t) ?? 0, n.midi));
  }
  const s = [...top.values()].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
}

export interface PitchFrame {
  t: number; // s from the start of the samples (window centre)
  midi: number | null; // fractional MIDI pitch, null when unvoiced
  rms: number;
  /** Level over a short window at the frame centre: shows the dips between repeated notes. */
  short: number;
}

/**
 * Offline pitch track of a recording. Downsamples to ~16 kHz first so YIN stays fast,
 * and gates out frames much quieter than the singing itself.
 */
export function pitchFrames(samples: Float32Array, sampleRate: number, hop = 0.02): PitchFrame[] {
  const f = Math.max(1, Math.round(sampleRate / 16000));
  const sr = sampleRate / f;
  const x = new Float32Array(Math.floor(samples.length / f));
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) s += samples[i * f + k];
    x[i] = s / f;
  }
  const N = 1024;
  const step = Math.max(1, Math.round(hop * sr));
  const frames: PitchFrame[] = [];
  for (let i = 0; i + N <= x.length; i += step) {
    const w = x.subarray(i, i + N);
    let e = 0;
    let c = 0;
    for (let k = 0; k < N; k++) {
      e += w[k] * w[k];
      if (k >= N / 2 - 128 && k < N / 2 + 128) c += w[k] * w[k];
    }
    frames.push({ t: (i + N / 2) / sr, midi: null, rms: Math.sqrt(e / N), short: Math.sqrt(c / 256) });
  }
  const loud = frames.map((fr) => fr.rms).sort((a, b) => a - b);
  const gate = Math.max(0.006, 0.12 * (loud[Math.floor(loud.length * 0.9)] ?? 0));
  for (const fr of frames) {
    if (fr.rms < gate) continue;
    const i = Math.round(fr.t * sr - N / 2);
    const hz = yin(x.subarray(i, i + N), sr, 0.15);
    if (hz && hz > 70 && hz < 1100) fr.midi = hzToMidi(hz);
  }
  return frames;
}

/** Signed distance between two pitches ignoring octaves, in semitones (−6..6). */
export const pcDiff = (a: number, b: number) => ((((a - b + 6) % 12) + 12) % 12) - 6;
