import type { WarningKind } from "../engine/types";

/** Problems that mean a note will be missing or late (the rest are harmless changes). */
export const SEVERE = new Set<WarningKind>(["dropped", "late-move", "current"]);

export const PROBLEM_LABEL: Record<WarningKind, string> = {
  dropped: "Can't reach",
  "late-move": "Hand too slow",
  current: "Too many at once",
  thinned: "Chord simplified",
  folded: "Moved an octave",
  hold: "Shortened",
};
