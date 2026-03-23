# Firmware

Teensy 4.1 firmware. Receives serial commands from `MIDI2Piano.py` and controls two solenoid driver boards and two stepper motors.

Built with [PlatformIO](https://platformio.org/).

---

## Build and flash

```bash
pip install platformio
cd firmware
pio run --target upload
pio device monitor --baud 115200
```

If VS Code shows red squiggles on the includes, run `pio init --ide vscode` once to generate the IntelliSense config. This doesn't affect compilation.

---

## Pin assignments

| Pin | Signal |
|-----|--------|
| 2 | STEP_1 (right stepper) |
| 3 | DIR_1 |
| 4 | STEP_2 (left stepper) |
| 5 | DIR_2 |
| 6 | EN (shared, active LOW) |
| 7 | STOP_1 (right endstop) |
| 8 | STOP_2 (left endstop) |
| 10 | CS (shared 74HC595 latch) |
| 11 | SER_A (right board data) |
| 12 | SER_B (left board data) |
| 13 | SCK (shared clock) |

Both driver boards share SCK and CS. SER_A and SER_B are clocked together on every update so both boards latch simultaneously.

---

## Serial protocol

115200 baud, ASCII, newline-terminated. Used by `MIDI2Piano.py` — you don't normally need to type these manually.

```
MOVE R <semitone_offset> <rpm>   move right board to offset from home
MOVE L <semitone_offset> <rpm>   move left board
FIRE R <0xMASK> <hold_ms>        fire right solenoids (auto-release after hold_ms)
FIRE L <0xMASK> <hold_ms>        fire left solenoids
RELEASE R / RELEASE L            release immediately
HOME                             home both rails to endstops
STATUS                           reply: STATUS R <pos> L <pos>
```

Solenoid mask is 15-bit: bit 0 = SOL 1, bit 14 = SOL 15. Example: `0x0015` = SOL 1 + SOL 3 + SOL 5.

---

## Calibrating steps per semitone

`STEPS_PER_SEMITONE` in `src/main.cpp` needs to match your physical setup.

Send `HOME` then `MOVE R 12 100`, and measure how far the board actually moved. It should travel 12 piano semitone spacings (roughly 164mm for a standard piano). Calculate:

```
new value = 1096 × (164 / actual_mm)
```

Update the constant and reflash.

The default of 1096 assumes a NEMA17 with GT2 belt, 20-tooth pulley, 1/16 microstepping. Adjust if your setup differs.

---

## Dependencies

PlatformIO installs these automatically:

- `waspinator/AccelStepper` — non-blocking stepper control
- `framework-arduinoteensy` — Teensy Arduino core