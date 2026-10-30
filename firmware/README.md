# Firmware

Teensy 4.1 firmware for the C0nTrollER board. It takes timestamped commands from the site over USB serial ([`PROTOCOL.md`](PROTOCOL.md)), moves the two carriages (TMC2209 + NEMA17) and fires the 26 solenoids through the two PLAyeRs boards (PCA9685 over I²C).

| File | |
|---|---|
| `src/config.h` | Pins, I²C addresses, calibration and safety limits |
| `src/core.cpp` | The protocol, the time-sorted queue and the safety rules, with no hardware code |
| `src/main.cpp` | The hardware: steppers (stepped from a 50 kHz timer interrupt), PCA9685s, end stops, USB |
| `test/core_test.cpp` | Tests for `core.cpp` against a simulated robot, run on a computer |

## Build

[PlatformIO](https://platformio.org/) (CLI, or the VS Code extension):

```bash
cd firmware
pio run                 # build
pio run -t upload       # build and flash (press the Teensy's button if the loader asks)
pio device monitor      # serial monitor, for the bring-up commands below
```

Build output goes to `.pio.nosync/`, which iCloud doesn't sync and git ignores.

Tests, on a computer:

```bash
c++ -std=c++17 -Isrc test/core_test.cpp src/core.cpp -o /tmp/core_test && /tmp/core_test
```

## What it enforces on its own

Whatever the site sends:

- **Hold time.** No solenoid stays on longer than 2 s.
- **Strike, then hold.** Each strike runs at its `pwm` for the `CFG` strike time, then drops to the hold duty (35 %) until release.
- **Black keys lighter.** Black-key fingers (channels 7–12 on both boards) strike at 40 % of the requested `pwm`, as on the hardware test, and never hold harder than they struck.
- **Current budget.** At most 4 A of solenoid current at once (a full strike counts 0.4 A, a held key 0.14 A). A strike that would go over is skipped and reported with `LOG`.
- **Collisions.** A move that would bring the bass W1 within 7 white keys of the treble W1 is refused with `ERR`. If the carriages ever get within 6.75 keys (a stalled or slipping carriage), both stop and the robot has to be homed again.
- **End stops.** Each carriage has one switch, at its home end (bass: low end, treble: high end); the far ends are guarded by the other carriage and the range check. Before homing, `JOG` stops at the switch. After homing, a switch pressed while the carriage should be more than 2 mm away means lost steps: everything stops and the robot has to be homed again.
- **Range.** Positions outside 0–45 (W1 from A0 to D7), or past the end stop the carriage homed against, are refused. No moves before `HOME`.
- **Speed.** Capped at 100 mm/s and 1000 mm/s² (`SPEED_LIMIT_MM`, `ACCEL_LIMIT_MM`), whatever `CFG` asks, until the motors are tested faster. The hardware test ran at about 1000 steps/s.
- **Drivers.** The motor drivers stay off from power-up until the first move, then hold position.
- **Lost connection.** Closing the port or pulling the cable acts as `STOP`.

## Finger → PCA9685 channel

The site already sends channel numbers; this is the wiring they assume (`site/src/engine/robot.ts`, `pwmChannel`). W1–W7 are the white-key fingers from left to right, B1–B6 the black-key fingers (Bn sits between Wn and Wn+1).

| Finger | W1 | W2 | W3 | W4 | W5 | W6 | W7 | B1 | B2 | B3 | B4 | B5 | B6 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Treble (`0x41`) | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| Bass (`0x40`) | 6 | 5 | 4 | 3 | 2 | 1 | 0 | 12 | 11 | 10 | 9 | 8 | 7 |

## Bring-up

In order, with the serial monitor open. Each step only needs the ones before it.

1. **Power.** Before the first power-up, follow the note in [`hardware/PCB/README.md`](../hardware/PCB/README.md): set the MP1584 to 5.0 V with the Teensy out, and cut the Teensy's VIN–VUSB trace.
2. **Link.** `HELLO` → `V2P 1`. An `ERR no PCA9685 at …` after it means that board didn't answer on I²C at power-up (cable, 5 V, or the A0 jumper on the treble board).
3. **Solenoids.** With 12 V on: `TEST B 0`, `TEST B 1`, … `TEST T 12` (a 150 ms strike each: full strength on white keys, 40 % on black keys). Check that each lands on the finger in the table above. A wrong finger means the table, or the wiring, needs changing; a dead channel shows on the board's LED (lit = the MOSFET switched).
4. **End stops.** `POS` prints `END <bass> <treble>`; press each switch by hand and run `POS` again: the number goes from 0 to 1.
5. **Direction and distance.** `JOG B 50` moves the bass carriage 50 mm to the right (towards the treble). Measure how far it went.
   - Wrong way: flip `DIR_INVERT` for that carriage in `config.h`. The default follows the hardware test, where DIR low moved both carriages towards their own switch.
   - Wrong distance: `STEPS_PER_MM` × 50 / measured. The default assumes a GT2 belt on a 20-tooth pulley and 8 microsteps (TMC2209 with MS1 and MS2 low).
   - Same for the treble with `JOG T -50` (to the left).
6. **Homing.** `HOME` drives the bass to the low end and the treble to the high end at 20 mm/s, then backs each off 3 mm → `HOMED`. If it reports `ERR homing failed`, a switch was never reached in 90 s: check the direction (step 5) and the switch (step 4).
7. **Key positions.** `GO B 0` should put the bass W1 over A0, and `GO T 45` the treble W1 over D7. If they are off, change `HOME_KEYS` in `config.h` (in white keys, fractions allowed) and home again. Then try a few in the middle, e.g. `GO B 23` (W1 over C4).
8. **Speed.** `GO` moves at the capped speed (100 mm/s). Raise `SPEED_LIMIT_MM` and `ACCEL_LIMIT_MM` step by step, homing and running long `GO` moves each time: a carriage that skips steps stops with `ERR … lost steps` on its way back home. Then set `carriageSpeedMm` and `carriageAccelMm` in `site/src/engine/robot.ts` to the same values, so the planner's timing matches the robot.
9. **From the site.** Robot window → **Connect…** → **Home**, then play a song with the robot on.

Also worth checking on the real robot: the hold duty (35 %: the lowest that still keeps a key down) and the strike time (50 ms), both in `site/src/engine/robot.ts`, which sends them with `CFG`.
