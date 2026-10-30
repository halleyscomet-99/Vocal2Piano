"""Shared by the transcription scripts: where local demos go and how they are listed.

site/local/ is git-ignored and served only by the dev server, so transcriptions of other
people's songs stay on this machine.
"""

import json
import re
from pathlib import Path

SITE_LOCAL = Path(__file__).resolve().parent.parent / "site" / "local"


def demo_file(name: str) -> Path:
    SITE_LOCAL.mkdir(parents=True, exist_ok=True)
    return SITE_LOCAL / (re.sub(r"[^\w-]+", "-", name.lower()).strip("-") + ".mid")


def add_demo(name: str, path: Path, bpm: float, bars: int, source: str):
    """List the file in site/local/demos.json, replacing an older entry for it.

    source is "score" (typed from sheet music) or "recording" (transcribed from audio).
    """
    manifest = SITE_LOCAL / "demos.json"
    demos = json.loads(manifest.read_text()) if manifest.exists() else []
    demos = [d for d in demos if d.get("file") != path.name]
    demos.append({"name": name, "file": path.name, "bpm": round(bpm), "bars": bars, "source": source})
    manifest.write_text(json.dumps(demos, indent=2))
