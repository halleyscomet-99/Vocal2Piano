/**
 * SolenoidViz.jsx  v4
 * --------------------
 * Correct model: board slides in WHITE KEY steps.
 * White solenoids always land on white keys.
 * Black solenoids always land on black keys.
 *
 * Left board home:  A2 (white key index 14)
 * Right board home: C5 (white key index 28)
 *
 * White solenoid layout (7 consecutive white keys from root):
 *   sol 6 → root+0, sol 7 → root+1, sol 1 → root+2
 *   sol 2 → root+3, sol 3 → root+4, sol 4 → root+5, sol 5 → root+6
 *
 * Black solenoids are the black keys between adjacent white keys:
 *   sol 13 → black between root-1 and root+0  (left of root)
 *   sol  8 → black between root+1 and root+2
 *   sol  9 → black between root+2 and root+3
 *   sol 10 → black between root+4 and root+5
 *   sol 11 → black between root+5 and root+6
 *   sol 12 → black between root+6 and root+7
 *
 * Right board special (beyond 7 white keys):
 *   sol 13 → root+7 (8th white key)
 *   sol 14 → root+8 (9th white key)
 *   sol 15 → black between root+7 and root+8
 *
 * Left board special:
 *   sol 14 → same white key as sol 7 (root+1), stacked
 *   sol 15 → same white key as sol 6 (root+0), stacked
 */

