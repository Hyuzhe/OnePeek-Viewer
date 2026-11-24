import { useEffect, useRef, type RefObject } from "react";
import { ArchiveRestore, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import type { FileContextPayload } from "../core/types";
import { useI18n } from "../i18n";
import { BOTTOM_PAGE_SLOT_ID, BOTTOM_SLOT_EVENT } from "./BottomPageNav";
import {
  BOTTOM_TOOLS_SLOT_ID,
  CLOSE_SIBLING_DRAWER_EVENT,
  CLOSE_TOOL_POPOVER_EVENT,
} from "./BottomToolBar";

interface SubToolbarFileNavProps {
  workspaceRef: RefObject<HTMLDivElement | null>;
  context: FileContextPayload | null;
  drawerOpen: boolean;
  parentArchiveName: string | null;
  onBackToArchive: () => void;
  showFloatingLogo: boolean;
  toolbarCollapsed: boolean;
  onToggleToolbarCollapsed: () => void;
  forceFallbackRail: boolean;
  onPrevSibling: () => void;
  onNextSibling: () => void;
  onToggleDrawer: () => void;
}

/**
 * Renders the unified bottom-center dock hosting the collapsible category tool slot,
 * uncollapsed document/book pagination slot, and sibling file switcher pill.
 */
export function SubToolbarFileNav({
  workspaceRef,
  context,
  drawerOpen,
  parentArchiveName,
  onBackToArchive,
  showFloatingLogo: _showFloatingLogo,
  toolbarCollapsed: _toolbarCollapsed,
  onToggleToolbarCollapsed: _onToggleToolbarCollapsed,
  forceFallbackRail: _forceFallbackRail,
  onPrevSibling,
  onNextSibling,
  onToggleDrawer,
}: SubToolbarFileNavProps) {
  const { t } = useI18n();
  const dockRef = useRef<HTMLDivElement | null>(null);
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;

  // Notify viewer portals whenever the bottom slots mount or context presence changes.
  useEffect(() => {
    window.dispatchEvent(new Event(BOTTOM_SLOT_EVENT));
  }, [Boolean(context)]);

  // Keep --bottom-dock-h synced with wrapped/unwrapped dock height for stage & drawer clearance.
  useEffect(() => {
    const dockEl = dockRef.current;
    const workspaceEl = workspaceRef.current;
    if (!dockEl || !workspaceEl) return;

    const syncHeight = () => {
      workspaceEl.style.setProperty("--bottom-dock-h", `${Math.ceil(dockEl.offsetHeight)}px`);
    };
    syncHeight();

    const observer = new ResizeObserver(syncHeight);
    observer.observe(dockEl);
    return () => {
      observer.disconnect();
      workspaceEl.style.setProperty("--bottom-dock-h", "0px");
    };
  }, [workspaceRef]);

  // Collapse sibling drawer whenever a bottom tool category popover opens.
  useEffect(() => {
    const onCloseDrawer = () => {
      if (drawerOpenRef.current) {
        onToggleDrawer();
      }
    };
    window.addEventListener(CLOSE_SIBLING_DRAWER_EVENT, onCloseDrawer);
    return () => {
      window.removeEventListener(CLOSE_SIBLING_DRAWER_EVENT, onCloseDrawer);
    };
  }, [onToggleDrawer]);

  // Collapse any active tool popover when opening the sibling file drawer.
  useEffect(() => {
    if (drawerOpen) {
      window.dispatchEvent(new Event(CLOSE_TOOL_POPOVER_EVENT));
    }
  }, [drawerOpen]);

  const siblingCount = context?.siblings.length ?? 0;
  const currentIdx = context && context.current_index >= 0 ? context.current_index + 1 : 0;
  const canStep = siblingCount > 1;
  const hasArchiveBack = Boolean(parentArchiveName);
  const hasSiblings = Boolean(context && siblingCount > 1);
  const showFilePill = hasSiblings || hasArchiveBack;

  // Automatically close the sibling drawer if the current context has at most one file.
  useEffect(() => {
    if (drawerOpen && !hasSiblings) {
      onToggleDrawer();
    }
  }, [drawerOpen, hasSiblings, onToggleDrawer]);

  return (
    <div ref={dockRef} className="bottom-center-dock" data-onepeek-ui="true">
      <div id={BOTTOM_TOOLS_SLOT_ID} className="bottom-tools-slot" />
      <div id={BOTTOM_PAGE_SLOT_ID} className="bottom-page-slot" />

      {showFilePill && (
        <div className="bottom-dock-pill bottom-file-pill">
          {hasArchiveBack && (
            <>
              <button
                type="button"
                className="dock-step-btn dock-back-archive-btn"
                onClick={onBackToArchive}
                title={t("nav.backArchiveTitle", { name: parentArchiveName ?? "" })}
              >
                <ArchiveRestore size={14} />
                <span className="dock-step-label">{t("nav.backArchive")}</span>
              </button>
              {hasSiblings && <span className="dock-v-sep" />}
            </>
          )}

          {hasSiblings && (
            <>
              <button
                type="button"
                className="dock-step-btn"
                disabled={!canStep}
                onClick={onPrevSibling}
                title={t("nav.prevFileTitle")}
                aria-label={t("nav.prevFile")}
              >
                <ChevronLeft size={15} />
                <span className="dock-step-label">{t("nav.prevFile")}</span>
              </button>

              <button
                type="button"
                className={`dock-counter-btn ${drawerOpen ? "active" : ""}`}
                onClick={onToggleDrawer}
                title={drawerOpen ? t("nav.collapseSiblings") : t("nav.expandSiblings")}
              >
                <span>
                  {currentIdx} / {siblingCount}
                </span>
                <ChevronUp size={13} className={`dock-drawer-caret ${drawerOpen ? "open" : ""}`} />
              </button>

              <button
                type="button"
                className="dock-step-btn"
                disabled={!canStep}
                onClick={onNextSibling}
                title={t("nav.nextFileTitle")}
                aria-label={t("nav.nextFile")}
              >
                <span className="dock-step-label">{t("nav.nextFile")}</span>
                <ChevronRight size={15} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
