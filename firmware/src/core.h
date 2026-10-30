// The protocol and the safety rules, independent of the hardware so they can be tested on a
// computer (test/core_test.cpp). main.cpp supplies the Hardware for the Teensy.
// Protocol: PROTOCOL.md.
#pragma once
#include <stdint.h>

#include "config.h"

// What the core needs from the board. Positions and speeds are in mm (see config.h).
struct Hardware {
  virtual uint32_t millis() = 0;
  virtual void pwm(int c, int ch, uint16_t duty) = 0; // 0 = off, 4095 = fully on
  virtual void moveTo(int c, float mm, float speed, float accel) = 0;
  virtual void decelerate(int c) = 0; // stop with the current deceleration
  virtual void halt(int c) = 0; // stop on the spot
  virtual float position(int c) = 0;
  virtual bool moving(int c) = 0;
  virtual void setPosition(int c, float mm) = 0;
  virtual bool endstop(int c) = 0;
  virtual bool board(int c) = 0; // the carriage's PCA9685 answers on I2C
  virtual void print(const char* line) = 0;
  virtual ~Hardware() {}
};

class Core {
 public:
  explicit Core(Hardware& hw) : hw(hw) {}

  /** One received line, without the newline. */
  void command(char* line);
  /** Call as often as possible. */
  void tick();
  /** Release everything, stop the motors, clear the queue (STOP, or USB lost). */
  void stop();

  bool homed() const { return homed_; }
  int queued() const { return count; }
  uint32_t now() { return hw.millis() - zero; }

 private:
  enum Type : uint8_t { MOVE, STRIKE };
  struct Event {
    uint32_t t;
    Type type;
    uint8_t c;
    uint8_t ch;
    uint16_t pwm;
    uint16_t dur;
    int16_t pos;
  };
  enum Phase : uint8_t { OFF, STRIKING, HOLDING };
  struct Channel {
    Phase phase = OFF;
    uint32_t holdAt = 0;
    uint32_t releaseAt = 0;
    float amps = 0;
    uint16_t duty = 0; // of the strike
  };
  enum Homing : uint8_t { IDLE, SEEKING, BACKING, DONE };

  static constexpr int QUEUE = 256;

  Hardware& hw;
  Event queue[QUEUE];
  int count = 0;
  int next = 0; // while tick() runs the queue: the first event not yet run
  Channel ch[2][cfg::CHANNELS];
  uint32_t zero = 0;

  float speed = cfg::SPEED_MM < cfg::SPEED_LIMIT_MM ? cfg::SPEED_MM : cfg::SPEED_LIMIT_MM;
  float accel = cfg::ACCEL_MM < cfg::ACCEL_LIMIT_MM ? cfg::ACCEL_MM : cfg::ACCEL_LIMIT_MM;
  float keyMm = cfg::KEY_MM;
  uint32_t strikeMs = cfg::STRIKE_MS;
  uint8_t holdPct = cfg::HOLD_PCT;

  bool homed_ = false;
  Homing homing[2] = {IDLE, IDLE};
  uint32_t homeStart = 0;
  float target[2] = {0, 0}; // mm, where each carriage was last sent

  // LATE and over-budget reports are gathered and sent at most every 250 ms.
  uint32_t lateMax = 0;
  int dropped = 0;
  int overBudget = 0;
  uint32_t reportAt = 0;

  void reply(const char* fmt, ...);
  void schedule(const Event& e);
  void run(const Event& e);
  void move(int c, int pos);
  void strike(int c, int channel, uint32_t dur, uint16_t pwm);
  void release(int c, int channel);
  float amps();
  void startHoming();
  void homingTick();
  void guard();
  void report();
};
