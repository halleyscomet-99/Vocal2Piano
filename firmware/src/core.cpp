#include "core.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

using namespace cfg;

namespace {

int carriage(const char* s) {
  if (!s || s[1]) return -1;
  if (s[0] == 'B') return BASS;
  if (s[0] == 'T') return TREBLE;
  return -1;
}

// Whole-number field; false if missing or not a number.
bool num(const char* s, long& out) {
  if (!s || !*s) return false;
  char* end;
  out = strtol(s, &end, 10);
  return *end == 0;
}

bool real(const char* s, float& out) {
  if (!s || !*s) return false;
  char* end;
  out = strtof(s, &end);
  return *end == 0;
}

} // namespace

void Core::reply(const char* fmt, ...) {
  char buf[96];
  va_list a;
  va_start(a, fmt);
  vsnprintf(buf, sizeof buf, fmt, a);
  va_end(a);
  hw.print(buf);
}

// ---------- Commands ----------

void Core::command(char* line) {
  char* f[8] = {};
  int n = 0;
  for (char* tok = strtok(line, " \t\r"); tok && n < 8; tok = strtok(nullptr, " \t\r")) f[n++] = tok;
  if (!n) return;
  const char* cmd = f[0];
  long a, b, d, e;

  if (!strcmp(cmd, "HELLO")) {
    reply("V2P 1");
    for (int c = 0; c < 2; c++)
      if (!hw.board(c)) reply("ERR no PCA9685 at 0x%02X (%s)", I2C_ADDR[c], c == BASS ? "bass" : "treble");
  } else if (!strcmp(cmd, "CFG")) {
    float s, ac, k;
    if (n != 6 || !real(f[1], s) || !real(f[2], ac) || !real(f[3], k) || !num(f[4], a) || !num(f[5], b) || s <= 0 || ac <= 0 || k <= 0 || a < 1 || b < 0 || b > 100)
      return reply("ERR bad CFG");
    speed = fminf(s, SPEED_LIMIT_MM);
    accel = fminf(ac, ACCEL_LIMIT_MM);
    keyMm = k;
    strikeMs = a;
    holdPct = b;
    reply("OK");
    if (speed < s || accel < ac)
      reply("LOG speed limited to %.0f mm/s and %.0f mm/s2 (config.h): long moves will run late", speed, accel);
  } else if (!strcmp(cmd, "HOME")) {
    startHoming();
  } else if (!strcmp(cmd, "ZERO")) {
    zero = hw.millis();
  } else if (!strcmp(cmd, "STOP")) {
    stop();
    reply("OK");
  } else if (!strcmp(cmd, "M")) {
    int c = carriage(f[1]);
    if (n != 4 || c < 0 || !num(f[2], a) || !num(f[3], b) || b < 0) return reply("ERR bad M");
    schedule({uint32_t(b), MOVE, uint8_t(c), 0, 0, 0, int16_t(a)});
  } else if (!strcmp(cmd, "S")) {
    int c = carriage(f[1]);
    if (n != 6 || c < 0 || !num(f[2], a) || !num(f[3], b) || !num(f[4], d) || !num(f[5], e) || a < 0 || a >= CHANNELS || b < 0 || d < 1 || e < 0 || e > 4095)
      return reply("ERR bad S");
    schedule({uint32_t(b), STRIKE, uint8_t(c), uint8_t(a), uint16_t(e), uint16_t(d > 65535 ? 65535 : d), 0});
  }
  // Bring-up commands, for a serial monitor (README.md).
  else if (!strcmp(cmd, "POS")) {
    reply("POS B %.2f T %.2f END %d %d %s", hw.position(BASS) / keyMm, hw.position(TREBLE) / keyMm, hw.endstop(BASS), hw.endstop(TREBLE), homed_ ? "homed" : "not-homed");
  } else if (!strcmp(cmd, "JOG")) {
    int c = carriage(f[1]);
    float mm;
    if (n != 3 || c < 0 || !real(f[2], mm)) return reply("ERR bad JOG");
    target[c] = hw.position(c) + mm;
    hw.moveTo(c, target[c], HOME_SPEED_MM, HOME_ACCEL_MM);
    reply("OK");
  } else if (!strcmp(cmd, "GO")) {
    int c = carriage(f[1]);
    if (n != 3 || c < 0 || !num(f[2], a)) return reply("ERR bad GO");
    move(c, a);
  } else if (!strcmp(cmd, "TEST")) {
    int c = carriage(f[1]);
    if (n != 3 || c < 0 || !num(f[2], a) || a < 0 || a >= CHANNELS) return reply("ERR bad TEST");
    strike(c, a, 150, 4095);
    reply("OK");
  } else {
    reply("ERR unknown command %s", cmd);
  }
}

