# Vocal2Piano: Adaptive Multi-DOF Robotic Accompaniment System

Vocal2Piano is an end-to-end robotic system designed to perform real-time piano accompaniment from vocal input. The system features a sophisticated mechatronic assembly, deep-learning-based audio transcription, and high-precision motion control.

![Project Status](https://img.shields.io/badge/Status-In--Development-orange)
![Platform](https://img.shields.io/badge/Platform-Teensy%204.1-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Overview

Unlike traditional robotic pianos, Vocal2Piano utilizes a **Deep Learning MIR (Music Information Retrieval)** pipeline to transcribe vocal pitch and rhythm into MIDI data. This data is dynamically mapped to a coordinated state-space involving:
* **Dual 30-Actuator Modules:** 60 independent solenoids capable of percussive performance.
* **Synchronous Belt Linear Rail:** A high-speed carriage system that extends the playable range across the full piano keyboard.

## Technical Highlights

* **ML-Driven Transcription:** Real-time MIR pipeline for pitch tracking and vocal-to-MIDI mapping.
* **Precision Motion Control:** Teensy 4.1 firmware utilizing hardware interrupts and trapezoidal acceleration profiles for sub-ms control latency.
* **Custom Power Electronics:** Multi-layer PCB design featuring **TPS5430** buck converters for 12V-to-5V regulation and high-current isolation for **TMC2209** silent stepper drivers.
* **Modular Mechatronics:** SolidWorks-optimized CAD with 3D-printed end-effectors designed for high-frequency durability.

## Project Structure

```text
Vocal2Piano/
├── firmware/              # Teensy 4.1 C++ source code (Motion control, 595 logic)
├── hardware/
│   ├── CAD/               # SolidWorks models and 3D-printed STL files
│   └── PCB/               # KiCad design files
│       ├── libraries/     # Custom footprints (TMC2209, Teensy 4.1, etc.)
│       └── fabrication/   # Gerbers, BOM, and CPL files for JLCPCB
└── software/              # MIR Pipeline (Python/ML models for audio processing)