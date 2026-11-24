import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Maximize2,
  MoveHorizontal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { BottomPageNav } from "../components/BottomPageNav";
import { BottomToolBar, type BottomToolGroup } from "../components/BottomToolBar";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ViewerProps } from "../core/types";
import { useI18n } from "../i18n";
import {
  createExportToolGroup,
  exportCanvasAs,
  renderPdfPageToCanvas,
  stripExtension,
} from "../services/exportService";
import { FileBridge } from "../services/fileBridge";
import { StorageService } from "../services/storage";
import { ViewerError, ViewerLoading } from "../components/StatusView";
import { useStageWheelZoom } from "./office/useStageWheelZoom";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfFitMode = "page" | "width" | "manual";

interface Size2D {
  width: number;
  height: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 5;

function computePdfScale(
  fitMode: PdfFitMode,
  manualScale: number,
  baseSize: Size2D | null,
  stageSize: Size2D
): number {
  if (fitMode === "manual") return manualScale;
  if (!baseSize || baseSize.width <= 0 || baseSize.height <= 0) return 1;

  const pad = stageSize.width < 600 ? 16 : 28;
  const bottomReserve = stageSize.width < 600 ? 74 : 58;
  const availW = Math.max(80, stageSize.width - pad);
  const availH = Math.max(80, stageSize.height - pad - bottomReserve);

  if (fitMode === "width") {
    return Math.max(0.01, availW / baseSize.width);
  }
  return Math.max(0.01, Math.min(availW / baseSize.width, availH / baseSize.height));
}

function clampManualScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

export function PdfViewer({ file }: ViewerProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  const [totalPages, setTotalPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [fitMode, setFitMode] = useState<PdfFitMode>("page");
  const [manualScale, setManualScale] = useState(1);
  const [baseSize, setBaseSize] = useState<Size2D | null>(null);
  const [stageSize, setStageSize] = useState<Size2D>({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Observe available stage dimensions via rAF-coalesced ResizeObserver
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    let rafId = 0;
    const syncSize = () => {
      const nextW = el.clientWidth;
      const nextH = el.clientHeight;
      setStageSize((prev) =>
        prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }
      );
    };

    syncSize();
    const observer = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(syncSize);
    });
    observer.observe(el);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [error]);

  // Load PDF binary and initialize PDFDocumentProxy
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setBaseSize(null);
    setFitMode("page");

