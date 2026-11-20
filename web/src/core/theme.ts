/**
 * The one place raw colour values live. Everything else (CSS, Tailwind, shadcn, three.js, CodeMirror)
 * reads them back as `--app-*` CSS variables, so a colour is changed here and nowhere else.
 * Roles, not hues: a role survives a redesign.
 */
export type Palette = {
  bg: string; // app ground
  card: string; // panels, cards, dialogs
  raised: string; // hover and selected fills
  line: string; // borders and dividers
  fg: string; // text
  dim: string; // secondary text
  faint: string; // tertiary text, placeholders
  brand: string; // accent
  onBrand: string; // text on the accent
  up: string; // success
  down: string; // error
  warn: string; // warning
  run: string; // in progress: a working agent, a running tool, an evaluation
  model: string; // 3D model surface
  grid: string; // 3D ground grid
  cat1: string; // categorical hues for fact chips and kind badges
  cat2: string;
  cat3: string;
  cat4: string;
  cat5: string;
  cat6: string;
  scaleLo: string; // sequential field scale (wall thickness): thin
  scaleMid: string;
  scaleHi: string; // thick
  devNeg: string; // diverging field scale (deviation): B has less material
  devZero: string; // no difference, and unknown values
  devPos: string; // B has more material
  cut: string; // the cut face of a section
};

export type Theme = { name: ThemeName; label: string; scheme: "light" | "dark"; C: Palette };
export type ThemeName = "light" | "dark";
/** What the user picked: a theme, or follow the operating system. */
export type ThemeChoice = ThemeName | "system";

export const THEMES: Record<ThemeName, Theme> = {
  light: {
    name: "light",
    label: "Light",
    scheme: "light",
    C: {
      bg: "#f6f6f4",
      card: "#ffffff",
      raised: "#ecece8",
      line: "#d9d9d3",
      fg: "#1b1b1a",
      dim: "#5a5a55",
      faint: "#8a8a83",
      brand: "#dc2626",
      onBrand: "#ffffff",
      up: "#15803d",
      down: "#b91c1c",
      warn: "#b45309",
      run: "#1d4ed8",
      model: "#8497b3",
      grid: "#cfcfc8",
      cat1: "#2563eb",
      cat2: "#7c3aed",
      cat3: "#0f766e",
      cat4: "#c2410c",
      cat5: "#be185d",
      cat6: "#4d7c0f",
      scaleLo: "#dc2626",
      scaleMid: "#f2c94c",
      scaleHi: "#2b7bb9",
      devNeg: "#2563eb",
      devZero: "#e4e4df",
      devPos: "#dc2626",
      cut: "#c2410c",
    },
  },
  dark: {
    name: "dark",
    label: "Dark",
    scheme: "dark",
    C: {
      bg: "#121211",
      card: "#1a1a19",
      raised: "#262624",
      line: "#363632",
      fg: "#ecece9",
      dim: "#a6a69f",
      faint: "#77776f",
      brand: "#dc2626",
      onBrand: "#ffffff",
      up: "#4ade80",
      down: "#f87171",
      warn: "#fbbf24",
      run: "#60a5fa",
      model: "#7d90ad",
      grid: "#3a3a36",
      cat1: "#60a5fa",
      cat2: "#a78bfa",
      cat3: "#2dd4bf",
      cat4: "#fb923c",
      cat5: "#f472b6",
      cat6: "#a3e635",
      scaleLo: "#f87171",
      scaleMid: "#facc15",
      scaleHi: "#38bdf8",
      devNeg: "#60a5fa",
      devZero: "#4a4a45",
      devPos: "#f87171",
      cut: "#fb923c",
    },
  },
};

export const DEFAULT_THEME: ThemeName = "dark";
export const THEME_STORAGE_KEY = "drawer.theme";
export const isThemeChoice = (v: string): v is ThemeChoice => v === "light" || v === "dark" || v === "system";
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export const PALETTE_KEYS = Object.keys(THEMES.light.C) as (keyof Palette)[];

/** CSS custom-property name of a palette key: `onBrand` -> `--app-on-brand`. */
export function cssVar(key: keyof Palette): string {
  return `--app-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export function themeToCss(selector: string, theme: Theme): string {
  const body = PALETTE_KEYS.map((k) => `${cssVar(k)}:${theme.C[k]};`).join("");
  return `${selector}{color-scheme:${theme.scheme};${body}}`;
}

/** All themes as CSS: light on `:root`, dark on `:root.dark`. */
export function allThemesCss(): string {
  return `${themeToCss(":root", THEMES.light)}${themeToCss(":root.dark", THEMES.dark)}`;
}
