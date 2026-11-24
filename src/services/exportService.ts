// Shared high-resolution PNG / PDF export pipeline for OnePeek visual viewers.
import { Download, FileText, Image as ImageIcon } from "lucide-react";
import type { PDFPageProxy } from "pdfjs-dist";
import { createElement } from "react";
import type { BottomToolGroup, BottomToolItem } from "../components/BottomToolBar";
import { getActiveLocale, tKey } from "../i18n";
import { FileBridge } from "./fileBridge";

export const TOAST_EVENT = "onepeek:toast";
const MAX_EXPORT_DIM = 4096;
const TARGET_VECTOR_DIM = 2400;
const textEncoder = new TextEncoder();

export interface ToastDetail {
  message: string;
  tone: "ok" | "error";
}

export function notifyToast(message: string, tone: "ok" | "error" = "ok"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail: { message, tone } }));
}

export function stripExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".nii.gz")) return fileName.slice(0, -7) || "export";
  if (lower.endsWith(".tar.gz")) return fileName.slice(0, -7) || "export";
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName || "export";
}

function clampDims(w: number, h: number, maxDim = MAX_EXPORT_DIM): { w: number; h: number } {
  const safeW = Math.max(1, w);
  const safeH = Math.max(1, h);
  const maxSide = Math.max(safeW, safeH);
  if (maxSide <= maxDim) {
    return { w: Math.round(safeW), h: Math.round(safeH) };
  }
  const scale = maxDim / maxSide;
  return {
    w: Math.max(1, Math.round(safeW * scale)),
    h: Math.max(1, Math.round(safeH * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas image encoding failed"));
      },
      mime,
      quality
    );
  });
}

export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await canvasToBlob(canvas, "image/png");
  return new Uint8Array(await blob.arrayBuffer());
}

function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Wrap a canvas snapshot inside a clean standards-compliant single-page PDF 1.4 container.
 */
export async function canvasToPdfBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const { w, h } = clampDims(canvas.width, canvas.height, MAX_EXPORT_DIM);
  const flatCanvas = document.createElement("canvas");
  flatCanvas.width = w;
  flatCanvas.height = h;
  const ctx = flatCanvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // Flatten alpha against crisp white paper for PDF viewing and printing.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);

  const jpegBlob = await canvasToBlob(flatCanvas, "image/jpeg", 0.94);
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

  const ptScale = Math.min(1, 842 / Math.max(w, h));
  const pageW = Math.max(72, Number((w * ptScale).toFixed(2)));
  const pageH = Math.max(72, Number((h * ptScale).toFixed(2)));
  const contentStream = `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  const pushStr = (text: string) => {
    const encoded = textEncoder.encode(text);
    chunks.push(encoded);
    cursor += encoded.byteLength;
  };
  const pushBytes = (bytes: Uint8Array) => {
    chunks.push(bytes);
    cursor += bytes.byteLength;
  };
  const beginObj = (id: number) => {
    offsets.push(cursor);
    pushStr(`${id} 0 obj\n`);
  };

  pushStr("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");

  beginObj(1);
  pushStr("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObj(2);
  pushStr("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  beginObj(3);
  pushStr(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`
  );

  beginObj(4);
  pushStr(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`);

  beginObj(5);
  pushStr(
    `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`
  );
  pushBytes(jpegBytes);
  pushStr("\nendstream\nendobj\n");

  const xrefPos = cursor;
  pushStr(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) {
    pushStr(`${String(off).padStart(10, "0")} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return concatUint8Arrays(chunks);
}

/**
 * Rasterize a DOM SVG element into a crisp high-DPI offscreen canvas.
 */
