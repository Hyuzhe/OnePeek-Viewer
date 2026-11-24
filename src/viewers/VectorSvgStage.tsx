// Shared scalable SVG viewport stage that resizes layout geometry instead of CSS scale() for lossless zoom up to 6400%.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BottomPageNav } from "../components/BottomPageNav";
import { BottomToolBar, createCanvasToolGroups, type BottomToolGroup } from "../components/BottomToolBar";
import { useI18n } from "../i18n";
import { createExportToolGroup, exportSvgAs } from "../services/exportService";
import { usePanZoomStage } from "./usePanZoomStage";

interface VectorSvgStageProps {
  svgMarkup: string;
  widthPt: number;
  heightPt: number;
  unitLabel?: "pt" | "px";
  modeLabel?: string;
  paperMode?: "white" | "transparent";
  autoFitContentBounds?: boolean;
  resetKey: string;
  exportBaseName?: string;
  totalPages?: number;
  currentPage?: number;
  pageUnitLabel?: string;
  prevLabel?: string;
  nextLabel?: string;
  disabled?: boolean;
  onGoPage?: (page: number) => void;
  onPrevSibling: () => void;
  onNextSibling: () => void;
  extraToolGroups?: BottomToolGroup[];
}

interface StageSize {
  w: number;
  h: number;
}

const NON_GEOMETRY_TAGS = new Set([
  "defs",
  "style",
  "title",
  "desc",
  "metadata",
  "lineargradient",
  "radialgradient",
  "clippath",
  "mask",
  "pattern",
]);

function hasNoFillStyle(el: Element): boolean {
  const fillAttr = (el.getAttribute("fill") || "").trim().toLowerCase();
  if (fillAttr === "none") return true;
  const styleAttr = (el.getAttribute("style") || "").toLowerCase();
  return /(?:^|;)\s*fill\s*:\s*none\b/.test(styleAttr);
}

/**
 * Expands viewBox when CorelDRAW pasteboard artwork sits outside the nominal page rectangle.
 */
function fitCorelSvgContentBounds(
  svgEl: SVGSVGElement,
  pageW: number,
  pageH: number
): { w: number; h: number } | null {
  try {
    const children = Array.from(svgEl.children);
    if (children.length >= 2 && children[0].localName.toLowerCase() === "path" && hasNoFillStyle(children[0])) {
      const firstGraphic = children[0] as unknown as SVGGraphicsElement;
      if (typeof firstGraphic.getBBox === "function") {
        const fb = firstGraphic.getBBox();
        const isPageFrame =
          Math.abs(fb.x) <= 2 &&
          Math.abs(fb.y) <= 2 &&
          Math.abs(fb.width - pageW) <= 2 &&
          Math.abs(fb.height - pageH) <= 2;

        if (isPageFrame) {
          let restMinX = Infinity;
          let restMinY = Infinity;
          let restMaxX = -Infinity;
          let restMaxY = -Infinity;

          for (let i = 1; i < children.length; i += 1) {
            const child = children[i];
            if (NON_GEOMETRY_TAGS.has(child.localName.toLowerCase())) continue;
            const gfx = child as unknown as SVGGraphicsElement;
            if (typeof gfx.getBBox !== "function") continue;
            try {
              const b = gfx.getBBox();
              if (b.width <= 0 && b.height <= 0) continue;
              restMinX = Math.min(restMinX, b.x);
              restMinY = Math.min(restMinY, b.y);
              restMaxX = Math.max(restMaxX, b.x + b.width);
              restMaxY = Math.max(restMaxY, b.y + b.height);
            } catch {
              // Ignore elements that cannot compute a bounding box.
            }
          }

          if (restMaxX > restMinX && restMaxY > restMinY) {
            const restOutside =
              restMaxX <= 0 || restMinX >= pageW || restMaxY <= 0 || restMinY >= pageH;
            const pageDiagLimit = 2 * Math.max(pageW, pageH);
            const restExtendsFar =
              restMaxX - restMinX > pageDiagLimit || restMaxY - restMinY > pageDiagLimit;
            if (restOutside || restExtendsFar) {
              (children[0] as SVGElement).style.display = "none";
            }
          }
        }
      }
    }

    const bbox = svgEl.getBBox();
    if (!bbox || bbox.width <= 1 || bbox.height <= 1) return null;

    const tolX = pageW * 0.05;
    const tolY = pageH * 0.05;
    const insideNominalPage =
      bbox.x >= -tolX &&
      bbox.y >= -tolY &&
      bbox.x + bbox.width <= pageW + tolX &&
      bbox.y + bbox.height <= pageH + tolY;
    if (insideNominalPage) return null;

    const overlapsPage =
      bbox.x < pageW && bbox.x + bbox.width > 0 && bbox.y < pageH && bbox.y + bbox.height > 0;

    let vx: number;
    let vy: number;
    let vw: number;
    let vh: number;

    if (overlapsPage) {
      vx = Math.min(0, bbox.x);
      vy = Math.min(0, bbox.y);
      vw = Math.max(pageW, bbox.x + bbox.width) - vx;
      vh = Math.max(pageH, bbox.y + bbox.height) - vy;
    } else {
      const padX = bbox.width * 0.012;
      const padY = bbox.height * 0.012;
      vx = bbox.x - padX;
      vy = bbox.y - padY;
      vw = bbox.width + padX * 2;
      vh = bbox.height + padY * 2;
    }

    svgEl.setAttribute("viewBox", `${vx.toFixed(4)} ${vy.toFixed(4)} ${vw.toFixed(4)} ${vh.toFixed(4)}`);
    return { w: vw, h: vh };
  } catch {
    return null;
  }
}