// Commands arrive 0.1–0.3 s early and out of order (moves and strikes are separate streams).
void Core::schedule(const Event& e) {
  uint32_t t = now();
  if (e.t + DROP_LATE_MS < t) {
    dropped++;
    if (t - e.t > lateMax) lateMax = t - e.t;
    return;
  }
  if (e.t + 10 < t && t - e.t > lateMax) lateMax = t - e.t;
  if (count == QUEUE) return reply("ERR queue full");
  int i = count++;
  while (i > 0 && queue[i - 1].t > e.t) {
    queue[i] = queue[i - 1];
    i--;
  }
  queue[i] = e;
}

void Core::tick() {
  uint32_t t = now();
  next = 0;
  while (next < count && queue[next].t <= t) run(queue[next++]);
  if (next) {
    memmove(queue, queue + next, (count - next) * sizeof(Event));
    count -= next;
    next = 0;
  }

  // Strike → hold → release, per channel.
  uint32_t ms = hw.millis();
  for (int c = 0; c < 2; c++)
    for (int k = 0; k < CHANNELS; k++) {
      Channel& x = ch[c][k];
      if (x.phase == OFF) continue;
      if (int32_t(ms - x.releaseAt) >= 0) {
        release(c, k);
      } else if (x.phase == STRIKING && int32_t(ms - x.holdAt) >= 0) {
        // Holding takes less than striking; never more than the strike itself (light black keys).
        uint16_t hold = uint16_t(4095UL * holdPct / 100);
        if (hold > x.duty) hold = x.duty;
        x.phase = HOLDING;
        x.amps = SOLENOID_AMPS * hold / 4095.0f;
        hw.pwm(c, k, hold);
      }
    }

  homingTick();
  guard();
  report();
}

void Core::run(const Event& e) {
  if (e.type == MOVE) move(e.c, e.pos);
  else strike(e.c, e.ch, e.dur, e.pwm);
}

// ---------- Motion ----------

void Core::move(int c, int pos) {
  if (!homed_) return reply("ERR not homed");
  float mm = pos * keyMm;
  // Not past the end stop it homed against (HOME_KEYS may leave A0 or D7 out of reach).
  bool beyond = (mm - HOME_KEYS[c] * keyMm) * HOME_DIR[c] > 0.01f;
  if (pos < 0 || pos > MAX_POS || beyond) return reply("ERR position %d out of range", pos);
  float gap = MIN_GAP_KEYS * keyMm;
  // Not into the other carriage: where it's going if it's on the move, or where it stands.
  // Both moving the same way is fine; guard() stops everything if one ever catches the other.
  // A move of the other carriage due at the same moment counts as already started, so a pair
  // of moves the planner made together works in either order.
  int o = 1 - c;
  float other = hw.moving(o) ? target[o] : hw.position(o);
  for (int i = next; i < count && queue[i].t <= now(); i++)
    if (queue[i].type == MOVE && queue[i].c == o) {
      other = queue[i].pos * keyMm;
      break;
    }
  if (c == BASS && mm > other - gap + 0.01f) return reply("ERR bass %d too close to treble", pos);
  if (c == TREBLE && mm < other + gap - 0.01f) return reply("ERR treble %d too close to bass", pos);
  target[c] = mm;
  hw.moveTo(c, mm, speed, accel);
}

void Core::startHoming() {
  stop();
  homed_ = false;
  homeStart = hw.millis();
  for (int c = 0; c < 2; c++) {
    homing[c] = SEEKING;
    // Far past the end stop; the switch stops it.
    hw.setPosition(c, 0);
    hw.moveTo(c, HOME_DIR[c] * 2000.0f, HOME_SPEED_MM, HOME_ACCEL_MM);
  }
}

