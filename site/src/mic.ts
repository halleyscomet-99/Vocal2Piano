// One microphone helper for everything that listens: range measuring, takes,
// humming and the listening piano.

import { hzToMidi, yin } from "./engine/voice";

const CHUNK = 1024;

export interface Capture {
  samples: Float32Array;
  sampleRate: number;
  /** Clock time (whatever `clock` returned) of the first sample. */
  t0: number;
}

export interface Mic {
  ctx: AudioContext;
  /** Calls `fn` every `ms` with the live pitch (fractional MIDI or null) and level (0..1). Returns a stop function. */
  pitch(fn: (midi: number | null, level: number) => void, ms?: number): () => void;
  /** Starts raw capture. `clock` timestamps the first sample (defaults to this context's clock). */
  record(clock?: () => number): () => Capture;
  close(): void;
}

export class MicBlockedError extends Error {
  constructor() {
    super("Microphone access was blocked. Allow it in the browser's address bar and try again.");
  }
}

/**
 * @param echoCancellation on when the piano is playing through speakers at the same time,
 *   so it doesn't leak into what we hear
 */
export async function openMic(echoCancellation: boolean): Promise<Mic> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation, noiseSuppression: false, autoGainControl: false } });
  } catch {
    throw new MicBlockedError();
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const stops = new Set<() => void>();

  return {
    ctx,
    pitch(fn, ms = 40) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const id = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        const hz = rms > 0.012 ? yin(buf, ctx.sampleRate) : null;
        fn(hz && hz > 65 && hz < 1100 ? hzToMidi(hz) : null, Math.min(1, rms * 8));
      }, ms);
      const stop = () => {
        clearInterval(id);
        analyser.disconnect();
        stops.delete(stop);
      };
      stops.add(stop);
      return stop;
    },
    record(clock = () => ctx.currentTime) {
      const chunks: Float32Array[] = [];
      let start: number | null = null; // the first sample, on this context's clock
      let offset = 0; // clock() minus this context's clock
      let got = 0;
      const proc = ctx.createScriptProcessor(CHUNK, 1, 1);
      // Each chunk ends roughly now, so the first sample was `got` samples (plus input latency)
      // earlier. Callbacks are only ever late (a busy page), never early, so the earliest guess
      // wins. That's measured on this context's clock, which never stops; `clock` may (Listen).
      proc.onaudioprocess = (e) => {
        if (start === null) offset = clock() - ctx.currentTime;
        got += CHUNK;
        const guess = ctx.currentTime - got / ctx.sampleRate - (ctx.baseLatency || 0) - 0.01;
        start = start === null ? guess : Math.min(start, guess);
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(proc);
      proc.connect(ctx.destination); // outputs silence; needed for the callback to run
      const stop = () => {
        proc.onaudioprocess = null;
        proc.disconnect();
        stops.delete(stop);
      };
      stops.add(stop);
      return () => {
        stop();
        const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          samples.set(c, at);
          at += c.length;
        }
        return { samples, sampleRate: ctx.sampleRate, t0: start === null ? clock() : start + offset };
      };
    },
    close() {
      for (const s of [...stops]) s();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

export function toAudioBuffer(c: Capture): AudioBuffer {
  const b = new AudioBuffer({ length: Math.max(1, c.samples.length), sampleRate: c.sampleRate, numberOfChannels: 1 });
  b.copyToChannel(c.samples, 0);
  return b;
}
