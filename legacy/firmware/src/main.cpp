/*
 * Voice2Piano -- Teensy 4.1 Firmware
 * ====================================
 * Controls two solenoid driver boards (74HC595 shift registers)
 * and two stepper motors (TMC2209) on linear rails.
 *
 * PIN ASSIGNMENTS
 * ---------------
 *  Pin 2   STEP_1     Right stepper pulse
 *  Pin 3   DIR_1      Right stepper direction
 *  Pin 4   STEP_2     Left stepper pulse
 *  Pin 5   DIR_2      Left stepper direction
 *  Pin 6   EN         Shared stepper enable (active LOW)
 *  Pin 7   STOP_1     Right endstop (INPUT_PULLUP, LOW = triggered)
 *  Pin 8   STOP_2     Left endstop
 *  Pin 10  CS         Shared 74HC595 latch (rising edge latches both boards)
 *  Pin 11  SER_A      Right board shift register data
 *  Pin 12  SER_B      Left board shift register data
 *  Pin 13  SCK        Shared shift register clock
 *
 * SHIFT REGISTER TOPOLOGY
 * ------------------------
 * Right board: two 74HC595 daisy-chained (SOL_1-15), driven by SER_A.
 * Left board:  two 74HC595 daisy-chained (SOL_16-30), driven by SER_B.
 * SCK and CS are shared. Both boards are clocked simultaneously on
 * every update -- CS rising edge latches both at the same time.
 * This means updateBoards() always writes both masks together.
 *
 * COMMAND PROTOCOL  (USB Serial, 115200 baud, newline terminated)
 * ---------------------------------------------------------------
 *  MOVE R <offset> <rpm>    Move right board to semitone offset from home
 *  MOVE L <offset> <rpm>    Move left board
 *  FIRE R <0xMASK> <ms>     Fire right solenoids, auto-release after ms
 *  FIRE L <0xMASK> <ms>     Fire left solenoids
 *  RELEASE R                Release right solenoids immediately
 *  RELEASE L                Release left solenoids immediately
 *  HOME                     Home both rails (move to endstop, zero position)
 *  STATUS                   Reply: STATUS R <pos> L <pos>
 *
 * SOLENOID MASK FORMAT
 * --------------------
 *  15-bit integer, bit 0 = SOL_1 (first solenoid), bit 14 = SOL_15.
 *  Example: 0x0015 = binary 000000000010101 = SOL_1 + SOL_3 + SOL_5
 *
 * STEPS_PER_SEMITONE CALIBRATION
 * --------------------------------
 *  Measure: command MOVE R 12, measure actual rail travel in mm.
 *  Expected: 12 * (piano semitone spacing) mm.
 *  Piano semitone spacing ≈ 13.7 mm (white key width 23.5mm * 7/12).
 *  With NEMA17 + GT2 belt + 20-tooth pulley + 1/16 microstepping:
 *    mm per step = (20 teeth * 2mm pitch) / (200 steps * 16 ustep) = 0.0125mm
 *    steps per semitone = 13.7 / 0.0125 ≈ 1096
 *  Adjust STEPS_PER_SEMITONE until MOVE R 12 travels exactly 12 semitones.
 */

#include <Arduino.h>
#include <AccelStepper.h>

// ============================================================
// PIN DEFINITIONS
// ============================================================

constexpr uint8_t PIN_STEP_R = 2;
constexpr uint8_t PIN_DIR_R  = 3;
constexpr uint8_t PIN_STEP_L = 4;
constexpr uint8_t PIN_DIR_L  = 5;
constexpr uint8_t PIN_EN     = 6;   // active LOW
constexpr uint8_t PIN_STOP_R = 7;   // INPUT_PULLUP, LOW = triggered
constexpr uint8_t PIN_STOP_L = 8;
constexpr uint8_t PIN_CS     = 10;  // 74HC595 latch (shared)
constexpr uint8_t PIN_SER_A  = 11;  // right board data
constexpr uint8_t PIN_SER_B  = 12;  // left board data
constexpr uint8_t PIN_SCK    = 13;  // clock (shared)


