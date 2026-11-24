import { useEffect, type RefObject } from "react";

/**
 * Attaches Ctrl/Meta + mouse wheel zoom handling to a scrollable document stage.
 */
export function useStageWheelZoom(
  stageRef: RefObject<HTMLElement | null>,
  onStepZoom: (direction: 1 | -1) => void
): void {
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      onStepZoom(e.deltaY < 0 ? 1 : -1);
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [stageRef, onStepZoom]);
}
