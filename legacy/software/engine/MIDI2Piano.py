"""
Voice2Piano -- MIDI2Piano.py
=============================
Layer 2b: Chord MIDI events → Teensy serial commands → Solenoids + Steppers

Runs on Mac/PC. Communicates with Teensy 4.1 over USB Serial.
Reads from harmony_queue (produced by MIDI2Chords.py).

HARDWARE
--------
Right board (SOL_1-15):   C C# D Eb E F F# G Ab A Bb B C C# D
  Layout starts at C, 15 consecutive semitones.
  Default root = MIDI 60 (C4). Slides on right linear rail.

Left board (SOL_16-30):   A Bb B C C# D Eb E F F# G Ab A Bb B
  Layout starts at A, 15 consecutive semitones.
  Default root = MIDI 57 (A3). Slides on left linear rail.

Teensy PIN ASSIGNMENTS (from schematic J39)
-------------------------------------------
  STEP_1  → pin 4    (right stepper STEP)
  DIR_1   → pin 5    (right stepper DIR)
  STEP_2  → pin 6    (left stepper STEP)
  DIR_2   → pin 7    (left stepper DIR)
  EN      → pin 8    (shared enable, active LOW)
  STOP_1  → pin 9    (right endstop, INPUT_PULLUP)
  STOP_2  → pin 10   (left endstop, INPUT_PULLUP)
  CS      → pin 12   (shared latch for both 74HC595)
  SER_A   → pin 13   (right board shift register data)
  SER_B   → pin 14   (left board shift register data)
  SCK     → pin 15   (shared shift register clock)

TEENSY SERIAL PROTOCOL
----------------------
  All commands ASCII, newline-terminated, 115200 baud.

  MOVE R <semitone_offset> <speed_rpm>
  MOVE L <semitone_offset> <speed_rpm>
    Move board to absolute semitone offset from home position.

  FIRE R <hex_mask> <hold_ms>
  FIRE L <hex_mask> <hold_ms>
    Activate solenoids. hex_mask is 15-bit (bit0=SOL_1, bit14=SOL_15).
    Teensy auto-releases after hold_ms milliseconds.

  RELEASE R / RELEASE L
    Immediately release all solenoids on a board.

  HOME
    Move both boards to endstop and zero positions.

  STATUS
    Teensy replies: STATUS R <pos> L <pos>
"""

import time
import queue
import threading
import logging
from typing import Optional

log = logging.getLogger("V2P-PIANO")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(threadName)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)


# =============================================================================
# HARDWARE CONSTANTS
# =============================================================================

# Right board: 15 solenoids, semitone offsets from board root
# SOL_1=offset 0 (C), SOL_2=offset 1 (C#), ... SOL_15=offset 14 (D)
RIGHT_OFFSETS = list(range(15))  # [0, 1, 2, ..., 14]
RIGHT_DEFAULT_ROOT = 60  # C4 when rail at position 0

# Left board: same 15-semitone span, starts at A
# SOL_16=offset 0 (A), SOL_17=offset 1 (Bb), ... SOL_30=offset 14 (B)
LEFT_OFFSETS = list(range(15))
LEFT_DEFAULT_ROOT = 57  # A3 when rail at position 0

# Rail travel limits in semitones
RAIL_MIN = -12  # slide down max 1 octave
RAIL_MAX = 24  # slide up max 2 octaves

# Default timing
DEFAULT_HOLD_MS = 80
DEFAULT_SPEED_RPM = 200
MOVE_SETTLE_SEC = 0.04  # wait after MOVE command before FIRE


# =============================================================================
# BOARD STATE
# =============================================================================


class BoardState:
    """Tracks one solenoid board's current rail position."""

    def __init__(self, name: str, default_root: int):
        self.name = name
        self.default_root = default_root
        self.rail_pos = 0  # semitone offset from default_root

    @property
    def current_root(self) -> int:
        return self.default_root + self.rail_pos

    def reachable(self, midi: int) -> bool:
        offset = midi - self.current_root
        return 0 <= offset < 15

    def to_solenoid_idx(self, midi: int) -> Optional[int]:
        offset = midi - self.current_root
        if 0 <= offset < 15:
            return offset
        return None

    def notes_to_mask(self, midi_notes: list[int]) -> int:
        mask = 0
        for m in midi_notes:
            idx = self.to_solenoid_idx(m)
            if idx is not None:
                mask |= 1 << idx
        return mask

    def coverage(self, midi_notes: list[int]) -> int:
        """How many of midi_notes are reachable at current position."""
        return sum(1 for m in midi_notes if self.reachable(m))


