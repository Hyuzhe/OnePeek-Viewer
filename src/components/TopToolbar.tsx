import { useEffect, useRef, useState } from "react";
import {
  Crown,
  ExternalLink,
  EyeOff,
  Keyboard,
  Moon,
  Palette,
  Sun,
  X,
  Zap,
} from "lucide-react";
import { getPaletteLabel, PALETTE_OPTIONS, type PaletteId } from "../core/palettes";
import type { FileContextPayload } from "../core/types";
import { getViewerBadge, resolveViewer } from "../core/viewerRegistry";
import { useI18n } from "../i18n";
import { FileBridge, formatBytes } from "../services/fileBridge";
import { OnePeekLogo } from "./OnePeekLogo";

interface TopToolbarProps {
  context: FileContextPayload | null;
  openError?: string | null;
  darkMode: boolean;
  palette: PaletteId;
  shortcutsOpen: boolean;
  quickLookEnabled: boolean;
  externalQuickPeek?: boolean;
  onClosePreview: () => void;
  onCloseQuickPeek?: () => void;
  onToggleShortcuts: () => void;
  onToggleQuickLook: () => void;
  onHideToTray: () => void;
  onGoHome: () => void;
  onToggleTheme: () => void;
  onSelectPalette: (id: PaletteId) => void;
}

