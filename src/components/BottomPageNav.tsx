import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "../i18n";

export const BOTTOM_PAGE_SLOT_ID = "onepeek-bottom-page-slot";
export const BOTTOM_SLOT_EVENT = "onepeek:bottom-slot-changed";

interface BottomPageNavProps {
  currentPage: number;
  totalPages: number;
  unitLabel: string;
  onGoPage: (page: number) => void;
  disabled?: boolean;
  editable?: boolean;
  prevLabel?: string;
  nextLabel?: string;
}

/**
 * Portals permanently visible document/book pagination controls into the bottom-center dock.
 */
export function BottomPageNav({
  currentPage,
  totalPages,
  unitLabel,
  onGoPage,
  disabled = false,
  editable = false,
  prevLabel,
  nextLabel,
}: BottomPageNavProps) {
  const { t } = useI18n();
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.getElementById(BOTTOM_PAGE_SLOT_ID) : null
  );
  const [draft, setDraft] = useState(() => String(currentPage));

  // Keep editable page draft synchronized when external navigation changes the active page.
  useEffect(() => {
    setDraft(String(currentPage));
  }, [currentPage]);

  // Resolve the bottom dock portal container after sibling SubToolbarFileNav mounts or updates.
  useEffect(() => {
    const syncSlot = () => {
      setSlotEl(document.getElementById(BOTTOM_PAGE_SLOT_ID));
    };
    syncSlot();
    window.addEventListener(BOTTOM_SLOT_EVENT, syncSlot);
    return () => {
      window.removeEventListener(BOTTOM_SLOT_EVENT, syncSlot);
    };
  }, []);

  if (!slotEl || totalPages <= 0) {
    return null;
  }

  const resolvedPrev = prevLabel ?? t("common.prevUnit", { unit: unitLabel });
  const resolvedNext = nextLabel ?? t("common.nextUnit", { unit: unitLabel });

  const commitDraft = () => {
    const parsed = Number.parseInt(draft.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setDraft(String(currentPage));
      return;
    }
    const clamped = Math.min(Math.max(1, parsed), totalPages);
    setDraft(String(clamped));
    if (clamped !== currentPage) {
      onGoPage(clamped);
    }
  };

  return createPortal(
    <div className="bottom-dock-pill bottom-page-pill" data-onepeek-ui="true">
      <button
        type="button"
        className="dock-step-btn"
        disabled={disabled || currentPage <= 1}
        onClick={() => onGoPage(currentPage - 1)}
        title={resolvedPrev}
        aria-label={resolvedPrev}
      >
        <ChevronLeft size={15} />
      </button>

      {editable ? (
        <label
          className="dock-page-jump"
          title={t("common.pageCounterTitle", { current: currentPage, total: totalPages, unit: unitLabel })}
        >
          <input
            type="number"
            inputMode="numeric"
            className="dock-page-input"
            min={1}
            max={Math.max(1, totalPages)}
            value={draft}
            disabled={disabled}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft(raw);
              const parsed = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(parsed) && parsed >= 1 && parsed <= totalPages) {
                onGoPage(parsed);
              }
            }}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitDraft();
                e.currentTarget.blur();
              }
            }}
          />
          <span className="dock-page-total">
            / {totalPages} {unitLabel}
          </span>
        </label>
      ) : (
        <span className="dock-counter-static">
          {currentPage} / {totalPages} {unitLabel}
        </span>
      )}

      <button
        type="button"
        className="dock-step-btn"
        disabled={disabled || currentPage >= totalPages}
        onClick={() => onGoPage(currentPage + 1)}
        title={resolvedNext}
        aria-label={resolvedNext}
      >
        <ChevronRight size={15} />
      </button>
    </div>,
    slotEl
  );
}