export async function svgElementToCanvas(
  svgEl: SVGSVGElement,
  widthHint: number,
  heightHint: number,
  whiteBg: boolean
): Promise<HTMLCanvasElement> {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const baseW = Math.max(1, widthHint || svgEl.viewBox.baseVal.width || 1200);
  const baseH = Math.max(1, heightHint || svgEl.viewBox.baseVal.height || 900);
  const scale = Math.min(3, Math.max(1, TARGET_VECTOR_DIM / Math.max(baseW, baseH)));
  const out = clampDims(baseW * scale, baseH * scale, MAX_EXPORT_DIM);

  clone.setAttribute("width", String(out.w));
  clone.setAttribute("height", String(out.h));
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${baseW} ${baseH}`);
  }

  const serialized = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("SVG rasterization failed"));
      el.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = out.w;
    canvas.height = out.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");

    if (whiteBg) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.w, out.h);
    }
    ctx.drawImage(img, 0, 0, out.w, out.h);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Draw an already-loaded HTMLImageElement onto a canvas honoring optional 90-deg rotation and flip.
 */
export function imageElementToCanvas(
  img: HTMLImageElement,
  options?: { rotation?: number; flipped?: boolean; whiteBg?: boolean }
): HTMLCanvasElement {
  const natW = Math.max(1, img.naturalWidth || img.width || 1);
  const natH = Math.max(1, img.naturalHeight || img.height || 1);
  const rotDeg = (((options?.rotation ?? 0) % 360) + 360) % 360;
  const swapAxes = rotDeg === 90 || rotDeg === 270;
  const target = clampDims(swapAxes ? natH : natW, swapAxes ? natW : natH, MAX_EXPORT_DIM);

  const canvas = document.createElement("canvas");
  canvas.width = target.w;
  canvas.height = target.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  if (options?.whiteBg) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, target.w, target.h);
  }

  ctx.save();
  ctx.translate(target.w * 0.5, target.h * 0.5);
  if (rotDeg !== 0) {
    ctx.rotate((rotDeg * Math.PI) / 180);
  }
  if (options?.flipped) {
    ctx.scale(-1, 1);
  }
  const drawW = swapAxes ? target.h : target.w;
  const drawH = swapAxes ? target.w : target.h;
  ctx.drawImage(img, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
  ctx.restore();
  return canvas;
}

function formatDesktopSavedLocation(targetPath: string, fallbackName: string): string {
  const parts = targetPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length >= 2) {
    const sep = targetPath.includes("\\") ? "\\" : "/";
    return `${parts[parts.length - 2]}${sep}${parts[parts.length - 1]}`;
  }
  return parts[0] || fallbackName;
}

function formatAndroidSavedLocation(rawLocation: string): string {
  if (getActiveLocale() !== "zh") return rawLocation;
  if (rawLocation.startsWith("Pictures/")) {
    return `相册/${rawLocation.slice("Pictures/".length)}`;
  }
  if (rawLocation.startsWith("Download/")) {
    return `下载/${rawLocation.slice("Download/".length)}`;
  }
  return rawLocation;
}

/**
 * Prompt Save As on desktop (native IPC write) or persist to MediaStore/SAF on Android.
 */
export async function saveExportBytes(
  baseName: string,
  ext: "png" | "pdf",
  bytes: Uint8Array
): Promise<boolean> {
  const defaultName = `${stripExtension(baseName)}.${ext}`;

  if (!FileBridge.isAndroid()) {
    const targetPath = await FileBridge.saveExportDialog(defaultName, ext);
    if (!targetPath) return false;
    await FileBridge.writeExportFile(targetPath, bytes);
    const displayPath = formatDesktopSavedLocation(targetPath, defaultName);
    notifyToast(tKey("export.saved", { name: displayPath }), "ok");
    return true;
  }

  const savedLocation = await FileBridge.saveAndroidExport(defaultName, ext, bytes);
  if (!savedLocation) return false;
  notifyToast(tKey("export.saved", { name: formatAndroidSavedLocation(savedLocation) }), "ok");
  return true;
}

export async function exportCanvasAs(
  canvas: HTMLCanvasElement | null | undefined,
  baseName: string,
  ext: "png" | "pdf"
): Promise<boolean> {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error("Canvas is not ready for export");
  }
  const bytes = ext === "png" ? await canvasToPngBytes(canvas) : await canvasToPdfBytes(canvas);
  return saveExportBytes(baseName, ext, bytes);
}

export async function exportSvgAs(
  svgEl: SVGSVGElement | null | undefined,
  widthHint: number,
  heightHint: number,
  whiteBgForPng: boolean,
  baseName: string,
  ext: "png" | "pdf"
): Promise<boolean> {
  if (!svgEl) {
    throw new Error("Vector SVG element is not ready");
  }
  const canvas = await svgElementToCanvas(
    svgEl,
    widthHint,
    heightHint,
    ext === "pdf" ? true : whiteBgForPng
  );
  return exportCanvasAs(canvas, baseName, ext);
}

export async function renderPdfPageToCanvas(
  page: PDFPageProxy,
  transparent: boolean
): Promise<HTMLCanvasElement> {
  const baseVp = page.getViewport({ scale: 1 });
  const maxSide = Math.max(1, baseVp.width, baseVp.height);
  const scale = Math.min(3, Math.max(1, TARGET_VECTOR_DIM / maxSide));
  const clampedScale =
    maxSide * scale > MAX_EXPORT_DIM ? MAX_EXPORT_DIM / maxSide : scale;
  const vp = page.getViewport({ scale: clampedScale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  await page.render({
    canvasContext: ctx,
    viewport: vp,
    background: transparent ? "rgba(0,0,0,0)" : "#ffffff",
  }).promise;
  return canvas;
}

let exportInFlight = false;

async function runGuardedExport(task: () => Promise<void>): Promise<void> {
  if (exportInFlight) return;
  exportInFlight = true;
  try {
    await task();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    notifyToast(tKey("export.failed", { reason }), "error");
  } finally {
    exportInFlight = false;
  }
}

export interface ExportToolGroupOptions {
  onExportPng?: () => Promise<void>;
  pngLabel?: string;
  pngTitle?: string;
  onExportPdf?: () => Promise<void>;
  pdfLabel?: string;
  pdfTitle?: string;
  extraItems?: BottomToolItem[];
}

export function createExportToolGroup(opts: ExportToolGroupOptions): BottomToolGroup {
  const items: BottomToolItem[] = [];
  if (opts.onExportPng) {
    const handler = opts.onExportPng;
    items.push({
      kind: "action",
      key: "export-png",
      label: opts.pngLabel ?? tKey("tool.exportPng"),
      icon: createElement(ImageIcon, { size: 14 }),
      dismiss: "instant",
      title: opts.pngTitle ?? tKey("tool.exportPngTitle"),
      onClick: () => void runGuardedExport(handler),
    });
  }
  if (opts.onExportPdf) {
    const handler = opts.onExportPdf;
    items.push({
      kind: "action",
      key: "export-pdf",
      label: opts.pdfLabel ?? tKey("tool.exportPdf"),
      icon: createElement(FileText, { size: 14 }),
      dismiss: "instant",
      title: opts.pdfTitle ?? tKey("tool.exportPdfTitle"),
      onClick: () => void runGuardedExport(handler),
    });
  }
  if (opts.extraItems) {
    items.push(...opts.extraItems);
  }
  return {
    id: "export",
    label: tKey("tool.export"),
    icon: createElement(Download, { size: 14 }),
    items,
  };
}