void Core::homingTick() {
  if (homing[0] == IDLE && homing[1] == IDLE) return;
  for (int c = 0; c < 2; c++) {
    if (homing[c] == SEEKING && hw.endstop(c)) {
      hw.halt(c);
      hw.setPosition(c, HOME_KEYS[c] * keyMm);
      target[c] = HOME_KEYS[c] * keyMm - HOME_DIR[c] * BACKOFF_MM;
      hw.moveTo(c, target[c], HOME_SPEED_MM, HOME_ACCEL_MM);
      homing[c] = BACKING;
    } else if (homing[c] == BACKING && !hw.moving(c)) {
      homing[c] = DONE;
    }
  }
  if (homing[0] == DONE && homing[1] == DONE) {
    homing[0] = homing[1] = IDLE;
    homed_ = true;
    reply("HOMED");
  } else if (hw.millis() - homeStart > HOME_TIMEOUT_MS) {
    for (int c = 0; c < 2; c++) {
      hw.halt(c);
      homing[c] = IDLE;
    }
    reply("ERR homing failed: an end stop was not reached");
  }
}

// Checked every tick, whatever the commands say.
void Core::guard() {
  bool homingNow = homing[0] != IDLE || homing[1] != IDLE;
  if (homingNow) return;
  for (int c = 0; c < 2; c++) {
    // Pressed while the carriage should still be clear of it: steps were lost on the way.
    // Only after homing; before that, positions mean nothing (JOG still stops at the switch).
    bool pressed = hw.endstop(c);
    bool towards = (target[c] - hw.position(c)) * HOME_DIR[c] > 0;
    if (pressed && towards && !homed_) {
      hw.halt(c);
      target[c] = hw.position(c);
      reply("LOG %s end stop reached", c == BASS ? "bass" : "treble");
    } else if (pressed && homed_ && fabsf(hw.position(c) - HOME_KEYS[c] * keyMm) > SLIP_MM) {
      hw.halt(c);
      stop();
      homed_ = false;
      return reply("ERR %s end stop hit %.0f mm early (lost steps); home again", c == BASS ? "bass" : "treble", fabsf(hw.position(c) - HOME_KEYS[c] * keyMm));
    }
  }
  if (homed_ && hw.position(TREBLE) - hw.position(BASS) < (MIN_GAP_KEYS - 0.25f) * keyMm) {
    hw.halt(BASS);
    hw.halt(TREBLE);
    stop();
    homed_ = false;
    reply("ERR carriages too close; home again");
  }
}

// ---------- Solenoids ----------

float Core::amps() {
  float sum = 0;
  for (auto& row : ch)
    for (auto& x : row) sum += x.amps;
  return sum;
}

void Core::strike(int c, int k, uint32_t dur, uint16_t pwm) {
  Channel& x = ch[c][k];
  if (k >= FIRST_BLACK) pwm = uint16_t(pwm * BLACK_SCALE);
  float need = SOLENOID_AMPS * pwm / 4095.0f;
  if (amps() - x.amps + need > BUDGET_AMPS + 0.001f) {
    overBudget++;
    return;
  }
  uint32_t ms = hw.millis();
  if (dur > MAX_HOLD_MS) dur = MAX_HOLD_MS;
  x.phase = STRIKING;
  x.amps = need;
  x.duty = pwm;
  x.holdAt = ms + strikeMs;
  x.releaseAt = ms + dur;
  hw.pwm(c, k, pwm);
}

void Core::release(int c, int k) {
  ch[c][k] = Channel();
  hw.pwm(c, k, 0);
}

void Core::stop() {
  count = 0;
  for (int c = 0; c < 2; c++) {
    for (int k = 0; k < CHANNELS; k++) release(c, k);
    if (homing[c] != IDLE) {
      hw.halt(c);
      homing[c] = IDLE;
    } else if (hw.moving(c)) {
      hw.decelerate(c);
    }
    // Wherever it comes to rest is the new reference for collision checks.
    target[c] = hw.position(c);
  }
}

void Core::report() {
  uint32_t ms = hw.millis();
  if (int32_t(ms - reportAt) < 250) return;
  reportAt = ms;
  if (lateMax) reply("LATE %lu", (unsigned long)lateMax);
  if (dropped) reply("LOG dropped %d commands that came over %lu ms late", dropped, (unsigned long)DROP_LATE_MS);
  if (overBudget) reply("LOG skipped %d strikes over the %.1f A current budget", overBudget, BUDGET_AMPS);
  lateMax = 0;
  dropped = overBudget = 0;
}
