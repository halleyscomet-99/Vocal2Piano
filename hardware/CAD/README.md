# CAD / Mechanical Design

Mechanical design files for the Vocal2Piano system — linear rail assemblies, solenoid mounts, and the piano interface bracket.

---

## Contents

```
hardware/cad/
├── assembly/              Full system assembly files
│   └── Vocal2Piano_full_assembly.step
├── simulation/            Animation of the full system
│   └── Vocal2Piano_demo.mp4       solenoids firing + rail movement
├── printable/             3D printable parts
│   ├── solenoid_mount_left.stl
│   ├── solenoid_mount_right.stl
│   ├── rail_bracket_piano.stl
│   ├── rail_end_cap.stl
│   └── teensy_enclosure.stl
└── drawings/              2D reference drawings (PDF)
```

---

## System animation

`simulation/Vocal2Piano_demo.mp4` shows the full system running:
- Both rails sliding to different positions
- Solenoids firing in response to chord events
- The interplay between left and right boards covering different octaves

---

## 3D printable parts

All parts are designed for FDM printing. No supports needed unless noted.

| File | Material | Infill | Layer height | Notes |
|------|----------|--------|--------------|-------|
| `solenoid_mount_left.stl` | PETG | 40% | 0.2mm | Print 2× |
| `solenoid_mount_right.stl` | PETG | 40% | 0.2mm | Print 2× |
| `rail_bracket_piano.stl` | PETG | 50% | 0.2mm | Mounts to piano frame |
| `rail_end_cap.stl` | PLA | 20% | 0.2mm | Print 4× (both ends, both rails) |
| `teensy_enclosure.stl` | PLA | 20% | 0.15mm | Optional |

PETG recommended for parts that contact the solenoids — better heat resistance than PLA under sustained operation.

---

## Assembly notes

The two rail assemblies are independent and identical in construction. Each holds 15 solenoids spaced at piano key intervals, driven by a NEMA17 stepper on a GT2 belt.

The `rail_bracket_piano.stl` bracket clamps to the piano's key bed frame without adhesive or modification to the instrument.

Refer to the full assembly file (`Vocal2Piano_full_assembly.step`) for part placement and hardware dimensions.