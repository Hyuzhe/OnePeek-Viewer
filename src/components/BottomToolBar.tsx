import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronUp,
  FlipHorizontal,
  Grid,
  Maximize2,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { tKey } from "../i18n";
import { BOTTOM_SLOT_EVENT } from "./BottomPageNav";

export const BOTTOM_TOOLS_SLOT_ID = "onepeek-bottom-tools-slot";
export const CLOSE_TOOL_POPOVER_EVENT = "onepeek:close-tool-popover";
export const CLOSE_SIBLING_DRAWER_EVENT = "onepeek:close-sibling-drawer";

let activePopoverCloser: (() => boolean) | null = null;

/**
 * Closes any currently open bottom tool category popover.
 * Returns true if a popover was open and dismissed.
 */
export function closeActiveBottomToolPopover(): boolean {
  return activePopoverCloser ? activePopoverCloser() : false;
}

export type BottomToolItem =
  | {
      kind: "action";
      key: string;
      label: string;
      icon?: ReactNode;
      active?: boolean;
      disabled?: boolean;
      title?: string;
      dismiss?: "instant" | "stepper";
      onClick: () => void;
    }
  | {
      kind: "swatch";
      key: string;
      color: string;
      textColor?: string;
      text?: string;
      selected?: boolean;
      title?: string;
      onClick: () => void;
    }
  | {
      kind: "badge";
      key: string;
      text: string;
      title?: string;
      onClick?: () => void;
    };

export interface BottomToolGroup {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  items?: BottomToolItem[];
  renderPanel?: (helpers: { close: () => void; markInteracted: () => void }) => ReactNode;
  panelClassName?: string;
}

interface BottomToolBarProps {
  groups: BottomToolGroup[];
}

export interface CanvasToolGroupOptions {
  zoomPct: number;
  flipped: boolean;
  checker: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetView: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onToggleFlip: () => void;
  onToggleChecker: () => void;
}

/**
 * Shared zoom + canvas transform tool groups reused across image, PSD, AI, and CDR viewers.
 */
export function createCanvasToolGroups(opts: CanvasToolGroupOptions): BottomToolGroup[] {
  return [
    {
      id: "zoom",
      label: tKey("tool.zoom"),
      icon: <ZoomIn size={14} />,
      items: [
        {
          kind: "action",
          key: "zoom-out",
          label: tKey("tool.zoomOut"),
          icon: <ZoomOut size={15} />,
          dismiss: "stepper",
          title: tKey("tool.zoomOut"),
          onClick: opts.onZoomOut,
        },
        {
          kind: "badge",
          key: "zoom-pct",
          text: `${opts.zoomPct}%`,
          title: tKey("tool.zoomResetTitle"),
          onClick: opts.onResetView,
        },
        {
          kind: "action",
          key: "zoom-in",
          label: tKey("tool.zoomIn"),
          icon: <ZoomIn size={15} />,
          dismiss: "stepper",
          title: tKey("tool.zoomIn"),
          onClick: opts.onZoomIn,
        },
        {
          kind: "action",
          key: "fit-reset",
          label: tKey("tool.zoomReset"),
          icon: <Maximize2 size={14} />,
          dismiss: "instant",
          title: tKey("tool.zoomResetTitle"),
          onClick: opts.onResetView,
        },
      ],
    },
    {
      id: "transform",
      label: tKey("tool.transform"),
      icon: <RotateCw size={14} />,
      active: opts.flipped || opts.checker,
      items: [
        {
          kind: "action",
          key: "rotate-ccw",
          label: tKey("tool.rotateLeft"),
          icon: <RotateCcw size={15} />,
          dismiss: "stepper",
          title: tKey("tool.rotateLeftTitle"),
          onClick: opts.onRotateLeft,
        },
        {
          kind: "action",
          key: "rotate-cw",
          label: tKey("tool.rotateRight"),
          icon: <RotateCw size={15} />,
          dismiss: "stepper",
          title: tKey("tool.rotateRightTitle"),
          onClick: opts.onRotateRight,
        },
        {
          kind: "action",
          key: "flip",
          label: tKey("tool.flip"),
          icon: <FlipHorizontal size={15} />,
          active: opts.flipped,
          dismiss: "instant",
          title: tKey("tool.flipTitle"),
          onClick: opts.onToggleFlip,
        },
        {
          kind: "action",
          key: "checker",
          label: tKey("tool.gridBg"),
          icon: <Grid size={15} />,
          active: opts.checker,
          dismiss: "instant",
          title: tKey("tool.gridBgTitle"),
          onClick: opts.onToggleChecker,
        },
      ],
    },
  ];
}

/**
 * Portals categorized viewer actions into the shared bottom-center dock, expanding
 * per-category popovers on demand and auto-collapsing once operations complete.
 */
