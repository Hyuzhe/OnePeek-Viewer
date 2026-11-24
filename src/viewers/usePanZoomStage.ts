// Shared 2D viewport hook for pointer-centered wheel zoom, mouse drag pan, and multi-touch pinch/pan.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from "react";

export interface UsePanZoomStageOptions {
  minZoom?: number;
  maxZoom?: number;
  onPrevSibling?: () => void;
  onNextSibling?: () => void;
  enableArrowSiblingNav?: boolean;
  resetDeps?: readonly unknown[];
}

type TouchGestureState =
  | {
      mode: "pan";
      startX: number;
      startY: number;
      baseOx: number;
      baseOy: number;
    }
  | {
      mode: "pinch";
      startMidX: number;
      startMidY: number;
      startDist: number;
      baseZoom: number;
      baseOx: number;
      baseOy: number;
    };

function getStageCenter(stage: HTMLElement | null): { cx: number; cy: number } {
  if (!stage) return { cx: 0, cy: 0 };
  const rect = stage.getBoundingClientRect();
  return { cx: rect.left + rect.width * 0.5, cy: rect.top + rect.height * 0.5 };
}

export function usePanZoomStage(
  stageRef: RefObject<HTMLElement | null>,
  options: UsePanZoomStageOptions = {}
) {
  const {
    minZoom = 0.1,
    maxZoom = 12,
    onPrevSibling,
    onNextSibling,
    enableArrowSiblingNav = true,
    resetDeps = [],
  } = options;

  const [zoom, setZoomState] = useState(1);
  const [offset, setOffsetState] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [dragging, setDragging] = useState(false);

  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const touchRef = useRef<TouchGestureState | null>(null);
  const mouseDragRef = useRef<{ x: number; y: number } | null>(null);

  const clampZoom = useCallback(
    (next: number) => Math.min(maxZoom, Math.max(minZoom, Number(next.toFixed(3)))),
    [maxZoom, minZoom]
  );

  const commitZoomOffset = useCallback((nextZoom: number, nextOffset: { x: number; y: number }) => {
    zoomRef.current = nextZoom;
    offsetRef.current = nextOffset;
    setZoomState(nextZoom);
    setOffsetState(nextOffset);
  }, []);

  const resetView = useCallback(() => {
    touchRef.current = null;
    mouseDragRef.current = null;
    setDragging(false);
    setRotation(0);
    setFlipped(false);
    commitZoomOffset(1, { x: 0, y: 0 });
  }, [commitZoomOffset]);

  // Reset viewport transform when file or active page changes.
  useEffect(() => {
    resetView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps);

  const stepZoom = useCallback(
    (direction: 1 | -1, clientX?: number, clientY?: number) => {
      const prevZoom = zoomRef.current;
      const factor = direction > 0 ? 1.2 : 1 / 1.2;
      const nextZoom = clampZoom(prevZoom * factor);
      if (nextZoom === prevZoom) return;

      const ratio = nextZoom / prevZoom;
      const prevOx = offsetRef.current.x;
      const prevOy = offsetRef.current.y;

      if (clientX !== undefined && clientY !== undefined) {
        const { cx, cy } = getStageCenter(stageRef.current);
        const rx = clientX - cx;
        const ry = clientY - cy;
        commitZoomOffset(nextZoom, {
          x: rx - (rx - prevOx) * ratio,
          y: ry - (ry - prevOy) * ratio,
        });
      } else {
        commitZoomOffset(nextZoom, {
          x: prevOx * ratio,
          y: prevOy * ratio,
        });
      }
    },
    [clampZoom, commitZoomOffset, stageRef]
  );

  // Attach non-passive wheel zoom centered on cursor position.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      const prevZoom = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const nextZoom = clampZoom(prevZoom * factor);
      if (nextZoom === prevZoom) return;

      const ratio = nextZoom / prevZoom;
      const { cx, cy } = getStageCenter(el);
      const rx = e.clientX - cx;
      const ry = e.clientY - cy;
      commitZoomOffset(nextZoom, {
        x: rx - (rx - offsetRef.current.x) * ratio,
        y: ry - (ry - offsetRef.current.y) * ratio,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stageRef, clampZoom, commitZoomOffset]);

  // Bind Ctrl/Cmd+0 reset and optional sibling arrow navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        resetView();
      } else if (enableArrowSiblingNav && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === "ArrowLeft" && onPrevSibling) {
          e.preventDefault();
          onPrevSibling();
        } else if (e.key === "ArrowRight" && onNextSibling) {
          e.preventDefault();
          onNextSibling();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enableArrowSiblingNav, onNextSibling, onPrevSibling, resetView]);

  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    mouseDragRef.current = {
      x: e.clientX - offsetRef.current.x,
      y: e.clientY - offsetRef.current.y,
    };
  }, []);

  const onMouseMove = useCallback((e: ReactMouseEvent) => {
    const origin = mouseDragRef.current;
    if (!origin) return;
    const nextOffset = { x: e.clientX - origin.x, y: e.clientY - origin.y };
    offsetRef.current = nextOffset;
    setOffsetState(nextOffset);
  }, []);

  const stopMouseDrag = useCallback(() => {
    if (!mouseDragRef.current) return;
    mouseDragRef.current = null;
    setDragging(false);
  }, []);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        touchRef.current = {
          mode: "pan",
          startX: t.clientX,
          startY: t.clientY,
          baseOx: offsetRef.current.x,
          baseOy: offsetRef.current.y,
        };
      } else if (e.touches.length >= 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const { cx, cy } = getStageCenter(stageRef.current);
        touchRef.current = {
          mode: "pinch",
          startMidX: (a.clientX + b.clientX) * 0.5 - cx,
          startMidY: (a.clientY + b.clientY) * 0.5 - cy,
          startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
          baseZoom: zoomRef.current,
          baseOx: offsetRef.current.x,
          baseOy: offsetRef.current.y,
        };
      }
    },
    [stageRef]
  );

  const onTouchMove = useCallback(
    (e: ReactTouchEvent) => {
      const state = touchRef.current;
      if (!state) return;
      if (state.mode === "pan" && e.touches.length === 1) {
        const t = e.touches[0];
        const nextOffset = {
          x: state.baseOx + (t.clientX - state.startX),
          y: state.baseOy + (t.clientY - state.startY),
        };
        offsetRef.current = nextOffset;
        setOffsetState(nextOffset);
      } else if (state.mode === "pinch" && e.touches.length >= 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const { cx, cy } = getStageCenter(stageRef.current);
        const currMidX = (a.clientX + b.clientX) * 0.5 - cx;
        const currMidY = (a.clientY + b.clientY) * 0.5 - cy;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const nextZoom = clampZoom(state.baseZoom * (dist / state.startDist));
        const ratio = nextZoom / state.baseZoom;
        commitZoomOffset(nextZoom, {
          x: currMidX - (state.startMidX - state.baseOx) * ratio,
          y: currMidY - (state.startMidY - state.baseOy) * ratio,
        });
      }
    },
    [clampZoom, commitZoomOffset, stageRef]
  );

  const onTouchEnd = useCallback((e: ReactTouchEvent) => {
    if (e.touches.length === 0) {
      touchRef.current = null;
    } else if (e.touches.length === 1) {
      // Seamlessly continue single-finger pan when lifting one finger after a pinch.
      const t = e.touches[0];
      touchRef.current = {
        mode: "pan",
        startX: t.clientX,
        startY: t.clientY,
        baseOx: offsetRef.current.x,
        baseOy: offsetRef.current.y,
      };
    }
  }, []);

  const transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg) scaleX(${flipped ? -1 : 1})`;

  return {
    zoom,
    offset,
    rotation,
    setRotation,
    flipped,
    setFlipped,
    dragging,
    resetView,
    stepZoom,
    transform,
    stageHandlers: {
      onMouseDown,
      onMouseMove,
      onMouseUp: stopMouseDrag,
      onMouseLeave: stopMouseDrag,
      onDoubleClick: resetView,
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
    },
  };
}
