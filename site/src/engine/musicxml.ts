// MusicXML import (.musicxml / .xml, and compressed .mxl). Each part becomes a track;
// piano parts with two staves become two tracks so the melody can be picked out.
// Repeats are not expanded: the score plays straight through once.

import type { Score, ScoreTrack } from "./score";
import type { Note } from "./types";

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Minimal zip reader: enough for .mxl (stored or deflated entries). */
async function unzip(buf: ArrayBuffer): Promise<Map<string, () => Promise<string>>> {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This .mxl file is not a valid zip archive");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const files = new Map<string, () => Promise<string>>();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    files.set(name, async () => {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = new Uint8Array(buf, start, size);
      if (method === 0) return dec.decode(data);
      if (method !== 8) throw new Error(`Unsupported compression in ${name}`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    });
  }
  return files;
}

async function xmlText(file: File): Promise<string> {
  if (!/\.mxl$/i.test(file.name)) return file.text();
  const files = await unzip(await file.arrayBuffer());
  const container = files.get("META-INF/container.xml");
  let path: string | undefined;
  if (container) {
    const doc = new DOMParser().parseFromString(await container(), "application/xml");
    path = doc.querySelector("rootfile")?.getAttribute("full-path") ?? undefined;
  }
  path ??= [...files.keys()].find((n) => !n.startsWith("META-INF") && /\.(xml|musicxml)$/i.test(n));
  const entry = path && files.get(path);
  if (!entry) throw new Error("No score found inside this .mxl file");
  return entry();
}

const num = (el: Element | null | undefined, tag: string) => {
  const t = el?.getElementsByTagName(tag)[0]?.textContent;
  return t != null && t.trim() !== "" ? Number(t) : undefined;
};
const kids = (el: Element, tag?: string) => [...el.children].filter((c) => !tag || c.tagName === tag);

interface RawNote {
  q: number; // start, quarter notes
  len: number; // quarter notes
  midi: number;
  staff: number;
}

export async function readMusicXml(file: File): Promise<Score> {
  const doc = new DOMParser().parseFromString(await xmlText(file), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("This file is not valid MusicXML");
  const root = doc.documentElement;
  if (root.tagName === "score-timewise") throw new Error("Timewise MusicXML is not supported; export as partwise");
  if (root.tagName !== "score-partwise") throw new Error("This file is not a MusicXML score");

  const partNames = new Map<string, string>();
  for (const sp of root.getElementsByTagName("score-part")) {
    partNames.set(sp.getAttribute("id") ?? "", sp.getElementsByTagName("part-name")[0]?.textContent?.trim() || "Part");
  }

  const tempos: { q: number; bpm: number }[] = [];
  const parts: { name: string; notes: RawNote[] }[] = [];

  for (const part of kids(root, "part")) {
    const notes: RawNote[] = [];
    const open = new Map<string, RawNote>(); // ties in progress
    let divisions = 1;
    let mStart = 0;
    for (const measure of kids(part, "measure")) {
      let pos = 0;
      let maxPos = 0;
      let lastStart = 0;
      const at = () => mStart + pos / divisions;
      for (const el of kids(measure)) {
        switch (el.tagName) {
          case "attributes":
            divisions = num(el, "divisions") ?? divisions;
            break;
          case "sound":
          case "direction": {
            const sound = el.tagName === "sound" ? el : el.getElementsByTagName("sound")[0];
            const bpm = Number(sound?.getAttribute("tempo"));
            if (bpm > 0) tempos.push({ q: at(), bpm });
            else {
              const perMin = num(el, "per-minute");
              const unit = el.getElementsByTagName("beat-unit")[0]?.textContent;
              const k = unit === "half" ? 2 : unit === "eighth" ? 0.5 : 1;
              if (perMin) tempos.push({ q: at(), bpm: perMin * k });
            }
            break;
          }
          case "backup":
            pos -= num(el, "duration") ?? 0;
            break;
          case "forward":
            pos += num(el, "duration") ?? 0;
            maxPos = Math.max(maxPos, pos);
            break;
          case "note": {
            if (el.getElementsByTagName("grace").length) break;
            const dur = num(el, "duration") ?? 0;
            const chord = el.getElementsByTagName("chord").length > 0;
            const start = chord ? lastStart : pos;
            const pitch = el.getElementsByTagName("pitch")[0];
            const isCue = el.getElementsByTagName("cue").length > 0;
            if (pitch && !isCue) {
              const step = pitch.getElementsByTagName("step")[0]?.textContent?.trim() ?? "C";
              const midi = (num(pitch, "octave") ?? 4) * 12 + 12 + STEP[step] + Math.round(num(pitch, "alter") ?? 0);
              const staff = num(el, "staff") ?? 1;
              const ties = [...el.getElementsByTagName("tie")].map((t) => t.getAttribute("type"));
              const key = `${staff}:${midi}`;
              const q = mStart + start / divisions;
              const len = dur / divisions;
              const prev = open.get(key);
              if (ties.includes("stop") && prev) {
                prev.len = q + len - prev.q;
                if (!ties.includes("start")) open.delete(key);
              } else {
                const n = { q, len, midi, staff };
                notes.push(n);
                if (ties.includes("start")) open.set(key, n);
              }
            }
            if (!chord) {
              lastStart = pos;
              pos += dur;
            }
            maxPos = Math.max(maxPos, pos);
            break;
          }
        }
      }
      mStart += maxPos / divisions;
    }
    parts.push({ name: partNames.get(part.getAttribute("id") ?? "") ?? "Part", notes });
  }

  // Quarter notes → seconds through the tempo map.
  tempos.sort((a, b) => a.q - b.q);
  const map = tempos.length ? tempos : [{ q: 0, bpm: 120 }];
  if (map[0].q > 0) map.unshift({ q: 0, bpm: map[0].bpm });
  const sec = (q: number) => {
    let s = 0;
    for (let i = 0; i < map.length; i++) {
      const end = i + 1 < map.length ? Math.min(q, map[i + 1].q) : q;
      if (end <= map[i].q) break;
      s += ((end - map[i].q) * 60) / map[i].bpm;
    }
    return s;
  };

  const tracks: ScoreTrack[] = [];
  for (const p of parts) {
    const staves = [...new Set(p.notes.map((n) => n.staff))].sort();
    for (const st of staves) {
      const notes: Note[] = p.notes
        .filter((n) => n.staff === st && n.len > 0)
        .map((n) => ({ midi: n.midi, time: sec(n.q), duration: sec(n.q + n.len) - sec(n.q), velocity: 0.7 }));
      if (notes.length) tracks.push({ name: staves.length > 1 ? `${p.name} (staff ${st})` : p.name, notes, drum: false });
    }
  }
  if (!tracks.length) throw new Error("No pitched notes found in this score");
  return { name: file.name.replace(/\.(musicxml|xml|mxl)$/i, ""), bpm: Math.round(map[0].bpm), tracks };
}
