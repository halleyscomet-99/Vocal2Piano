# Legacy

The first version of Vocal2Piano, kept for reference. It is no longer used, and nothing else in the repository depends on it.

| Folder | What it was |
|---|---|
| `software/engine/` | Python pipeline: live and file voice-to-MIDI, chord choice, and the serial driver for the robot (deployed on Railway) |
| `software/*.maxpat`, `software/patch/` | Max/MSP patch that showed the detected notes and key |
| `firmware/` | Teensy 4.1 firmware (PlatformIO) with an ASCII serial protocol (`MOVE`, `FIRE`, `HOME`, …) |

The pin assignments in `firmware/README.md` are for the old driver boards, not the current `C0nTrollER` and `PLAyeRs` boards. The current app is in [`site/`](../site), and the current firmware in [`firmware/`](../firmware).

The old React frontend (`software/app/`) and the old PCB (`hardware/PCB/Vocal2Piano.*`) are not copied here; they are in the git history before the commit that added this folder.
