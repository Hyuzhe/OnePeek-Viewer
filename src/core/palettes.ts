import { tKey } from "../i18n";

export type PaletteId = "chimp" | "ocean" | "emerald" | "rose" | "graphite" | "indigo";

export interface PaletteOption {
  id: PaletteId;
  label: string;
  accent: string;
}

export const DEFAULT_PALETTE: PaletteId = "chimp";

export const PALETTE_OPTIONS: readonly PaletteOption[] = [
  { id: "chimp", label: "极客猿", accent: "#f5b700" },
  { id: "ocean", label: "晴空蓝", accent: "#0ea5e9" },
  { id: "emerald", label: "翡翠绿", accent: "#10b981" },
  { id: "rose", label: "珊瑚玫", accent: "#f43f5e" },
  { id: "graphite", label: "极简灰", accent: "#52525b" },
  { id: "indigo", label: "星云紫", accent: "#6366f1" },
];

export function getPaletteLabel(id: PaletteId): string {
  return tKey(`palette.${id}`);
}

export function isValidPaletteId(val: string | null): val is PaletteId {
  return val !== null && PALETTE_OPTIONS.some((p) => p.id === val);
}