export function TopToolbar({
  context,
  openError = null,
  darkMode,
  palette,
  shortcutsOpen,
  quickLookEnabled,
  externalQuickPeek = false,
  onClosePreview,
  onCloseQuickPeek,
  onToggleShortcuts,
  onToggleQuickLook,
  onHideToTray,
  onGoHome,
  onToggleTheme,
  onSelectPalette,
}: TopToolbarProps) {
  const { t, locale } = useI18n();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const current = context?.current ?? null;
  const descriptor = current ? resolveViewer(current.ext) : null;
  const isPreviewMode = Boolean(context || openError || externalQuickPeek);
  const activeOption =
    PALETTE_OPTIONS.find((item) => item.id === palette) ?? PALETTE_OPTIONS[0];
  const proUrl = locale === "zh" ? "https://onepeek.top/zh/" : "https://onepeek.top/";

  useEffect(() => {
    if (isPreviewMode && paletteOpen) {
      setPaletteOpen(false);
    }
  }, [isPreviewMode, paletteOpen]);

  // Dismiss palette popover on outside click or Escape before global tray-hide runs
  useEffect(() => {
    if (!paletteOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPaletteOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPaletteOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape, true);
    };
  }, [paletteOpen]);

  if (isPreviewMode) {
    const badgeLabel =
      current && descriptor
        ? getViewerBadge(descriptor.kind)
        : openError
          ? t("top.hint")
          : t("top.quickPeek");
    const badgeColor =
      current && descriptor ? descriptor.color : openError ? "#ef4444" : "var(--accent)";
    const titleText = current
      ? current.name
      : openError
        ? t("top.openErrorTitle")
        : t("top.quickPeeking");
    const titleTooltip = current
      ? `${current.name} (${formatBytes(current.size)})\n${current.path}`
      : titleText;

    const handleExitPreview = externalQuickPeek ? onCloseQuickPeek : onClosePreview;

    return (
      <header className="top-bar top-bar-preview">
        <div className="top-preview-side">
          <button
            type="button"
            className="brand-btn"
            onClick={handleExitPreview}
            title={
              externalQuickPeek
                ? t("top.returnCallerApp")
                : t("top.homeTooltip", { version: __APP_VERSION__ })
            }
          >
            <OnePeekLogo size={20} />
            <span className="brand-name">OnePeek</span>
          </button>
        </div>

        <div className="top-preview-center" title={titleTooltip}>
          <span
            className="format-badge"
            style={{
              background: badgeColor,
              color: current && descriptor ? "#fff" : openError ? "#fff" : "var(--on-accent)",
            }}
          >
            {badgeLabel}
          </span>
          <span className="file-title-text">{titleText}</span>
        </div>

        <div className="top-preview-side top-preview-right">
          <button
            type="button"
            className="preview-close-icon-btn"
            onClick={handleExitPreview}
            title={externalQuickPeek ? t("top.closeReturnCaller") : t("top.closePreview")}
            aria-label={t("top.closePreview")}
          >
            <X size={18} />
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="top-bar top-bar-home">
      <div className="top-left">
        <button
          className="brand-btn"
          onClick={onGoHome}
          title={t("top.homeTooltip", { version: __APP_VERSION__ })}
        >
          <OnePeekLogo size={20} />
          <span className="brand-name">OnePeek</span>
          <span className="palette-pro-tag">Community</span>
        </button>
      </div>

      <div className="top-center">
        <button
          className="icon-btn license-badge-btn tier-pro"
          onClick={() => void FileBridge.openExternalUrl(proUrl)}
          title={
            locale === "zh"
              ? "开源社区版 (GPLv3) · 点击了解包含 CAD/3D/CDR/PSD/DICOM/CAJ 的 Pro 商业版"
              : "Open-source Community Edition (GPLv3) · Explore OnePeek Pro for CAD/3D/Design/Medical/Office"
          }
        >
          <Crown size={14} />
          <span>Community (GPLv3) · Pro</span>
          <ExternalLink size={12} />
        </button>
      </div>

      <div className="top-right">
        {!FileBridge.isAndroid() && (
          <>
            <button
              className={`icon-btn ${quickLookEnabled ? "active" : ""}`}
              onClick={onToggleQuickLook}
              title={quickLookEnabled ? t("top.quicklookOnTitle") : t("top.quicklookOffTitle")}
            >
              <Zap size={14} />
              <span>{quickLookEnabled ? t("top.quicklookOn") : t("top.quicklookOff")}</span>
            </button>

            <button
              className="icon-btn"
              onClick={onHideToTray}
              title={t("top.trayTitle")}
            >
              <EyeOff size={15} />
              <span>{t("top.trayLabel")}</span>
            </button>

            <button
              className={`icon-btn ${shortcutsOpen ? "active" : ""}`}
              onClick={onToggleShortcuts}
              title={t("top.shortcutsTitle")}
            >
              <Keyboard size={15} />
              <span>{t("top.shortcutsLabel")}</span>
            </button>
          </>
        )}

        <div className="theme-picker-wrap" ref={pickerRef}>
          <button
            className={`icon-btn ${paletteOpen ? "active" : ""}`}
            onClick={() => setPaletteOpen((o) => !o)}
            title={t("top.themeTitle", { label: getPaletteLabel(activeOption.id) })}
          >
            <Palette size={15} />
            <span
              className="palette-dot"
              style={{ background: activeOption.accent }}
            />
            <span>{t("top.themeLabel")}</span>
          </button>

          {paletteOpen && (
            <div className="theme-popover" role="dialog" aria-label={t("top.themeAria")}>
              <div className="theme-popover-head">
                <span>{t("top.themeHeader")}</span>
                <div className="mode-switch">
                  <button
                    className={`mode-chip ${darkMode ? "active" : ""}`}
                    onClick={() => {
                      if (!darkMode) onToggleTheme();
                    }}
                  >
                    <Moon size={12} />
                    <span>{t("top.dark")}</span>
                  </button>
                  <button
                    className={`mode-chip ${!darkMode ? "active" : ""}`}
                    onClick={() => {
                      if (darkMode) onToggleTheme();
                    }}
                  >
                    <Sun size={12} />
                    <span>{t("top.light")}</span>
                  </button>
                </div>
              </div>

              <div className="palette-grid">
                {PALETTE_OPTIONS.map((opt) => {
                  const selected = opt.id === palette;
                  return (
                    <button
                      key={opt.id}
                      className={`palette-item ${selected ? "selected" : ""}`}
                      onClick={() => {
                        setPaletteOpen(false);
                        onSelectPalette(opt.id);
                      }}
                    >
                      <span className="palette-swatch" style={{ background: opt.accent }} />
                      <span className="palette-label">{getPaletteLabel(opt.id)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
