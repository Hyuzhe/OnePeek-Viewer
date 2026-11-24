import { DEFAULT_PALETTE, isValidPaletteId, type PaletteId } from "../core/palettes";
import type { ToolbarSide } from "../core/types";

const PROGRESS_PREFIX = "onepeek.progress.";
const THEME_KEY = "onepeek.theme";
const PALETTE_KEY = "onepeek.palette.v2";
const EPUB_TOC_KEY = "onepeek.epub.tocOpen";
const TOOLBAR_SIDE_KEY = "onepeek.toolbarSide";

export const StorageService = {
  saveReadingProgress(filePath: string, index: number): void {
    localStorage.setItem(PROGRESS_PREFIX + filePath.toLowerCase(), String(index));
  },

  loadReadingProgress(filePath: string): number {
    const val = localStorage.getItem(PROGRESS_PREFIX + filePath.toLowerCase());
    const parsed = val ? Number.parseInt(val, 10) : 0;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  },

  getDarkMode(): boolean {
    const saved = localStorage.getItem(THEME_KEY);
    return saved ? saved === "dark" : true;
  },

  setDarkMode(dark: boolean): void {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  },

  getPalette(): PaletteId {
    const saved = localStorage.getItem(PALETTE_KEY);
    return isValidPaletteId(saved) ? saved : DEFAULT_PALETTE;
  },

  setPalette(palette: PaletteId): void {
    localStorage.setItem(PALETTE_KEY, palette);
  },

  getEpubTocOpen(): boolean {
    return localStorage.getItem(EPUB_TOC_KEY) === "1";
  },

  setEpubTocOpen(open: boolean): void {
    localStorage.setItem(EPUB_TOC_KEY, open ? "1" : "0");
  },

  getToolbarSide(): ToolbarSide {
    return localStorage.getItem(TOOLBAR_SIDE_KEY) === "left" ? "left" : "right";
  },

  setToolbarSide(side: ToolbarSide): void {
    localStorage.setItem(TOOLBAR_SIDE_KEY, side);
  },
};
