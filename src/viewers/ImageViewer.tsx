import { useEffect, useRef, useState, type MouseEvent, type TouchEvent, type WheelEvent } from "react";
import type { ViewerProps } from "../core/types";
import { useI18n } from "../i18n";
import {
  createExportToolGroup,
  exportCanvasAs,
  imageElementToCanvas,
} from "../services/exportService";
import { FileBridge } from "../services/fileBridge";
import { BottomToolBar, createCanvasToolGroups } from "../components/BottomToolBar";
import { ViewerLoading } from "../components/StatusView";
import { normalizeVectorSvg, type NormalizedSvg } from "./svgNormalizer";
import { VectorSvgStage } from "./VectorSvgStage";

const svgUtf8Decoder = new TextDecoder("utf-8");

function SvgVectorViewer({ file, onPrevSibling, onNextSibling }: ViewerProps) {
  const { t } = useI18n();
  const [svgData, setSvgData] = useState<NormalizedSvg | null>(null);
  const [fallbackRaster, setFallbackRaster] = useState(false);

  useEffect(() => {
    let active = true;
    setSvgData(null);
    setFallbackRaster(false);

    FileBridge.readBinary(file.path)
      .then((buf) => normalizeVectorSvg(svgUtf8Decoder.decode(buf), "px"))
      .then((normalized) => {
        if (active) setSvgData(normalized);
      })
      .catch(() => {
        if (active) setFallbackRaster(true);
      });

    return () => {
      active = false;
    };
  }, [file.path]);

  if (fallbackRaster) {
    return <RasterImageViewer file={file} onPrevSibling={onPrevSibling} onNextSibling={onNextSibling} />;
  }

  if (!svgData) {
    return (
      <div className="viewer-shell">
        <ViewerLoading message={t("svg.loading")} />
      </div>
    );
  }

  return (
    <VectorSvgStage
      svgMarkup={svgData.svgMarkup}
      widthPt={svgData.widthPt}
      heightPt={svgData.heightPt}
      unitLabel="px"
      modeLabel={t("svg.vectorMode")}
      paperMode="transparent"
      resetKey={file.path}
      exportBaseName={file.name}
      onPrevSibling={onPrevSibling}
      onNextSibling={onNextSibling}
    />
  );
}

export function ImageViewer(props: ViewerProps) {
  if (props.file.ext.toLowerCase() === "svg") {
    return <SvgVectorViewer {...props} />;
  }
  return <RasterImageViewer {...props} />;
}

function RasterImageViewer({ file, onPrevSibling, onNextSibling }: ViewerProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [checker, setChecker] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragOrigin, setDragOrigin] = useState({ x: 0, y: 0 });
  const [naturalDim, setNaturalDim] = useState<{ w: number; h: number } | null>(null);
  const touchRef = useRef<{
    mode: "pan" | "pinch";
    startX: number;
    startY: number;
    baseOx: number;
    baseOy: number;
    baseDist: number;
    baseScale: number;
  } | null>(null);

  // Reset transform when image changes
  useEffect(() => {
    setScale(1);
    setRotation(0);
    setFlipped(false);
    setOffset({ x: 0, y: 0 });
    setNaturalDim(null);
  }, [file.path]);

  // Arrow keys navigate sibling files in gallery mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onPrevSibling();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNextSibling();
      } else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrevSibling, onNextSibling]);

  const clampScale = (next: number) => Math.min(10, Math.max(0.1, Number(next.toFixed(2))));

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    setScale((prev) => clampScale(prev * factor));
  };

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    setDragOrigin({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    setOffset({ x: e.clientX - dragOrigin.x, y: e.clientY - dragOrigin.y });
  };

  const resetView = () => {
    setScale(1);
    setRotation(0);
    setFlipped(false);
    setOffset({ x: 0, y: 0 });
  };

  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchRef.current = {
        mode: "pan",
        startX: t.clientX,
        startY: t.clientY,
        baseOx: offset.x,
        baseOy: offset.y,
        baseDist: 0,
        baseScale: scale,
      };
    } else if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      touchRef.current = {
        mode: "pinch",
        startX: 0,
        startY: 0,
        baseOx: offset.x,
        baseOy: offset.y,
        baseDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        baseScale: scale,
      };
    }
  };

  const handleTouchMove = (e: TouchEvent) => {
    const state = touchRef.current;
    if (!state) return;
    if (state.mode === "pan" && e.touches.length === 1) {
      const t = e.touches[0];
      setOffset({
        x: state.baseOx + (t.clientX - state.startX),
        y: state.baseOy + (t.clientY - state.startY),
      });
    } else if (state.mode === "pinch" && e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setScale(clampScale(state.baseScale * (dist / state.baseDist)));
    }
  };

  const handleTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 0) {
      touchRef.current = null;
    }
  };

  const src = FileBridge.toAssetUrl(file.path);
  const transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg) scaleX(${flipped ? -1 : 1})`;

  const toolGroups = [
    ...createCanvasToolGroups({
      zoomPct: Math.round(scale * 100),
      flipped,
      checker,
      onZoomOut: () => setScale((s) => clampScale(s * 0.8)),
      onZoomIn: () => setScale((s) => clampScale(s * 1.25)),
      onResetView: resetView,
      onRotateLeft: () => setRotation((r) => r - 90),
      onRotateRight: () => setRotation((r) => r + 90),
      onToggleFlip: () => setFlipped((f) => !f),
      onToggleChecker: () => setChecker((c) => !c),
    }),
    createExportToolGroup({
      onExportPng: async () => {
        if (!imgRef.current) throw new Error("Image is not loaded yet");
        const canvas = imageElementToCanvas(imgRef.current, { rotation, flipped });
        await exportCanvasAs(canvas, file.name, "png");
      },
      onExportPdf: async () => {
        if (!imgRef.current) throw new Error("Image is not loaded yet");
        const canvas = imageElementToCanvas(imgRef.current, { rotation, flipped, whiteBg: true });
        await exportCanvasAs(canvas, file.name, "pdf");
      },
    }),
  ];

  return (
    <div className="viewer-shell viewer-shell-rel">
      <div
        className={`image-stage ${checker ? "checkerboard" : ""}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <img
          ref={imgRef}
          src={src}
          alt={file.name}
          className="stage-img"
          style={{ transform, cursor: dragging ? "grabbing" : "grab" }}
          draggable={false}
          onLoad={(e) =>
            setNaturalDim({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
        />
        {naturalDim && (
          <div className="model-stats-hud">
            {naturalDim.w} × {naturalDim.h} px
          </div>
        )}
      </div>

      <BottomToolBar groups={toolGroups} />
    </div>
  );
}
