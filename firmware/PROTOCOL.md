# Serial protocol

How the rehearsal site (`site/src/robotLink.ts`) talks to the Teensy over USB serial. The firmware (`src/`, see [`README.md`](README.md)) implements it.

The site streams commands while the song plays, 0.1 to 0.3 s before each one is due. A whole performance never has to fit on the device.

## Transport

- USB CDC serial. The baud rate is ignored by the Teensy; the site opens the port at 115200.
- Plain ASCII, one command per line, ending in `\n`. Fields are separated by single spaces.
- Carriages: `T` = treble (right hand, PCA9685 at `0x41`), `B` = bass (left hand, `0x40`).
- Times are integer milliseconds on the device clock, counted from the last `ZERO`.

## Host → device

| Command | Meaning |
|---|---|
| `HELLO` | Identify. Reply `V2P <protocol version>`, e.g. `V2P 1`. |
| `CFG <speed> <accel> <key> <strike> <hold>` | Motion and solenoid settings the planner assumed. Speed in mm/s, acceleration in mm/s², white-key pitch in mm, strike time in ms, hold duty in %. Sent once after connecting, so the robot moves exactly as the rehearsal predicted. Reply `OK`. |
| `HOME` | Drive both carriages to their end stops and set positions. Reply `HOMED` when done, or `ERR <reason>`. |
| `ZERO` | Restart the device clock at 0. Sent at the start of every performance, right after `STOP`. |
| `M <c> <pos> <t>` | At time `t`, start moving carriage `c` so that finger W1 sits over white key `pos` (0 = A0, 51 = C8). Use the trapezoid profile from `CFG`. |
| `S <c> <ch> <t> <dur> <pwm>` | At time `t`, fire PCA9685 channel `ch` (0 to 12) on carriage `c` at duty `pwm` (12-bit, sets how hard the key is struck; black-key channels 7–12 are scaled to 40 %) for the strike time, then hold at the hold duty. Release `dur` ms after `t`. Striking a channel that is still on restarts its timing. |
| `STOP` | Release every solenoid, stop both motors, clear all queued commands. Reply `OK`. |

Commands may arrive out of time order (moves and strikes are separate streams). Keep a queue sorted by time.

The finger-to-channel map is in [`README.md`](README.md). The site already sends channel numbers, so the firmware needs no finger names.

## Device → host

| Line | Meaning |
|---|---|
| `V2P <n>` | Reply to `HELLO`. |
| `OK` | Command accepted, where a reply is expected. |
| `HOMED` | Homing finished. |
| `ERR <text>` | Something went wrong (bad command, end stop hit while playing, homing failed). |
| `LATE <ms>` | Commands arrived up to this many ms after their time (more than 10 ms late; sent at most every 250 ms). Those up to 200 ms late were played at once; later ones were dropped. |
| `LOG <text>` | Anything worth showing; the site prints the last few lines. |

## Safety the firmware enforces on its own

- Never hold a solenoid longer than 2 s, whatever `dur` says.
- Never move a carriage past its end stop or into the other carriage. The bass carriage must stay at least 7 white keys left of the treble.
- Never draw more than the solenoid current budget (4 A); a strike that would go over is skipped.
- Treat a lost USB connection as `STOP`.

Details in [`README.md`](README.md).

## Bring-up commands

For a serial monitor while setting up the robot; the site doesn't send them.

| Command | Meaning |
|---|---|
| `POS` | Reply `POS B <keys> T <keys> END <bass> <treble> <homed>`: positions in white keys (W1, 0 = A0) and the end stops (1 = pressed). |
| `JOG <c> <mm>` | Move a carriage by this many mm (+ = towards the treble), slowly, even before homing. |
| `GO <c> <pos>` | Move W1 over white key `pos` now, with the same checks as `M`. |
| `TEST <c> <ch>` | Fire one channel at full strength for 150 ms. |
