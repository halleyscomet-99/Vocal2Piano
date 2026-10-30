// Vocal2Piano firmware for the Teensy 4.1 on the C0nTrollER board.
// Two NEMA17 carriages (TMC2209, STEP/DIR/EN) and two PLAyeRs solenoid boards (PCA9685 over I2C),
// driven by timestamped commands streamed from the site over USB serial (PROTOCOL.md).
// The protocol and safety rules live in core.cpp; this file is the hardware.

#include <AccelStepper.h>
#include <Adafruit_PWMServoDriver.h>
#include <Arduino.h>
#include <Wire.h>

#include "config.h"
#include "core.h"

using namespace cfg;

AccelStepper steppers[2] = {
    AccelStepper(AccelStepper::DRIVER, PIN_STEP[BASS], PIN_DIR[BASS]),
    AccelStepper(AccelStepper::DRIVER, PIN_STEP[TREBLE], PIN_DIR[TREBLE]),
};
Adafruit_PWMServoDriver boards[2] = {Adafruit_PWMServoDriver(I2C_ADDR[BASS], Wire), Adafruit_PWMServoDriver(I2C_ADDR[TREBLE], Wire)};

// Steps are generated in a timer interrupt, so I2C writes and USB never stall the motors.
IntervalTimer stepTimer;
void stepISR() {
  steppers[0].run();
  steppers[1].run();
}

// Debounced end stops: pressed only after 3 equal readings in a row (~1 ms apart).
volatile bool pressed[2] = {false, false};
uint8_t streak[2] = {0, 0};
uint32_t lastRead = 0;
void readEndstops() {
  uint32_t us = micros();
  if (us - lastRead < 1000) return;
  lastRead = us;
  for (int c = 0; c < 2; c++) {
    bool p = digitalReadFast(PIN_ENDSTOP[c]) == LOW;
    if (p == pressed[c]) streak[c] = 0;
    else if (++streak[c] >= 3) {
      pressed[c] = p;
      streak[c] = 0;
    }
  }
}

bool present[2] = {false, false};

struct Teensy : Hardware {
  uint32_t millis() override { return ::millis(); }
  void pwm(int c, int k, uint16_t duty) override { boards[c].setPin(k, duty); }
  void moveTo(int c, float mm, float speed, float accel) override {
    digitalWriteFast(PIN_EN[c], LOW); // drivers stay on from the first move, holding position
    noInterrupts();
    steppers[c].setMaxSpeed(speed * STEPS_PER_MM);
    steppers[c].setAcceleration(accel * STEPS_PER_MM);
    steppers[c].moveTo(lroundf(mm * STEPS_PER_MM));
    interrupts();
  }
  void decelerate(int c) override {
    noInterrupts();
    steppers[c].stop();
    interrupts();
  }
  void halt(int c) override {
    noInterrupts();
    steppers[c].setCurrentPosition(steppers[c].currentPosition()); // also zeroes the speed
    interrupts();
  }
  float position(int c) override {
    noInterrupts();
    long p = steppers[c].currentPosition();
    interrupts();
    return p / STEPS_PER_MM;
  }
  bool moving(int c) override {
    noInterrupts();
    bool m = steppers[c].distanceToGo() != 0;
    interrupts();
    return m;
  }
  void setPosition(int c, float mm) override {
    noInterrupts();
    steppers[c].setCurrentPosition(lroundf(mm * STEPS_PER_MM));
    interrupts();
  }
  bool endstop(int c) override { return pressed[c]; }
  bool board(int c) override { return present[c]; }
  void print(const char* line) override {
    if (Serial.dtr()) Serial.println(line);
  }
};

Teensy hw;
Core core(hw);
char line[96];
int len = 0;
bool connected = false;

void setup() {
  Serial.begin(115200);
  for (int c = 0; c < 2; c++) {
    pinMode(PIN_ENDSTOP[c], INPUT_PULLUP);
    pinMode(PIN_EN[c], OUTPUT);
    digitalWriteFast(PIN_EN[c], HIGH); // drivers off until the first move, so the motors stay cool
    steppers[c].setPinsInverted(DIR_INVERT[c], false, false);
    steppers[c].setMinPulseWidth(2);
  }
  Wire.begin();
  Wire.setClock(I2C_HZ);
  for (int c = 0; c < 2; c++) {
    Wire.beginTransmission(I2C_ADDR[c]);
    present[c] = Wire.endTransmission() == 0;
  }
  for (auto& b : boards) {
    b.begin();
    b.setPWMFreq(PWM_HZ);
    b.setOutputMode(true); // totem pole, straight into the MOSFET gates
    for (int k = 0; k < 16; k++) b.setPin(k, 0);
  }
  stepTimer.begin(stepISR, 20); // 50 kHz, well above the fastest step rate
}

void loop() {
  // A closed port (site disconnected, cable pulled) counts as STOP.
  bool dtr = Serial.dtr();
  if (connected && !dtr) core.stop();
  connected = dtr;

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line[len] = 0;
      core.command(line);
      len = 0;
    } else if (len < int(sizeof line) - 1) {
      line[len++] = c;
    }
  }
  readEndstops();
  core.tick();
}