// ============================================================
// STEPPER CONFIGURATION
// ============================================================

// Adjust this value to match your hardware (see calibration note above)
constexpr int STEPS_PER_SEMITONE = 1096;

constexpr float MAX_SPEED  = 20000.0f;  // steps/sec
constexpr float ACCEL      = 8000.0f;   // steps/sec^2
constexpr float HOME_SPEED = 3000.0f;   // slower during homing


// ============================================================
// SOLENOID CONFIGURATION
// ============================================================

constexpr int DEFAULT_HOLD_MS = 80;     // auto-release time


// ============================================================
// STATE
// ============================================================

AccelStepper stepperR(AccelStepper::DRIVER, PIN_STEP_R, PIN_DIR_R);
AccelStepper stepperL(AccelStepper::DRIVER, PIN_STEP_L, PIN_DIR_L);

int posR = 0;   // current position, semitones from home
int posL = 0;

uint16_t maskR = 0;   // currently latched solenoid masks
uint16_t maskL = 0;

unsigned long releaseR = 0;   // millis() timestamp for auto-release
unsigned long releaseL = 0;

String cmdBuf = "";


// ============================================================
// SHIFT REGISTER (74HC595)
// ============================================================

/*
 * Clock 16 bits into both shift register chains simultaneously.
 * SER_A feeds the right board, SER_B feeds the left board.
 * Both chains share SCK.
 * CS (latch) is pulsed once at the end to update both boards atomically.
 */
void updateBoards(uint16_t mR, uint16_t mL) {
    maskR = mR & 0x7FFFu;   // 15-bit only
    maskL = mL & 0x7FFFu;

    // Shift 16 bits, MSB first
    for (int i = 15; i >= 0; i--) {
        digitalWrite(PIN_SCK,   LOW);
        digitalWrite(PIN_SER_A, (maskR >> i) & 1u);
        digitalWrite(PIN_SER_B, (maskL >> i) & 1u);
        delayMicroseconds(1);
        digitalWrite(PIN_SCK,   HIGH);
        delayMicroseconds(1);
    }
    digitalWrite(PIN_SCK, LOW);

    // Latch both boards
    digitalWrite(PIN_CS, HIGH);
    delayMicroseconds(2);
    digitalWrite(PIN_CS, LOW);
}

inline void releaseBoard(char board) {
    if (board == 'R') updateBoards(0, maskL);
    else              updateBoards(maskR, 0);
}

inline void releaseAll() {
    updateBoards(0, 0);
}


// ============================================================
// STEPPER HELPERS
// ============================================================

void moveBoard(char board, int semitones, int rpm) {
    long target = (long)semitones * STEPS_PER_SEMITONE;
    float speed = constrain((float)rpm * STEPS_PER_SEMITONE / 60.0f,
                            200.0f, MAX_SPEED);

    if (board == 'R') {
        posR = semitones;
        stepperR.setMaxSpeed(speed);
        stepperR.moveTo(target);
    } else {
        posL = semitones;
        stepperL.setMaxSpeed(speed);
        stepperL.moveTo(target);
    }
}

void homeBoard(char board) {
    uint8_t      stopPin = (board == 'R') ? PIN_STOP_R : PIN_STOP_L;
    AccelStepper& st     = (board == 'R') ? stepperR   : stepperL;

    st.setMaxSpeed(HOME_SPEED);
    st.setAcceleration(4000.0f);
    st.move(-500000L);   // move far toward endstop

    while (digitalRead(stopPin) == HIGH) {
        st.run();
    }
    st.stop();
    st.setCurrentPosition(0);

    // Restore normal speed
    st.setMaxSpeed(MAX_SPEED);
    st.setAcceleration(ACCEL);

    if (board == 'R') posR = 0;
    else              posL = 0;

    Serial.printf("HOMED %c\n", board);
}


// ============================================================
// COMMAND PARSER
// ============================================================