export function VectorSvgStage({
  svgMarkup,
  widthPt,
  heightPt,
  unitLabel = "pt",
  modeLabel,
  paperMode = "white",
  autoFitContentBounds = false,
  resetKey,
  exportBaseName,
  totalPages = 1,
  currentPage = 1,
  pageUnitLabel,
  prevLabel,
  nextLabel,
  disabled = false,
  onGoPage,
  onPrevSibling,
  onNextSibling,
  extraToolGroups,
}: VectorSvgStageProps) {
  const { t, locale } = useI18n();
  const resolvedModeLabel = modeLabel ?? t("svg.vectorMode");
  const resolvedPageUnit = pageUnitLabel ?? t("common.unit.page");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const artboardRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<StageSize>({ w: 0, h: 0 });
  const [checker, setChecker] = useState(false);
  const [fittedBounds, setFittedBounds] = useState<{ markup: string; w: number; h: number } | null>(
    null
  );

  useLayoutEffect(() => {
    if (!autoFitContentBounds) return;
    const svgEl = artboardRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svgEl) {
      setFittedBounds({ markup: svgMarkup, w: widthPt, h: heightPt });
      return;
    }
    const adjusted = fitCorelSvgContentBounds(svgEl, widthPt, heightPt);
    setFittedBounds({
      markup: svgMarkup,
      w: adjusted ? adjusted.w : widthPt,
      h: adjusted ? adjusted.h : heightPt,
    });
  }, [autoFitContentBounds, svgMarkup, widthPt, heightPt]);

  const boundsReady = !autoFitContentBounds || fittedBounds?.markup === svgMarkup;
  const activeW = fittedBounds?.markup === svgMarkup ? fittedBounds.w : widthPt;
  const activeH = fittedBounds?.markup === svgMarkup ? fittedBounds.h : heightPt;

  const {
    zoom,
    offset,
    rotation,
    setRotation,
    flipped,
    setFlipped,
    dragging,
    resetView,
    stepZoom,
    stageHandlers,
  } = usePanZoomStage(stageRef, {
    minZoom: 0.1,
    maxZoom: 64,
    onPrevSibling,
    onNextSibling,
    enableArrowSiblingNav: totalPages <= 1,
    resetDeps: [resetKey],
  });

  // Track stage viewport dimensions dynamically via ResizeObserver.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    let rafId = 0;
    const syncSize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setStageSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
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
  }, []);

  const fittedBase = useMemo(() => {
    if (activeW <= 0 || activeH <= 0 || stageSize.w <= 0 || stageSize.h <= 0) {
      return null;
    }
    const pad = stageSize.w < 600 ? 16 : 28;
    const bottomPad = totalPages > 1 ? (stageSize.w < 600 ? 74 : 56) : stageSize.w < 600 ? 46 : 36;
    const availW = Math.max(80, stageSize.w - pad);
    const availH = Math.max(80, stageSize.h - pad - bottomPad);
    const fitScale = Math.max(0.01, Math.min(availW / activeW, availH / activeH));
    return {
      cssW: Math.max(1, activeW * fitScale),
      cssH: Math.max(1, activeH * fitScale),
    };
  }, [activeW, activeH, stageSize, totalPages]);

  // Keep __html identity stable so zoom/pan updates only resize CSS layout box without re-parsing SVG DOM.
  const dangerousHtml = useMemo(() => ({ __html: svgMarkup }), [svgMarkup]);

  const layoutTransform = `translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg) scaleX(${flipped ? -1 : 1})`;
  const useTransparentPaper = paperMode === "transparent" || checker;

  const toolGroups = useMemo(() => {
    const canvasGroups = createCanvasToolGroups({
      zoomPct: Math.round(zoom * 100),
      flipped,
      checker,
      onZoomOut: () => stepZoom(-1),
      onZoomIn: () => stepZoom(1),
      onResetView: resetView,
      onRotateLeft: () => setRotation((r) => r - 90),
      onRotateRight: () => setRotation((r) => r + 90),
      onToggleFlip: () => setFlipped((f) => !f),
      onToggleChecker: () => setChecker((c) => !c),
    });
    const exportGroup = exportBaseName
      ? [
          createExportToolGroup({
            onExportPng: async () => {
              const svg = artboardRef.current?.querySelector("svg") as SVGSVGElement | null;
              await exportSvgAs(svg, activeW, activeH, !useTransparentPaper, exportBaseName, "png");
            },
            onExportPdf: async () => {
              const svg = artboardRef.current?.querySelector("svg") as SVGSVGElement | null;
              await exportSvgAs(svg, activeW, activeH, true, exportBaseName, "pdf");
            },
          }),
        ]
      : [];
    const base = [...canvasGroups, ...exportGroup];
    return extraToolGroups && extraToolGroups.length > 0
      ? [...extraToolGroups, ...base]
      : base;
  }, [
    extraToolGroups,
    zoom,
    flipped,
    checker,
    stepZoom,
    resetView,
    setRotation,
    setFlipped,
    exportBaseName,
    activeW,
    activeH,
    useTransparentPaper,
    locale,
  ]);

  const pageHud = totalPages > 1 ? ` · ${currentPage}/${totalPages} ${resolvedPageUnit}` : "";
  const hudSummary = `${resolvedModeLabel} · ${Math.round(activeW)}×${Math.round(activeH)} ${unitLabel}${pageHud} · ${Math.round(zoom * 100)}%`;

  return (
    <div className="viewer-shell viewer-shell-rel">
      <div className="psd-stage-wrap">
        <div
          ref={stageRef}
          className={`image-stage ${checker ? "checkerboard" : ""}`}
          {...stageHandlers}
        >
          <div
            ref={artboardRef}
            className={`vector-svg-artboard ${useTransparentPaper ? "transparent-paper" : ""}`}
            style={{
              width: fittedBase ? `${Math.max(1, fittedBase.cssW * zoom)}px` : "320px",
              height: fittedBase ? `${Math.max(1, fittedBase.cssH * zoom)}px` : "240px",
              visibility: fittedBase && boundsReady ? "visible" : "hidden",
              transform: layoutTransform,
              cursor: dragging ? "grabbing" : "grab",
            }}
            dangerouslySetInnerHTML={dangerousHtml}
          />
        </div>

        {activeW > 0 && activeH > 0 && (
          <div className="model-stats-hud">{hudSummary}</div>
        )}
      </div>

      {totalPages > 1 && onGoPage && (
        <BottomPageNav
          currentPage={currentPage}
          totalPages={totalPages}
          unitLabel={resolvedPageUnit}
          prevLabel={prevLabel}
          nextLabel={nextLabel}
          editable
          disabled={disabled}
          onGoPage={onGoPage}
        />
      )}

      <BottomToolBar groups={toolGroups} />
    </div>
  );
}