    const loader = FileBridge.readBinary(file.path);
    loader
      .then((buf) => pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise)
      .then((pdfDoc) => {
        if (!active) {
          pdfDoc.destroy();
          return;
        }
        docRef.current?.destroy();
        docRef.current = pdfDoc;
        setTotalPages(pdfDoc.numPages);
        const saved = StorageService.loadReadingProgress(file.path);
        const startPage = Math.min(Math.max(1, saved || 1), pdfDoc.numPages);
        setPageNum(startPage);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      active = false;
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, [file.path]);

  // Render active page onto HiDPI canvas using exact fitted or manual scale
  useEffect(() => {
    const pdfDoc = docRef.current;
    const canvas = canvasRef.current;
    if (!pdfDoc || !canvas || loading || stageSize.width <= 0 || stageSize.height <= 0) {
      return;
    }

    let renderTask: pdfjsLib.RenderTask | null = null;
    let cancelled = false;

    pdfDoc
      .getPage(pageNum)
      .then((page) => {
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const pageBase: Size2D = {
          width: baseViewport.width,
          height: baseViewport.height,
        };
        setBaseSize((prev) =>
          prev && prev.width === pageBase.width && prev.height === pageBase.height
            ? prev
            : pageBase
        );

        const renderScale = computePdfScale(fitMode, manualScale, pageBase, stageSize);
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: renderScale });
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTask = page.render({ canvasContext: ctx, viewport });
        renderTask.promise.catch(() => {});
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pageNum, fitMode, manualScale, stageSize, loading, totalPages]);

  const effectiveScale = useMemo(
    () => computePdfScale(fitMode, manualScale, baseSize, stageSize),
    [fitMode, manualScale, baseSize, stageSize]
  );

  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const base = effectiveScale > 0 ? effectiveScale : 1;
      const next = direction > 0 ? base * 1.15 : base / 1.15;
      setFitMode("manual");
      setManualScale(clampManualScale(next));
    },
    [effectiveScale]
  );

  useStageWheelZoom(stageRef, stepZoom);

  const goPage = useCallback(
    (next: number) => {
      if (totalPages <= 0) return;
      const clamped = Math.min(Math.max(1, Math.round(next || 1)), totalPages);
      setPageNum(clamped);
      StorageService.saveReadingProgress(file.path, clamped);
      if (stageRef.current) {
        stageRef.current.scrollTop = 0;
      }
    },
    [file.path, totalPages]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (e.altKey || tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goPage(pageNum - 1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        goPage(pageNum + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPage, pageNum]);

  if (error) {
    return (
      <ViewerError
        title={t("pdf.errPdf")}
        detail={error}
      />
    );
  }

  const pagePngBase =
    totalPages > 1 ? `${stripExtension(file.name)}_p${pageNum}` : file.name;

  const toolGroups: BottomToolGroup[] = [
    {
      id: "zoom",
      label: t("tool.zoom"),
      icon: <ZoomIn size={14} />,
      items: [
        {
          kind: "action",
          key: "zoom-out",
          label: t("tool.zoomOut"),
          icon: <ZoomOut size={15} />,
          dismiss: "stepper",
          title: t("tool.zoomWheelOutTitle"),
          onClick: () => stepZoom(-1),
        },
        {
          kind: "badge",
          key: "zoom-pct",
          text: `${Math.round(effectiveScale * 100)}%`,
        },
        {
          kind: "action",
          key: "zoom-in",
          label: t("tool.zoomIn"),
          icon: <ZoomIn size={15} />,
          dismiss: "stepper",
          title: t("tool.zoomWheelInTitle"),
          onClick: () => stepZoom(1),
        },
      ],
    },
    {
      id: "view",
      label: t("tool.view"),
      icon: <Maximize2 size={14} />,
      active: fitMode !== "page",
      items: [
        {
          kind: "action",
          key: "fit-page",
          label: t("tool.zoomReset"),
          icon: <Maximize2 size={14} />,
          active: fitMode === "page",
          dismiss: "instant",
          title: t("pdf.fitPageTitle"),
          onClick: () => setFitMode("page"),
        },
        {
          kind: "action",
          key: "fit-width",
          label: t("pdf.fitWidth"),
          icon: <MoveHorizontal size={14} />,
          active: fitMode === "width",
          dismiss: "instant",
          title: t("pdf.fitWidthTitle"),
          onClick: () => setFitMode("width"),
        },
      ],
    },
    createExportToolGroup({
      onExportPng: async () => {
        const pdfDoc = docRef.current;
        if (!pdfDoc) throw new Error("Document is not loaded yet");
        const page = await pdfDoc.getPage(pageNum);
        const canvas = await renderPdfPageToCanvas(page, false);
        await exportCanvasAs(canvas, pagePngBase, "png");
      },
    }),
  ];

  return (
    <div className="viewer-shell viewer-shell-rel">
      {loading && (
        <div className="stage-loading-overlay">
          <ViewerLoading message={t("pdf.loadingPdf")} />
        </div>
      )}

      <div
        ref={stageRef}
        className="doc-scroll-stage pdf-stage"
        style={{
          overflow: fitMode === "page" ? "hidden" : "auto",
          visibility: loading ? "hidden" : "visible",
        }}
      >
        <canvas ref={canvasRef} className="pdf-canvas" />
      </div>

      {totalPages > 0 && (
        <BottomPageNav
          currentPage={pageNum}
          totalPages={totalPages}
          unitLabel={t("common.unit.page")}
          editable
          disabled={loading}
          onGoPage={goPage}
        />
      )}

      <BottomToolBar groups={toolGroups} />
    </div>
  );
}