void processCmd(const String& cmd) {
    if (cmd.length() == 0) return;

    // ---- MOVE R/L <offset> <rpm> ----
    if (cmd.startsWith("MOVE ") && cmd.length() > 7) {
        char  board  = cmd.charAt(5);
        int   offset = 0;
        int   rpm    = 200;
        sscanf(cmd.c_str() + 7, "%d %d", &offset, &rpm);
        moveBoard(board, offset, rpm);
        Serial.printf("OK MOVE %c %d\n", board, offset);

    // ---- FIRE R/L <0xMASK> <hold_ms> ----
    } else if (cmd.startsWith("FIRE ") && cmd.length() > 7) {
        char    board = cmd.charAt(5);
        char    maskStr[18] = {};
        int     hold  = DEFAULT_HOLD_MS;
        sscanf(cmd.c_str() + 7, "%17s %d", maskStr, &hold);
        hold = constrain(hold, 10, 2000);
        uint16_t mask = (uint16_t)strtol(maskStr, nullptr, 16);

        if (board == 'R') {
            updateBoards(mask, maskL);
            releaseR = millis() + (unsigned long)hold;
        } else {
            updateBoards(maskR, mask);
            releaseL = millis() + (unsigned long)hold;
        }
        Serial.printf("OK FIRE %c 0x%04X %d\n", board, mask, hold);

    // ---- RELEASE R/L ----
    } else if (cmd.startsWith("RELEASE ") && cmd.length() > 8) {
        char board = cmd.charAt(8);
        releaseBoard(board);
        if (board == 'R') releaseR = 0;
        else              releaseL = 0;
        Serial.printf("OK RELEASE %c\n", board);

    // ---- HOME ----
    } else if (cmd == "HOME") {
        homeBoard('R');
        homeBoard('L');
        Serial.println("OK HOME");

    // ---- STATUS ----
    } else if (cmd == "STATUS") {
        Serial.printf("STATUS R %d L %d\n", posR, posL);

    } else {
        Serial.print("ERR unknown: ");
        Serial.println(cmd);
    }
}


// ============================================================
// SETUP
// ============================================================

void setup() {
    Serial.begin(115200);

    // Shift register output pins
    pinMode(PIN_CS,    OUTPUT);  digitalWrite(PIN_CS,    LOW);
    pinMode(PIN_SCK,   OUTPUT);  digitalWrite(PIN_SCK,   LOW);
    pinMode(PIN_SER_A, OUTPUT);  digitalWrite(PIN_SER_A, LOW);
    pinMode(PIN_SER_B, OUTPUT);  digitalWrite(PIN_SER_B, LOW);

    // Clear all solenoids on startup
    releaseAll();

    // Endstop inputs
    pinMode(PIN_STOP_R, INPUT_PULLUP);
    pinMode(PIN_STOP_L, INPUT_PULLUP);

    // Stepper enable -- active LOW = steppers enabled
    pinMode(PIN_EN, OUTPUT);
    digitalWrite(PIN_EN, LOW);

    // Stepper config
    stepperR.setMaxSpeed(MAX_SPEED);
    stepperR.setAcceleration(ACCEL);
    stepperL.setMaxSpeed(MAX_SPEED);
    stepperL.setAcceleration(ACCEL);

    Serial.println("Voice2Piano Teensy ready");
}


// ============================================================
// LOOP
// ============================================================

void loop() {
    // Parse incoming serial commands
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            cmdBuf.trim();
            processCmd(cmdBuf);
            cmdBuf = "";
        } else if (cmdBuf.length() < 80) {
            cmdBuf += c;
        }
    }

    // Non-blocking stepper execution
    stepperR.run();
    stepperL.run();

    // Auto-release solenoids after hold time expires
    unsigned long now = millis();
    if (releaseR && now >= releaseR) {
        releaseBoard('R');
        releaseR = 0;
    }
    if (releaseL && now >= releaseL) {
        releaseBoard('L');
        releaseL = 0;
    }
}
