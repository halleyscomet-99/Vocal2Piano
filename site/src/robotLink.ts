// USB serial link to the Teensy (Web Serial, Chrome/Edge). Commands are streamed a
// fraction of a second ahead of when they should happen, each with a timestamp on the
// device clock.
// Protocol: firmware/PROTOCOL.md.

import { type CarriageId, ROBOT, WHITE_KEY_MM } from "./engine/robot";

// Minimal Web Serial types (not in TypeScript's DOM lib yet).
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

export type LinkStatus = "disconnected" | "connecting" | "connected";

const CODE: Record<CarriageId, string> = { treble: "T", bass: "B" };

export class RobotLink {
  status: LinkStatus = "disconnected";
  device: string | null = null; // reply to HELLO, e.g. "V2P 1"
  homed = false;
  log: string[] = [];
  /** Last position each carriage was sent to (white-key index), for planning the lead-in. */
  pos: Partial<Record<CarriageId, number>> = {};
  onChange: () => void = () => {};

  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private zeroAt = 0; // performance.now() of device t = 0
  private enc = new TextEncoder();

  static supported() {
    return "serial" in navigator;
  }

  private note(line: string) {
    this.log = [...this.log.slice(-49), line];
    this.onChange();
  }

  async connect() {
    const serial = (navigator as unknown as { serial: SerialLike }).serial;
    this.status = "connecting";
    this.onChange();
    try {
      this.port = await serial.requestPort();
      await this.port.open({ baudRate: 115200 });
    } catch (e) {
      this.status = "disconnected";
      this.note(`× ${e instanceof Error ? e.message : "could not open the port"}`);
      return;
    }
    this.writer = this.port.writable!.getWriter();
    void this.readLoop();
    this.status = "connected";
    this.send("HELLO");
    // Keep the firmware's motion profile identical to what the planner assumed.
    this.send(`CFG ${ROBOT.carriageSpeedMm} ${ROBOT.carriageAccelMm} ${WHITE_KEY_MM} ${Math.round(ROBOT.strikeTime * 1000)} ${Math.round(ROBOT.holdDuty * 100)}`);
    this.onChange();
  }

  async disconnect() {
    this.send("STOP");
    try {
      await this.reader?.cancel();
      this.writer?.releaseLock();
      await this.port?.close();
    } catch {
      /* already gone */
    }
    this.port = this.writer = this.reader = null;
    this.status = "disconnected";
    this.device = null;
    this.homed = false;
    this.onChange();
  }

  private async readLoop() {
    const dec = new TextDecoder();
    let buf = "";
    this.reader = this.port!.readable!.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          if (line.startsWith("V2P")) this.device = line;
          if (line === "HOMED") this.homed = true;
          this.note(`← ${line}`);
        }
      }
    } catch {
      /* port closed or unplugged */
    }
    if (this.status === "connected") {
      this.status = "disconnected";
      this.note("× robot disconnected");
    }
  }

  send(line: string) {
    if (!this.writer) return;
    void this.writer.write(this.enc.encode(line + "\n")).catch(() => {});
    if (!line.startsWith("S ") && !line.startsWith("M ")) this.note(`→ ${line}`);
  }

  private t(perfMs: number) {
    return Math.max(0, Math.round(perfMs - this.zeroAt));
  }

  /** Restart the device clock at "now" (sent before each performance). */
  zero() {
    this.send("STOP");
    this.send("ZERO");
    this.zeroAt = performance.now();
  }

  home() {
    this.homed = false;
    this.pos = {};
    this.send("HOME");
  }

  move(c: CarriageId, pos: number, perfMs: number) {
    this.pos[c] = pos;
    this.send(`M ${CODE[c]} ${pos} ${this.t(perfMs)}`);
  }

  strike(c: CarriageId, channel: number, perfMs: number, durMs: number, pwm: number) {
    this.send(`S ${CODE[c]} ${channel} ${this.t(perfMs)} ${Math.max(1, Math.round(durMs))} ${pwm}`);
  }

  stop() {
    this.send("STOP");
  }
}