# =============================================================================
# RAIL PLANNER
# =============================================================================


def plan_positions(
    right_targets: list[int],
    left_targets: list[int],
    board_r: BoardState,
    board_l: BoardState,
) -> tuple[int, int]:
    """
    Find rail positions that maximise note coverage.

    Right board targets chord tones (octave 4).
    Left board targets bass notes (octave 3).

    Tries all rail positions RAIL_MIN..RAIL_MAX for each board
    and picks the combination covering the most notes.
    Prefers positions close to current (less rail movement).

    Returns (right_rail_offset, left_rail_offset)
    """
    all_targets = list(set(right_targets + left_targets))
    if not all_targets:
        return board_r.rail_pos, board_l.rail_pos

    best_score = -1
    best_r = board_r.rail_pos
    best_l = board_l.rail_pos

    orig_r = board_r.rail_pos
    orig_l = board_l.rail_pos

    for r_off in range(RAIL_MIN, RAIL_MAX + 1):
        board_r.rail_pos = r_off
        r_cov = set(n for n in right_targets if board_r.reachable(n))

        remaining = [n for n in left_targets if n not in r_cov]

        for l_off in range(RAIL_MIN, RAIL_MAX + 1):
            board_l.rail_pos = l_off
            l_cov = sum(1 for n in remaining if board_l.reachable(n))
            total = len(r_cov) + l_cov

            # Tie-break: prefer smaller movement
            move_penalty = (abs(r_off - orig_r) + abs(l_off - orig_l)) * 0.01

            score = total - move_penalty
            if score > best_score:
                best_score = score
                best_r = r_off
                best_l = l_off

    board_r.rail_pos = orig_r
    board_l.rail_pos = orig_l
    return best_r, best_l


# =============================================================================
# TEENSY SERIAL
# =============================================================================


class TeensySerial:
    """
    USB serial interface to Teensy 4.1.
    Auto-detects port. Falls back to simulation mode if not connected.
    """

    def __init__(self, port: Optional[str] = None, baud: int = 115200):
        self.port = port
        self.baud = baud
        self._ser = None
        self._lock = threading.Lock()
        self.sim = True

    def connect(self) -> bool:
        try:
            import serial  # noqa: PLC0415
            import serial.tools.list_ports  # noqa: PLC0415
        except ImportError:
            log.warning("pyserial not installed -- pip install pyserial")
            return False

        # Auto-detect Teensy
        if self.port:
            ports = [self.port]
        else:
            all_ports = serial.tools.list_ports.comports()
            # Teensy shows up as USB Serial Device
            ports = [
                p.device
                for p in all_ports
                if "usbmodem" in p.device.lower()
                or "ttyacm" in p.device.lower()
                or (p.vid == 0x16C0 and p.pid == 0x0483)
            ]

        if not ports:
            log.warning("Teensy not found -- simulation mode")
            return False

        try:
            self._ser = serial.Serial(ports[0], self.baud, timeout=0.2)
            self.sim = False
            log.info("Teensy connected: %s", ports[0])
            time.sleep(0.5)  # wait for Teensy to boot
            return True
        except Exception as exc:
            log.warning("Serial error: %s -- simulation mode", exc)
            return False

    def send(self, cmd: str):
        line = cmd.strip() + "\n"
        with self._lock:
            if self.sim:
                log.debug("[SIM] %s", cmd)
            else:
                try:
                    self._ser.write(line.encode())
                except Exception as exc:
                    log.error("Write error: %s", exc)

    def move(self, board: str, offset: int, speed: int = DEFAULT_SPEED_RPM):
        self.send(f"MOVE {board} {offset} {speed}")

    def fire(self, board: str, mask: int, hold_ms: int = DEFAULT_HOLD_MS):
        if mask:
            self.send(f"FIRE {board} 0x{mask:04X} {hold_ms}")

    def release(self, board: str):
        self.send(f"RELEASE {board}")

    def home(self):
        self.send("HOME")

    def status(self):
        self.send("STATUS")

    def close(self):
        if self._ser:
            self._ser.close()


# =============================================================================
# PIANO DRIVER
# =============================================================================


