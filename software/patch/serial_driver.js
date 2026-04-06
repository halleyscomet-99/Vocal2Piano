/**
 * serial_driver.js  —  Max JS object for Vocal2Piano Teensy serial control
 *
 * Receives CC 85-93 from Voice2Piano_Harmony (sent by MIDI2Chords.py).
 * On CC 93 (commit), reconstructs rail positions and solenoid masks,
 * formats MOVE and FIRE ASCII commands, outputs as byte lists to [serial].
 *
 * INLET 0: CC number (int)
 * INLET 1: CC value  (int)
 * OUTLET 0: list of ASCII byte values → connect to [serial] object
 * OUTLET 1: status string             → connect to display
 *
 * USAGE IN MAX:
 *   [ctlin]
 *   |      |
 *   [js serial_driver.js]
 *   |                   |
 *   [serial COM3]    [message]   ← status display
 *
 * Set the serial port name via message: "port COM3" or "port /dev/tty.usbmodem1"
 *
 * CC PROTOCOL (from MIDI2Chords.py):
 *   CC 85: right rail offset + 12   (decode: value - 12 → semitones, range -12..+24)
 *   CC 86: left  rail offset + 12
 *   CC 87: right mask bits  0-6
 *   CC 88: right mask bits  7-13
 *   CC 89: right mask bit   14
 *   CC 90: left  mask bits  0-6
 *   CC 91: left  mask bits  7-13
 *   CC 92: left  mask bit   14
 *   CC 93: commit  (value = 0 → send commands now)
 */

inlets  = 2;
outlets = 2;

// State collected from CCs
var state = {
    rightRail: 0,
    leftRail:  0,
    rightMask: 0,
    leftMask:  0,
};

// Hardware defaults
var HOLD_MS  = 80;
var SPEED_RPM = 200;

// CC → state field mapping
var CC_MAP = {
    85: function(v) { state.rightRail = v - 12; },
    86: function(v) { state.leftRail  = v - 12; },
    87: function(v) { state.rightMask  = (state.rightMask & ~0x7F)   | (v & 0x7F); },
    88: function(v) { state.rightMask  = (state.rightMask & ~0x3F80) | ((v & 0x7F) << 7); },
    89: function(v) { state.rightMask  = (state.rightMask & ~0x4000) | ((v & 0x01) << 14); },
    90: function(v) { state.leftMask   = (state.leftMask  & ~0x7F)   | (v & 0x7F); },
    91: function(v) { state.leftMask   = (state.leftMask  & ~0x3F80) | ((v & 0x7F) << 7); },
    92: function(v) { state.leftMask   = (state.leftMask  & ~0x4000) | ((v & 0x01) << 14); },
};

// Receive CC number on inlet 0, value on inlet 1
var pendingCC = -1;

function msg_int(v) {
    if (inlet === 0) {
        pendingCC = v;
    } else if (inlet === 1 && pendingCC >= 0) {
        var cc = pendingCC;
        pendingCC = -1;

        if (CC_MAP[cc]) {
            CC_MAP[cc](v);
        } else if (cc === 93) {
            // Commit: send all commands
            sendCommands();
        }
    }
}

function sendCommands() {
    var r = state.rightRail;
    var l = state.leftRail;
    var rm = state.rightMask & 0x7FFF;
    var lm = state.leftMask  & 0x7FFF;

    // Format hex mask as uppercase 4-digit hex
    var rhex = "0x" + zeroPad(rm.toString(16).toUpperCase(), 4);
    var lhex = "0x" + zeroPad(lm.toString(16).toUpperCase(), 4);

    // Commands to send (order: MOVE right, MOVE left, FIRE right, FIRE left)
    var cmds = [
        "MOVE R " + r + " " + SPEED_RPM,
        "MOVE L " + l + " " + SPEED_RPM,
        "FIRE R " + rhex + " " + HOLD_MS,
        "FIRE L " + lhex + " " + HOLD_MS,
    ];

    for (var i = 0; i < cmds.length; i++) {
        sendString(cmds[i] + "\r\n");
    }

    // Status display
    outlet(1, "R[" + r + "] " + rhex + "  L[" + l + "] " + lhex);
}

/**
 * Convert an ASCII string to a list of byte values and output on outlet 0.
 * Connect outlet 0 → [serial a] (or whichever port letter).
 * [serial] in Max accepts a list of integers as bytes.
 */
function sendString(s) {
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
        bytes.push(s.charCodeAt(i));
    }
    // outlet() with an array outputs a list message
    outlet(0, bytes);
}

function zeroPad(s, n) {
    while (s.length < n) s = "0" + s;
    return s;
}

// Allow changing hold time and speed via messages
function hold(ms) { HOLD_MS = ms; }
function speed(rpm) { SPEED_RPM = rpm; }

// Send HOME command manually
function home() {
    sendString("HOME\r\n");
    outlet(1, "HOME sent");
}

// Send STATUS query
function status() {
    sendString("STATUS\r\n");
    outlet(1, "STATUS sent");
}