import React, { useMemo } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────
const BLACK_PCS  = new Set([1, 3, 6, 8, 10])
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
const noteName   = m => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`

// ─── White key array (MIDI 21-108) ───────────────────────────────────────────
const WKM = []   // WKM[i] = midi number of the i-th white key
for (let m = 21; m <= 108; m++) {
  if (!BLACK_PCS.has(m % 12)) WKM.push(m)
}
// Home indices
const LEFT_HOME_WI  = WKM.indexOf(48)  // C3 = MIDI 48 (sol5=B3, highest)
const RIGHT_HOME_WI = WKM.indexOf(72)  // C5 = MIDI 72 (sol1=C5, lowest)

// Black key between two adjacent white MIDI values (or null)
function blackBetween(wm1, wm2) {
  if (wm2 - wm1 === 2) return wm1 + 1   // e.g. C-D → C#
  return null                              // e.g. B-C or E-F
}

// ─── Resolve solenoid MIDI positions given a white-key index ──────────────────

function resolveLeft(wi) {
  const w = (i) => WKM[wi + i]
  const b = (i, j) => blackBetween(WKM[wi + i], WKM[wi + j])

  return [
    // White solenoids (7 consecutive white keys from root)
    // sol6=root, sol7=root+1, sol1=root+2, sol2=root+3
    // sol3=root+4, sol4=root+5, sol5=root+6
    { sol: 6,  midi: w(0), isBlack: false },
    { sol: 7,  midi: w(1), isBlack: false },
    { sol: 1,  midi: w(2), isBlack: false },
    { sol: 2,  midi: w(3), isBlack: false },
    { sol: 3,  midi: w(4), isBlack: false },
    { sol: 4,  midi: w(5), isBlack: false },
    { sol: 5,  midi: w(6), isBlack: false },
    // Black solenoids (between white pairs)
    // sol8  = C# (between root+2 and root+3, i.e. E-F has none, so between D-E)
    // Actual: between root+1 and root+2 (D-E = D#), root+2/+3 (E-F no black)
    // root+3/+4 (F-G = F#), root+4/+5 (G-A = G#), root+5/+6 (A-B = A#)
    ...(b(0,1)  != null ? [{ sol: 8,  midi: b(0,1),  isBlack: true }] : []),
    ...(b(1,2)  != null ? [{ sol: 9,  midi: b(1,2),  isBlack: true }] : []),
    ...(b(3,4)  != null ? [{ sol: 10, midi: b(3,4),  isBlack: true }] : []),
    ...(b(4,5)  != null ? [{ sol: 11, midi: b(4,5),  isBlack: true }] : []),
    ...(b(5,6)  != null ? [{ sol: 12, midi: b(5,6),  isBlack: true }] : []),
    // Special 13: A#2 = black 2 whites before root (wi-2 to wi-1)
    ...(wi >= 2 && blackBetween(WKM[wi-2], WKM[wi-1]) != null
        ? [{ sol: 13, midi: blackBetween(WKM[wi-2], WKM[wi-1]), isBlack: true, special: true }]
        : []),
    // Special 14: B2 = white key before root (wi-1)
    ...(wi >= 1 ? [{ sol: 14, midi: w(-1), isBlack: false, special: true }] : []),
    // Special 15: A2 = white key 2 before root (wi-2)
    ...(wi >= 2 ? [{ sol: 15, midi: w(-2), isBlack: false, special: true }] : []),
  ].filter(s => s.midi != null && s.midi >= 21 && s.midi <= 108)
}

function resolveRight(wi) {
  const w = (i) => WKM[wi + i]
  const b = (i, j) => blackBetween(WKM[wi + i], WKM[wi + j])

  return [
    // White solenoids 1-7
    { sol: 1, midi: w(0), isBlack: false },
    { sol: 2, midi: w(1), isBlack: false },
    { sol: 3, midi: w(2), isBlack: false },
    { sol: 4, midi: w(3), isBlack: false },
    { sol: 5, midi: w(4), isBlack: false },
    { sol: 6, midi: w(5), isBlack: false },
    { sol: 7, midi: w(6), isBlack: false },
    // Black solenoids 8-12
    ...(b(0,1)  != null ? [{ sol: 8,  midi: b(0,1),  isBlack: true }] : []),
    ...(b(1,2)  != null ? [{ sol: 9,  midi: b(1,2),  isBlack: true }] : []),
    ...(b(3,4)  != null ? [{ sol: 10, midi: b(3,4),  isBlack: true }] : []),
    ...(b(4,5)  != null ? [{ sol: 11, midi: b(4,5),  isBlack: true }] : []),
    ...(b(5,6)  != null ? [{ sol: 12, midi: b(5,6),  isBlack: true }] : []),
    // Special 13-15: high extension
    { sol: 13, midi: w(7), isBlack: false, special: true },
    { sol: 14, midi: w(8), isBlack: false, special: true },
    ...(b(7,8)  != null ? [{ sol: 15, midi: b(7,8),  isBlack: true,  special: true }] : []),
  ].filter(s => s.midi != null && s.midi >= 21 && s.midi <= 108)
}

// ─── Auto-assign (white-key steps only) ──────────────────────────────────────

function assignBoards(notes) {
  const DEFAULT = { leftWI: LEFT_HOME_WI, rightWI: RIGHT_HOME_WI }
  if (!notes || notes.length === 0) return DEFAULT

  const midis = new Set(notes.map(n => n.midi).filter(m => m >= 21 && m <= 108))
  if (midis.size === 0) return DEFAULT

  function score(sols) {
    return [...midis].filter(m => sols.some(s => s.midi === m)).length
  }

  // Best left board — slides anywhere in lower register (up to C4)
  let bestLWI = LEFT_HOME_WI, bestLS = -1
  const maxLeftWI = WKM.indexOf(60) || 23  // up to C4
  for (let wi = 2; wi <= maxLeftWI && wi + 8 < WKM.length; wi++) {
    const s = score(resolveLeft(wi))
    if (s > bestLS) { bestLS = s; bestLWI = wi }
  }

  // Best right board — must not overlap left box
  // Left box spans from sol15(wi-2) to sol5(wi+6), so right starts at wi+7 minimum
  const minRightWI = bestLWI + 7
  let bestRWI = Math.max(RIGHT_HOME_WI, minRightWI), bestRS = -1
  for (let wi = minRightWI; wi + 9 < WKM.length; wi++) {
    const s = score(resolveRight(wi))
    if (s > bestRS) { bestRS = s; bestRWI = wi }
  }

  return { leftWI: bestLWI, rightWI: bestRWI }
}

// ─── Piano layout ─────────────────────────────────────────────────────────────
const WW = 16, WH = 88, BW = 10, BH = 54

function buildLayout() {
  const keys = []
  let wx = 0
  for (let m = 21; m <= 108; m++) {
    const isBlack = BLACK_PCS.has(m % 12)
    if (isBlack) {
      keys.push({ midi: m, isBlack: true,
        rx: wx * WW - BW / 2 - 1, cx: wx * WW - 0.5 })
    } else {
      keys.push({ midi: m, isBlack: false,
        rx: wx * WW, cx: wx * WW + WW / 2 })
      wx++
    }
  }
  return { keys, totalWhites: wx }
}

// ─── Colors ───────────────────────────────────────────────────────────────────
const LC = '#3B6CF4'   // left blue
const RC = '#22C55E'   // right green
const SC = '#F59E0B'   // special amber
const SOL_R  = 7
const SOL_GAP = 16

// ─── Component ────────────────────────────────────────────────────────────────

export function SolenoidViz({ accompNotes = [], melodyNotes = [], activeNotes = [] }) {
  const { keys, totalWhites } = useMemo(buildLayout, [])
  const totalW = totalWhites * WW

  const keyMap = useMemo(() => {
    const m = {}; keys.forEach(k => { m[k.midi] = k }); return m
  }, [keys])

  const allNotes = useMemo(() => [...accompNotes, ...melodyNotes], [accompNotes, melodyNotes])
  const { leftWI, rightWI } = useMemo(() => assignBoards(allNotes), [allNotes])

  const leftSols  = useMemo(() => resolveLeft(leftWI),   [leftWI])
  const rightSols = useMemo(() => resolveRight(rightWI),  [rightWI])
  const activeSet = useMemo(() => new Set(activeNotes),   [activeNotes])

  // Group by MIDI for stacking multiple solenoids on same key
  function groupByMidi(sols) {
    const map = {}
    for (const s of sols) {
      if (!map[s.midi]) map[s.midi] = []
      map[s.midi].push(s)
    }
    return map
  }

  // Bounding box of a board's keys
  function boardBox(sols) {
    const xs = []
    for (const s of sols) {
      const k = keyMap[s.midi]; if (!k) continue
      xs.push(k.rx, k.isBlack ? k.rx + BW : k.rx + WW)
    }
    if (!xs.length) return null
    return { x: Math.min(...xs) - 4, w: Math.max(...xs) - Math.min(...xs) + 8 }
  }

  const leftBox  = useMemo(() => boardBox(leftSols),  [leftSols])
  const rightBox = useMemo(() => boardBox(rightSols), [rightSols])

  // Render solenoid circles for one board
  function renderSols(groups, color) {
    return Object.entries(groups).flatMap(([midiStr, sArr]) => {
      const midi = Number(midiStr)
      const k = keyMap[midi]; if (!k) return []
      const firing = activeSet.has(midi)
      const baseY = k.isBlack ? BH - SOL_R - 2 : WH - SOL_R - 2
      return sArr.map((s, idx) => {
        const col = s.special ? SC : color
        const cy  = baseY - idx * SOL_GAP
        return (
          <g key={`${color}${s.sol}`}>
            <circle cx={k.cx} cy={cy} r={SOL_R}
              fill={firing ? col : 'white'}
              stroke={col} strokeWidth={firing ? 2.5 : 1.5}
            />
            <text x={k.cx} y={cy + 0.5}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={5.5} fontWeight="bold"
              fill={firing ? 'white' : col}
              fontFamily="monospace"
            >{s.sol}</text>
          </g>
        )
      })
    })
  }

  const leftGroups  = useMemo(() => groupByMidi(leftSols),  [leftSols])
  const rightGroups = useMemo(() => groupByMidi(rightSols), [rightSols])

  const leftRootName  = noteName(WKM[leftWI])
  const rightRootName = noteName(WKM[rightWI])

  return (
    <div>
      <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
        <svg width={totalW} height={WH + 32} style={{ display: 'block' }}>

          {/* White keys */}
          {keys.filter(k => !k.isBlack).map(k => (
            <rect key={k.midi} x={k.rx + 0.5} y={0} width={WW - 1} height={WH}
              fill={activeSet.has(k.midi) ? '#BFDBFE' : '#F5F3EF'}
              stroke="#CCC" strokeWidth={0.5} rx={2} />
          ))}

          {/* Black keys */}
          {keys.filter(k => k.isBlack).map(k => (
            <rect key={k.midi} x={k.rx} y={0} width={BW} height={BH}
              fill={activeSet.has(k.midi) ? '#3B6CF4' : '#1A1820'}
              stroke="#000" strokeWidth={0.5} rx={1} />
          ))}

          {/* C labels */}
          {keys.filter(k => !k.isBlack && k.midi % 12 === 0).map(k => (
            <text key={`c${k.midi}`} x={k.cx} y={WH - 3}
              textAnchor="middle" fontSize={6.5}
              fill="#BBBBBB" fontFamily="monospace"
            >{noteName(k.midi)}</text>
          ))}

          {/* Board dashed boxes */}
          {leftBox && (
            <rect x={leftBox.x} y={-4} width={leftBox.w} height={WH + 8}
              fill={`${LC}08`} stroke={LC} strokeWidth={1.5}
              strokeDasharray="6 3" rx={5} />
          )}
          {rightBox && (
            <rect x={rightBox.x} y={-4} width={rightBox.w} height={WH + 8}
              fill={`${RC}08`} stroke={RC} strokeWidth={1.5}
              strokeDasharray="6 3" rx={5} />
          )}

          {/* Solenoid circles */}
          {renderSols(leftGroups,  LC)}
          {renderSols(rightGroups, RC)}

          {/* Labels */}
          {leftBox && (
            <text x={leftBox.x + leftBox.w / 2} y={WH + 20}
              textAnchor="middle" fontSize={9} fontWeight="bold"
              fill={LC} fontFamily="monospace"
            >LEFT · {leftRootName}</text>
          )}
          {rightBox && (
            <text x={rightBox.x + rightBox.w / 2} y={WH + 20}
              textAnchor="middle" fontSize={9} fontWeight="bold"
              fill={RC} fontFamily="monospace"
            >RIGHT · {rightRootName}</text>
          )}
        </svg>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, padding: '2px',
        fontSize: '0.65rem', fontFamily: 'monospace', color: 'var(--text3)' }}>
        <span style={{ color: LC }}>■ LEFT (SER_B Pin 12)</span>
        <span style={{ color: RC }}>■ RIGHT (SER_A Pin 11)</span>
        <span style={{ color: SC }}>■ special (13-15)</span>
      </div>
    </div>
  )
}