class PianoDriver:
    """
    Consumes harmony_queue events from MIDI2Chords.py.
    Plans rail movements and fires solenoids via Teensy.
    """

    def __init__(
        self,
        input_queue: queue.Queue,
        shutdown: threading.Event,
        teensy_port: Optional[str] = None,
    ):
        self.iq = input_queue
        self.shutdown = shutdown

        self.teensy = TeensySerial(port=teensy_port)
        self.board_r = BoardState("R", RIGHT_DEFAULT_ROOT)
        self.board_l = BoardState("L", LEFT_DEFAULT_ROOT)

        self._thread: Optional[threading.Thread] = None

    def start(self):
        self.teensy.connect()
        if not self.teensy.sim:
            self.teensy.home()
            time.sleep(2.0)  # wait for homing

        self._thread = threading.Thread(
            target=self._run, name="PianoDriver", daemon=True
        )
        self._thread.start()
        log.info("PianoDriver started (sim=%s)", self.teensy.sim)

    def stop(self):
        if self._thread:
            self._thread.join(timeout=2.0)
        self.teensy.release("R")
        self.teensy.release("L")
        self.teensy.close()

    def _run(self):
        while not self.shutdown.is_set():
            try:
                evt = self.iq.get(timeout=0.3)
            except queue.Empty:
                continue

            right_targets = evt.get("right_notes", [])
            left_targets = evt.get("left_notes", [])

            if not right_targets and not left_targets:
                continue

            # Plan optimal rail positions
            new_r, new_l = plan_positions(
                right_targets, left_targets, self.board_r, self.board_l
            )

            # Move rails if needed
            moved = False
            if new_r != self.board_r.rail_pos:
                self.teensy.move("R", new_r)
                self.board_r.rail_pos = new_r
                moved = True

            if new_l != self.board_l.rail_pos:
                self.teensy.move("L", new_l)
                self.board_l.rail_pos = new_l
                moved = True

            if moved:
                time.sleep(MOVE_SETTLE_SEC)

            # Build solenoid masks at new positions
            r_mask = self.board_r.notes_to_mask(right_targets)
            l_mask = self.board_l.notes_to_mask(left_targets)

            # Fire
            self.teensy.fire("R", r_mask)
            self.teensy.fire("L", l_mask)

            # Log
            note_names = [
                "C",
                "C#",
                "D",
                "Eb",
                "E",
                "F",
                "F#",
                "G",
                "Ab",
                "A",
                "Bb",
                "B",
            ]
            r_names = [f"{note_names[n%12]}{n//12-1}" for n in right_targets]
            l_names = [f"{note_names[n%12]}{n//12-1}" for n in left_targets]
            log.info(
                "%-5s %-7s  R[+%2d]: %-20s  L[+%2d]: %s",
                evt.get("chord", "?"),
                evt.get("chord_type", ""),
                new_r,
                " ".join(r_names),
                new_l,
                " ".join(l_names),
            )


# =============================================================================
# ENTRY POINT
# =============================================================================


def main():
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        description="MIDI2Piano -- chord MIDI to Teensy solenoid driver"
    )
    parser.add_argument(
        "--port",
        default=None,
        help="Teensy serial port (auto-detect if omitted)",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Read from MIDI2Chords harmony_queue",
    )
    args = parser.parse_args()

    shutdown = threading.Event()

    if args.live:
        try:
            from MIDI2Chords import harmony_queue  # noqa: PLC0415

            iq = harmony_queue
            log.info("Connected to MIDI2Chords harmony_queue")
        except ImportError:
            log.error("MIDI2Chords.py not found -- run standalone test")
            iq = queue.Queue()
    else:
        # Standalone test: inject dummy chord events
        iq = queue.Queue()

        def _test():
            chords = [
                {
                    "right_notes": [60, 64, 67],
                    "left_notes": [48],
                    "chord": "I",
                    "chord_type": "major",
                    "key": "C major",
                },
                {
                    "right_notes": [65, 69, 72],
                    "left_notes": [53],
                    "chord": "IV",
                    "chord_type": "major",
                    "key": "C major",
                },
                {
                    "right_notes": [67, 71, 74],
                    "left_notes": [55],
                    "chord": "V",
                    "chord_type": "dom7",
                    "key": "C major",
                },
                {
                    "right_notes": [69, 72, 76],
                    "left_notes": [57],
                    "chord": "vi",
                    "chord_type": "minor",
                    "key": "C major",
                },
            ]
            i = 0
            while not shutdown.is_set():
                iq.put(chords[i % len(chords)])
                i += 1
                time.sleep(2.0)

        threading.Thread(target=_test, daemon=True).start()
        log.info("Standalone test mode: cycling I-IV-V-vi in C major")

    driver = PianoDriver(iq, shutdown, teensy_port=args.port)
    driver.start()

    print("MIDI2Piano running. Ctrl+C to stop.")
    try:
        while True:
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        shutdown.set()
        driver.stop()
        print("Stopped.")


if __name__ == "__main__":
    main()