export function BottomToolBar({ groups }: BottomToolBarProps) {
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.getElementById(BOTTOM_TOOLS_SLOT_ID) : null
  );
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const interactedRef = useRef(false);
  const pointerInsideRef = useRef(false);
  const isOpenRef = useRef(false);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const closePopover = useCallback(() => {
    clearIdleTimer();
    interactedRef.current = false;
    pointerInsideRef.current = false;
    setOpenGroupId(null);
  }, [clearIdleTimer]);

  const scheduleIdleClose = useCallback(
    (ms: number) => {
      clearIdleTimer();
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        if (!pointerInsideRef.current) {
          closePopover();
        }
      }, ms);
    },
    [clearIdleTimer, closePopover]
  );

  const markInteracted = useCallback(
    (ms = 1800) => {
      interactedRef.current = true;
      scheduleIdleClose(ms);
    },
    [scheduleIdleClose]
  );

  // Keep slot element synchronized across mounts and layout updates.
  useEffect(() => {
    const syncSlot = () => {
      setSlotEl(document.getElementById(BOTTOM_TOOLS_SLOT_ID));
    };
    syncSlot();
    window.addEventListener(BOTTOM_SLOT_EVENT, syncSlot);
    return () => {
      window.removeEventListener(BOTTOM_SLOT_EVENT, syncSlot);
    };
  }, []);

  const activeGroup = groups.find((g) => g.id === openGroupId) ?? null;
  isOpenRef.current = Boolean(activeGroup);

  // Register global Escape / Android back closer while this popover instance is active.
  useEffect(() => {
    if (!activeGroup) return;
    activePopoverCloser = () => {
      if (!isOpenRef.current) return false;
      closePopover();
      return true;
    };
    return () => {
      activePopoverCloser = null;
    };
  }, [activeGroup, closePopover]);

  // Attach global dismissal listeners while any category popover is open.
  useEffect(() => {
    if (!activeGroup) return;

    const onCloseEvent = () => closePopover();

    const onOutsideEvent = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || pillRef.current?.contains(target)) {
        return;
      }
      closePopover();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePopover();
      }
    };

    const onWindowBlur = () => {
      window.setTimeout(() => {
        if (document.activeElement?.tagName === "IFRAME") {
          closePopover();
        }
      }, 0);
    };

    window.addEventListener(CLOSE_TOOL_POPOVER_EVENT, onCloseEvent);
    document.addEventListener("pointerdown", onOutsideEvent, true);
    document.addEventListener("wheel", onOutsideEvent, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener(CLOSE_TOOL_POPOVER_EVENT, onCloseEvent);
      document.removeEventListener("pointerdown", onOutsideEvent, true);
      document.removeEventListener("wheel", onOutsideEvent, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [activeGroup, closePopover]);

  useEffect(() => clearIdleTimer, [clearIdleTimer]);

  if (!slotEl || groups.length === 0) {
    return null;
  }

  const toggleGroup = (id: string) => {
    if (openGroupId === id) {
      closePopover();
      return;
    }
    window.dispatchEvent(new Event(CLOSE_SIBLING_DRAWER_EVENT));
    clearIdleTimer();
    interactedRef.current = false;
    pointerInsideRef.current = false;
    setOpenGroupId(id);
  };

  const renderToolItem = (item: BottomToolItem) => {
    if (item.kind === "badge") {
      return item.onClick ? (
        <button
          key={item.key}
          type="button"
          className="tool-popover-badge clickable"
          title={item.title}
          onClick={() => {
            item.onClick?.();
            closePopover();
          }}
        >
          {item.text}
        </button>
      ) : (
        <span key={item.key} className="tool-popover-badge" title={item.title}>
          {item.text}
        </span>
      );
    }

    if (item.kind === "swatch") {
      return (
        <button
          key={item.key}
          type="button"
          className={`tool-pop-swatch ${item.selected ? "selected" : ""}`}
          style={{ background: item.color, color: item.textColor }}
          title={item.title}
          onClick={() => {
            item.onClick();
            closePopover();
          }}
        >
          {item.text ?? ""}
        </button>
      );
    }

    return (
      <button
        key={item.key}
        type="button"
        className={`tool-pop-btn ${item.active ? "active" : ""}`}
        disabled={item.disabled}
        title={item.title ?? item.label}
        onClick={() => {
          item.onClick();
          if (item.dismiss === "stepper") {
            markInteracted(1800);
          } else {
            closePopover();
          }
        }}
      >
        {item.icon}
        <span>{item.label}</span>
      </button>
    );
  };

  return createPortal(
    <>
      {activeGroup && (
        <div
          ref={popoverRef}
          className={`bottom-tool-popover ${activeGroup.panelClassName ?? ""}`}
          data-onepeek-ui="true"
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") {
              pointerInsideRef.current = true;
              clearIdleTimer();
            }
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") {
              pointerInsideRef.current = false;
              if (interactedRef.current) {
                scheduleIdleClose(900);
              }
            }
          }}
          onScrollCapture={() => {
            if (interactedRef.current) {
              scheduleIdleClose(2200);
            }
          }}
        >
          {activeGroup.renderPanel ? (
            activeGroup.renderPanel({
              close: closePopover,
              markInteracted: () => markInteracted(2000),
            })
          ) : (
            <div className="tool-popover-items">{activeGroup.items?.map(renderToolItem)}</div>
          )}
        </div>
      )}

      <div ref={pillRef} className="bottom-dock-pill bottom-tools-pill" data-onepeek-ui="true">
        {groups.map((group) => {
          const isOpen = openGroupId === group.id;
          return (
            <button
              key={group.id}
              type="button"
              className={`dock-cat-btn ${isOpen ? "open" : ""} ${group.active ? "active" : ""}`}
              onClick={() => toggleGroup(group.id)}
              title={group.label}
              aria-expanded={isOpen}
            >
              {group.icon}
              <span className="dock-cat-label">{group.label}</span>
              <ChevronUp size={12} className={`dock-drawer-caret ${isOpen ? "open" : ""}`} />
            </button>
          );
        })}
      </div>
    </>,
    slotEl
  );
}
