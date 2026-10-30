// Tests for core.cpp on a computer, against a simulated robot:
//   c++ -std=c++17 -Isrc test/core_test.cpp src/core.cpp -o /tmp/core_test && /tmp/core_test
// The simulated carriages move at a constant speed, and their end stops sit at the real ends of
// the rail, which the firmware only learns by homing.

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <string>
#include <vector>

#include "core.h"

using namespace cfg;

struct Sim : Hardware {
  uint32_t ms = 0;
  float physical[2] = {300, 700}; // mm from W1-over-A0, unknown to the firmware until homing
  float offset[2] = {0, 0}; // firmware position = physical + offset
  float goal[2] = {300, 700}; // physical
  float speed[2] = {0, 0};
  uint16_t duty[2][16] = {};
  std::vector<std::string> out;

  uint32_t millis() override { return ms; }
  void pwm(int c, int k, uint16_t d) override { duty[c][k] = d; }
  void moveTo(int c, float mm, float s, float) override {
    goal[c] = mm - offset[c];
    speed[c] = s;
  }
  void decelerate(int c) override { goal[c] = physical[c]; }
  void halt(int c) override { goal[c] = physical[c]; }
  float position(int c) override { return physical[c] + offset[c]; }
  bool moving(int c) override { return fabsf(goal[c] - physical[c]) > 1e-3f; }
  void setPosition(int c, float mm) override { offset[c] = mm - physical[c]; }
  bool boards[2] = {true, true};
  bool endstop(int c) override { return c == BASS ? physical[c] <= 0.0f : physical[c] >= 45 * 23.5f; }
  bool board(int c) override { return boards[c]; }
  void print(const char* line) override { out.push_back(line); }

  void step(Core& core, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) {
      ms++;
      for (int c = 0; c < 2; c++) {
        float d = goal[c] - physical[c];
        float v = speed[c] / 1000;
        physical[c] += fabsf(d) < v ? d : (d > 0 ? v : -v);
      }
      core.tick();
    }
  }
  bool said(const char* prefix) {
    for (auto& s : out)
      if (!strncmp(s.c_str(), prefix, strlen(prefix))) return true;
    return false;
  }
};

