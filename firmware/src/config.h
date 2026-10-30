// Pins, I2C addresses and calibration for the C0nTrollER + PLAyeRs boards.
// Values marked "calibrate" depend on the mechanics; README.md explains how to measure them.
#pragma once
#include <stdint.h>

namespace cfg {

// Carriage index used everywhere in the firmware.
constexpr int BASS = 0;
constexpr int TREBLE = 1;

// Teensy 4.1 pins (hardware/PCB/README.md).
constexpr uint8_t PIN_STEP[2] = {2, 5};
constexpr uint8_t PIN_DIR[2] = {3, 6};
constexpr uint8_t PIN_EN[2] = {4, 7}; // active LOW
constexpr uint8_t PIN_ENDSTOP[2] = {8, 10}; // INPUT_PULLUP, pressed = LOW

// PCA9685 per carriage, on Wire (SDA 18, SCL 19).
constexpr uint8_t I2C_ADDR[2] = {0x40, 0x41};
constexpr uint32_t I2C_HZ = 400000;
constexpr float PWM_HZ = 1000; // as on the hardware test

// Motion. Positions are in mm from "finger W1 over A0", growing towards the treble.
// calibrate: GT2 belt (2 mm pitch) on a 20-tooth pulley = 40 mm per turn;
// 200 full steps x 8 microsteps (TMC2209 with MS1 and MS2 low) = 1600 steps per turn.
constexpr float STEPS_PER_MM = 1600.0f / 40.0f;
// DIR low moves each carriage towards its own end stop (hardware test, `homedir` 0), so the
// treble, which homes to the high end, is inverted. Flip if a carriage moves the wrong way on JOG.
constexpr bool DIR_INVERT[2] = {false, true};
// calibrate: where W1 is (in white keys, 0 = A0) when each carriage touches its end stop.
// Bass homes to the low end, treble to the high end.
constexpr float HOME_KEYS[2] = {0.0f, 45.0f};
constexpr int HOME_DIR[2] = {-1, +1};
constexpr float HOME_SPEED_MM = 20.0f;
constexpr float HOME_ACCEL_MM = 200.0f;
constexpr float BACKOFF_MM = 3.0f; // off the switch after homing
constexpr uint32_t HOME_TIMEOUT_MS = 90000;
// An end stop pressed while the carriage is believed this far from it means lost steps.
constexpr float SLIP_MM = 2.0f;

// Upper limits on whatever CFG asks for. The hardware test ran at ~1000 steps/s; raise these
// once JOG and GO run cleanly faster (and keep site/src/engine/robot.ts in step with them).
constexpr float SPEED_LIMIT_MM = 100.0f;
constexpr float ACCEL_LIMIT_MM = 1000.0f;

// Keyboard limits, in white keys (52 white keys; a carriage spans 7).
constexpr int MAX_POS = 45;
constexpr float MIN_GAP_KEYS = 7.0f; // bass W1 at least this far left of treble W1

// Defaults until the site sends CFG (same as site/src/engine/robot.ts).
constexpr float SPEED_MM = 100.0f;
constexpr float ACCEL_MM = 1000.0f;
constexpr float KEY_MM = 23.5f;
constexpr uint32_t STRIKE_MS = 50;
constexpr uint8_t HOLD_PCT = 35;

// Solenoids (JF-1039(B), 12 V, ~0.4 A each).
constexpr int CHANNELS = 13;
constexpr uint32_t MAX_HOLD_MS = 2000;
constexpr float SOLENOID_AMPS = 0.4f;
constexpr float BUDGET_AMPS = 4.0f; // 5 A supply minus motors and logic
// Channels 7–12 are the black-key fingers on both boards. They need far less force: the
// hardware test struck white keys at 100 % and black keys at 40 %.
constexpr int FIRST_BLACK = 7;
constexpr float BLACK_SCALE = 0.4f;

// Commands later than this are dropped instead of played.
constexpr uint32_t DROP_LATE_MS = 200;

} // namespace cfg
