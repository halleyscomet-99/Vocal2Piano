// Colour schemes after the ones in Windows 95/98 Display Properties → Appearance.
// Values follow those schemes' registry colours as closely as known; the title-bar
// gradients are this site's addition (Windows 95 used solid title bars).

export interface Scheme {
  name: string;
  desk: string; // desktop
  face: string; // window and button face
  hi: string; // bevel highlight
  lite: string; // inner bevel light
  shadow: string; // bevel shadow
  title: [string, string]; // active title bar gradient
  titleOff: [string, string]; // inactive title bar
  titleOffText: string;
  select: string; // selected list items, focus
  window: string; // text fields and lists
}

export const SCHEMES: Record<string, Scheme> = {
  desert: {
    name: "Desert",
    desk: "#a28d68",
    face: "#d5ccbb",
    hi: "#eae6dd",
    lite: "#e0d9cb",
    shadow: "#a28d68",
    title: ["#008080", "#4da6a6"],
    titleOff: ["#a28d68", "#c2b293"],
    titleOffText: "#d5ccbb",
    select: "#008080",
    window: "#fffbf0",
  },
  standard: {
    name: "Windows Standard",
    desk: "#008080",
    face: "#c0c0c0",
    hi: "#ffffff",
    lite: "#dfdfdf",
    shadow: "#808080",
    title: ["#000080", "#1084d0"],
    titleOff: ["#808080", "#b5b5b5"],
    titleOffText: "#c0c0c0",
    select: "#000080",
    window: "#ffffff",
  },
  eggplant: {
    name: "Eggplant",
    desk: "#588078",
    face: "#90b0a8",
    hi: "#c0d8d0",
    lite: "#a8c4bc",
    shadow: "#588078",
    title: ["#800080", "#b05ab0"],
    titleOff: ["#588078", "#78a098"],
    titleOffText: "#90b0a8",
    select: "#800080",
    window: "#ffffff",
  },
  rainy: {
    name: "Rainy Day",
    desk: "#4f6582",
    face: "#99a8ac",
    hi: "#c8d2d4",
    lite: "#b1bdc0",
    shadow: "#4f6582",
    title: ["#4f6582", "#8da3bc"],
    titleOff: ["#808080", "#a8b0b4"],
    titleOffText: "#c0c0c0",
    select: "#4f6582",
    window: "#ffffff",
  },
  plum: {
    name: "Plum",
    desk: "#402840",
    face: "#c8b8b8",
    hi: "#e8dcdc",
    lite: "#d8cccc",
    shadow: "#806070",
    title: ["#483048", "#906078"],
    titleOff: ["#806070", "#a08890"],
    titleOffText: "#c8b8b8",
    select: "#483048",
    window: "#ffffff",
  },
};

export const DEFAULT_SCHEME = "desert";
const STORE = "v2p.scheme";

export function loadScheme(): string {
  try {
    const s = localStorage.getItem(STORE);
    return s && s in SCHEMES ? s : DEFAULT_SCHEME;
  } catch {
    return DEFAULT_SCHEME;
  }
}

export function applyScheme(id: string) {
  const s = SCHEMES[id] ?? SCHEMES[DEFAULT_SCHEME];
  const v = document.documentElement.style;
  v.setProperty("--desk", s.desk);
  v.setProperty("--face", s.face);
  v.setProperty("--hi", s.hi);
  v.setProperty("--lite", s.lite);
  v.setProperty("--shadow", s.shadow);
  v.setProperty("--title-a", s.title[0]);
  v.setProperty("--title-b", s.title[1]);
  v.setProperty("--title-off-a", s.titleOff[0]);
  v.setProperty("--title-off-b", s.titleOff[1]);
  v.setProperty("--title-off-text", s.titleOffText);
  v.setProperty("--navy", s.select);
  v.setProperty("--window", s.window);
  try {
    localStorage.setItem(STORE, id);
  } catch {
    /* storage unavailable: scheme lasts for this visit only */
  }
}