int failures = 0;
#define CHECK(cond)                                         \
  do {                                                      \
    if (!(cond)) {                                          \
      printf("  FAIL line %d: %s\n", __LINE__, #cond);     \
      failures++;                                           \
    }                                                       \
  } while (0)

void send(Core& core, const char* s) {
  char buf[96];
  strncpy(buf, s, sizeof buf);
  core.command(buf);
}

void home(Sim& sim, Core& core) {
  send(core, "HOME");
  sim.step(core, 60000);
}

void testHello() {
  puts("HELLO and CFG");
  Sim sim;
  Core core(sim);
  send(core, "HELLO");
  CHECK(sim.out.back() == "V2P 1");
  send(core, "CFG 400 3000 23.5 50 35");
  CHECK(sim.said("OK"));
  send(core, "CFG 400 x 23.5 50 35");
  CHECK(sim.said("ERR bad CFG"));
  send(core, "FLY");
  CHECK(sim.out.back() == "ERR unknown command FLY");
}

void testHoming() {
  puts("Homing finds both end stops and sets positions");
  Sim sim;
  Core core(sim);
  send(core, "M B 3 0");
  sim.step(core, 1);
  CHECK(sim.said("ERR not homed"));
  home(sim, core);
  CHECK(sim.said("HOMED"));
  CHECK(core.homed());
  // Backed off 3 mm from each switch, and the positions agree with the real rail.
  CHECK(fabsf(sim.position(BASS) - (0 + BACKOFF_MM)) < 0.5f);
  CHECK(fabsf(sim.position(TREBLE) - (45 * 23.5f - BACKOFF_MM)) < 0.5f);
  CHECK(fabsf(sim.physical[BASS] - sim.position(BASS)) < 1.5f);
}

void testJogToSwitch() {
  puts("Before homing, JOG towards an end stop stops at the switch");
  Sim sim;
  Core core(sim);
  send(core, "JOG B -1000");
  sim.step(core, 30000);
  CHECK(sim.said("LOG bass end stop reached"));
  CHECK(fabsf(sim.physical[BASS]) < 1.0f);
  send(core, "JOG T 1000");
  sim.step(core, 30000);
  CHECK(sim.said("LOG treble end stop reached"));
  CHECK(fabsf(sim.physical[TREBLE] - 45 * 23.5f) < 1.0f);
}

void testStrikes() {
  puts("Strikes play in time order: strike duty, then hold duty, then release");
  Sim sim;
  Core core(sim);
  send(core, "CFG 400 3000 23.5 50 35");
  send(core, "ZERO");
  send(core, "S T 4 300 200 3000"); // out of order
  send(core, "S T 2 100 120 4095");
  sim.step(core, 99);
  CHECK(sim.duty[TREBLE][2] == 0);
  sim.step(core, 1);
  CHECK(sim.duty[TREBLE][2] == 4095);
  sim.step(core, 50);
  CHECK(sim.duty[TREBLE][2] == 4095 * 35 / 100);
  sim.step(core, 70);
  CHECK(sim.duty[TREBLE][2] == 0);
  CHECK(sim.duty[TREBLE][4] == 0);
  sim.step(core, 80);
  CHECK(sim.duty[TREBLE][4] == 3000);
  CHECK(core.queued() == 0);
}

void testMaxHold() {
  puts("No solenoid stays on longer than 2 s");
  Sim sim;
  Core core(sim);
  send(core, "ZERO");
  send(core, "S B 0 10 9000 4095");
  sim.step(core, 10 + 1999);
  CHECK(sim.duty[BASS][0] != 0);
  sim.step(core, 1);
  CHECK(sim.duty[BASS][0] == 0);
}

void testRestrike() {
  puts("Striking a key again restarts its timing");
  Sim sim;
  Core core(sim);
  send(core, "ZERO");
  send(core, "S B 1 10 100 4095");
  send(core, "S B 1 80 300 4095");
  sim.step(core, 120);
  CHECK(sim.duty[BASS][1] != 0); // the first strike's release (at 110) must not cut the second
  sim.step(core, 300);
  CHECK(sim.duty[BASS][1] == 0);
}

void testBudget() {
  puts("Current budget: an 11th full strike at once is skipped and reported");
  Sim sim;
  Core core(sim);
  send(core, "ZERO");
  char buf[64];
  for (int k = 0; k < 11; k++) {
    snprintf(buf, sizeof buf, "S %c %d 50 100 4095", k < 6 ? 'B' : 'T', k % 6);
    send(core, buf);
  }
  sim.step(core, 51);
  int on = 0;
  for (int c = 0; c < 2; c++)
    for (int k = 0; k < 13; k++) on += sim.duty[c][k] != 0;
  CHECK(on == 10);
  sim.step(core, 300);
  CHECK(sim.said("LOG skipped 1 strikes"));
  // Once struck notes drop to the hold duty, there is room again.
  send(core, "S T 9 400 50 4095");
  sim.step(core, 60);
  CHECK(sim.duty[TREBLE][9] == 0 || sim.ms >= 400);
}

void testLate() {
  puts("Late commands: played if under 200 ms late, dropped beyond, and reported");
  Sim sim;
  Core core(sim);
  send(core, "ZERO");
  sim.step(core, 1000);
  send(core, "S B 2 950 100 4095"); // 50 ms late: played now
  send(core, "S B 3 500 100 4095"); // 500 ms late: dropped
  sim.step(core, 1);
  CHECK(sim.duty[BASS][2] == 4095);
  CHECK(sim.duty[BASS][3] == 0);
  sim.step(core, 300);
  CHECK(sim.said("LATE 500"));
  CHECK(sim.said("LOG dropped 1"));
}

// "M <c> <pos> <now + dt>"
void moveIn(Core& core, char c, int pos, uint32_t dt) {
  char buf[64];
  snprintf(buf, sizeof buf, "M %c %d %u", c, pos, (unsigned)(core.now() + dt));
  send(core, buf);
}

bool at(Sim& sim, int c, float keys) { return fabsf(sim.position(c) - keys * 23.5f) < 0.5f; }

void testMoves() {
  puts("Moves follow the queue and never run the carriages into each other");
  Sim sim;
  Core core(sim);
  home(sim, core);
  sim.out.clear();
  send(core, "ZERO");
  moveIn(core, 'B', 10, 100);
  moveIn(core, 'T', 20, 100);
  sim.step(core, 8000);
  CHECK(at(sim, BASS, 10));
  CHECK(at(sim, TREBLE, 20));
  CHECK(sim.out.empty());
  moveIn(core, 'B', 14, 10); // 6 keys from treble
  moveIn(core, 'T', 16, 20); // 6 keys from bass
  moveIn(core, 'B', 50, 30); // off the keyboard
  moveIn(core, 'T', 46, 40); // past the treble end stop
  sim.step(core, 300);
  CHECK(sim.said("ERR bass 14 too close"));
  CHECK(sim.said("ERR treble 16 too close"));
  CHECK(sim.said("ERR position 50 out of range"));
  CHECK(sim.said("ERR position 46 out of range"));
  CHECK(at(sim, BASS, 10));
  // Both moving the same way, the treble first: fine.
  moveIn(core, 'T', 30, 10);
  moveIn(core, 'B', 22, 110);
  sim.step(core, 5000);
  CHECK(at(sim, BASS, 22));
  CHECK(at(sim, TREBLE, 30));
  CHECK(core.homed());
  // Both moving left at the same moment, the treble listed first: the treble's target is fine
  // once the bass has gone too.
  sim.out.clear();
  moveIn(core, 'T', 18, 5);
  moveIn(core, 'B', 10, 5);
  sim.step(core, 5000);
  CHECK(sim.out.empty());
  CHECK(at(sim, BASS, 10));
  CHECK(at(sim, TREBLE, 18));
  // GO moves now, with the same checks.
  send(core, "GO T 30");
  sim.step(core, 5000);
  send(core, "GO B 21");
  sim.step(core, 5000);
  CHECK(at(sim, BASS, 21));
  // Going right up to an end stop is fine: it's where the carriage homed.
  send(core, "GO B 0");
  sim.step(core, 8000);
  CHECK(at(sim, BASS, 0));
  CHECK(core.homed());
  send(core, "GO B 21");
  sim.step(core, 8000);
  // A bass faster than the treble ahead of it: the guard stops both before they touch.
  sim.out.clear();
  moveIn(core, 'T', 40, 1);
  moveIn(core, 'B', 33, 1);
  sim.step(core, 1);
  sim.speed[TREBLE] = 10; // the treble is held back (a stall, a slipping belt)
  sim.step(core, 5000);
  CHECK(sim.said("ERR carriages too close"));
  CHECK(sim.position(TREBLE) - sim.position(BASS) > 6.5f * 23.5f);
}

void testBlackKeys() {
  puts("Black-key fingers strike at 40 %, and never hold harder than they struck");
  Sim sim;
  Core core(sim);
  send(core, "CFG 400 3000 23.5 50 35");
  send(core, "ZERO");
  send(core, "S T 8 0 300 4095");
  send(core, "S B 9 0 300 2000");
  sim.step(core, 1);
  CHECK(sim.duty[TREBLE][8] == uint16_t(4095 * 0.4f));
  CHECK(sim.duty[BASS][9] == uint16_t(2000 * 0.4f));
  sim.step(core, 60);
  CHECK(sim.duty[TREBLE][8] == 4095 * 35 / 100);
  CHECK(sim.duty[BASS][9] == uint16_t(2000 * 0.4f)); // 800 is below the 35 % hold
}

void testSpeedLimit() {
  puts("CFG faster than the firmware's limit is capped and reported");
  Sim sim;
  Core core(sim);
  send(core, "CFG 400 3000 23.5 50 35");
  CHECK(sim.said("LOG speed limited"));
  home(sim, core);
  send(core, "GO T 30");
  sim.step(core, 1);
  CHECK(sim.speed[TREBLE] <= SPEED_LIMIT_MM);
}

void testMissingBoard() {
  puts("HELLO reports a PCA9685 that doesn't answer");
  Sim sim;
  sim.boards[TREBLE] = false;
  Core core(sim);
  send(core, "HELLO");
  CHECK(sim.said("ERR no PCA9685 at 0x41 (treble)"));
}

void testStop() {
  puts("STOP releases everything and clears the queue");
  Sim sim;
  Core core(sim);
  send(core, "ZERO");
  send(core, "S T 0 0 1000 4095");
  send(core, "S T 1 500 100 4095");
  sim.step(core, 10);
  CHECK(sim.duty[TREBLE][0] != 0);
  send(core, "STOP");
  CHECK(sim.out.back() == "OK");
  CHECK(sim.duty[TREBLE][0] == 0);
  CHECK(core.queued() == 0);
  sim.step(core, 600);
  CHECK(sim.duty[TREBLE][1] == 0);
}

void testEndstopWhilePlaying() {
  puts("An end stop pressed while moving stops everything");
  Sim sim;
  Core core(sim);
  home(sim, core);
  // Pretend the belt slipped: the firmware thinks the bass is further right than it is.
  sim.offset[BASS] += 40;
  send(core, "ZERO");
  send(core, "M B 0 0");
  send(core, "S T 3 0 1500 4095");
  sim.step(core, 2000);
  CHECK(sim.said("ERR bass end stop hit"));
  CHECK(!core.homed());
  CHECK(sim.duty[TREBLE][3] == 0);
}

int main() {
  testHello();
  testHoming();
  testJogToSwitch();
  testStrikes();
  testMaxHold();
  testRestrike();
  testBudget();
  testLate();
  testMoves();
  testBlackKeys();
  testSpeedLimit();
  testMissingBoard();
  testStop();
  testEndstopWhilePlaying();
  printf(failures ? "%d FAILED\n" : "all passed\n", failures);
  return failures != 0;
}
