import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { type PaletteId } from "./core/palettes";
import type { FileContextPayload, FileMeta, ZipEntryInfo } from "./core/types";
import { resolveViewer } from "./core/viewerRegistry";
import { useI18n } from "./i18n";
import { TOAST_EVENT, type ToastDetail } from "./services/exportService";
import { FileBridge, setAndroidBackIntercept } from "./services/fileBridge";
import { StorageService } from "./services/storage";
import { TopToolbar } from "./components/TopToolbar";
import { WelcomeDropzone } from "./components/WelcomeDropzone";
import { SubToolbarFileNav } from "./components/SubToolbarFileNav";
import { closeActiveBottomToolPopover } from "./components/BottomToolBar";
import { SiblingDrawer } from "./components/SiblingDrawer";
import { ShortcutsPage } from "./components/ShortcutsPage";
import { ViewerError, ViewerLoading } from "./components/StatusView";

interface ArchiveSession {
  archiveFile: FileMeta;
  parentContext: FileContextPayload;
  entries: ZipEntryInfo[];
  currentEntryIndex: number;
}

function getLeafNameAndExt(rawName: string): { name: string; ext: string } {
  const leaf = rawName.split("/").pop() || rawName;
  const lower = leaf.toLowerCase();
  if (lower.endsWith(".nii.gz")) {
    return { name: leaf, ext: "nii.gz" };
  }
  if (lower.endsWith(".tar.gz")) {
    return { name: leaf, ext: "tar.gz" };
  }
  const dotIdx = leaf.lastIndexOf(".");
  return {
    name: leaf,
    ext: dotIdx > 0 ? leaf.slice(dotIdx + 1).toLowerCase() : "",
  };
}

export function App() {
  const { t } = useI18n();
  const [toast, setToast] = useState<ToastDetail | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [context, setContext] = useState<FileContextPayload | null>(null);
  const [archiveStack, setArchiveStack] = useState<ArchiveSession[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);
  const [externalQuickPeek, setExternalQuickPeek] = useState(() =>
    FileBridge.isExternalQuickPeek()
  );
  const [externalStaging, setExternalStaging] = useState(() =>
    FileBridge.isExternalQuickPeek()
  );
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<FileContextPayload | null>(null);
  const archiveStackRef = useRef<ArchiveSession[]>([]);
  const hadActivePreviewRef = useRef(false);
  const grabberTouchYRef = useRef<number | null>(null);
  const dismissResetTimerRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [quickLookEnabled, setQuickLookEnabled] = useState(true);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [darkMode, setDarkMode] = useState(() => StorageService.getDarkMode());
  const [palette, setPalette] = useState<PaletteId>(() => StorageService.getPalette());
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);

  contextRef.current = context;
  archiveStackRef.current = archiveStack;

  const openPath = useCallback(
    async (path: string) => {
      if (dismissResetTimerRef.current !== null) {
        window.clearTimeout(dismissResetTimerRef.current);
        dismissResetTimerRef.current = null;
      }
      try {
        setOpenError(null);
        setShortcutsOpen(false);
        const payload = await FileBridge.openFileContext(path);
        setContext(payload);
      } catch (err: unknown) {
        if (path.replace(/\\/g, "/").includes("/opened_files/")) {
          setOpenError(t("app.cacheCleaned"));
        } else {
          setOpenError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setExternalStaging(false);
      }
    },
    [t]
  );

  const openRootPath = useCallback(
    async (path: string) => {
      setArchiveStack([]);
      setDrawerOpen(false);
      await openPath(path);
    },
    [openPath]
  );

  const openArchiveEntryAt = useCallback(
    async (
      archiveFile: FileMeta,
      parentContext: FileContextPayload,
      entries: ZipEntryInfo[],
      targetIdx: number,
      pushNewLayer: boolean
    ) => {
      const entry = entries[targetIdx];
      if (!entry) return;
      setOpenError(null);
      setShortcutsOpen(false);

      const extractedPath = await FileBridge.extractArchiveEntry(archiveFile.path, entry.index);
      const innerPayload = await FileBridge.openFileContext(extractedPath);
      const { name, ext } = getLeafNameAndExt(entry.name);
      const isNumericOrEmpty = !ext || /^\d+$/.test(ext);
      const resolvedExt = isNumericOrEmpty ? innerPayload.current.ext : ext || innerPayload.current.ext;

      // Synthesize in-archive sibling navigation without exposing temp cache directories
      const siblings: FileMeta[] = entries.map((e, i) => {
        const meta = getLeafNameAndExt(e.name);
        return {
          path: i === targetIdx ? innerPayload.current.path : `archive-entry://${e.index}`,
          name: e.name,
          ext: meta.ext,
          size: e.size,
        };
      });

      setContext({
        current: {
          path: innerPayload.current.path,
          name,
          ext: resolvedExt,
          size: innerPayload.current.size,
        },
        siblings,
        current_index: targetIdx,
      });

      setArchiveStack((prev) =>
        pushNewLayer
          ? [...prev, { archiveFile, parentContext, entries, currentEntryIndex: targetIdx }]
          : prev.map((item, idx) =>
              idx === prev.length - 1 ? { ...item, currentEntryIndex: targetIdx } : item
            )
      );
    },
    []
  );

  const handleOpenArchiveEntry = useCallback(
    async (entry: ZipEntryInfo, fileEntries: ZipEntryInfo[]) => {
      const parentContext = contextRef.current;
      if (!parentContext) return;
      const idx = fileEntries.findIndex((e) => e.index === entry.index);
      if (idx < 0) return;
      setDrawerOpen(false);
      await openArchiveEntryAt(parentContext.current, parentContext, fileEntries, idx, true);
    },
    [openArchiveEntryAt]
  );

  const handleBackToArchive = useCallback(() => {
    setDrawerOpen(false);
    setShortcutsOpen(false);
    setOpenError(null);
    setArchiveStack((prev) => {
      if (prev.length === 0) return prev;
      const top = prev[prev.length - 1];
      setContext(top.parentContext);
      return prev.slice(0, -1);
    });
  }, []);

  const closePreview = useCallback(() => {
    document.querySelectorAll("video, audio").forEach((el) => {
      try {
        (el as HTMLMediaElement).pause();
      } catch {
        // Ignore media pause errors
      }
    });
    setArchiveStack([]);
    setContext(null);
    setOpenError(null);
    setDrawerOpen(false);
    setToolbarCollapsed(false);
    setShortcutsOpen(false);
  }, []);

  const dismissExternalPopup = useCallback(() => {
    document.querySelectorAll("video, audio").forEach((el) => {
      try {
        (el as HTMLMediaElement).pause();
      } catch {
        // Ignore media pause errors
      }
    });
    FileBridge.dismissQuickPeek();
    if (dismissResetTimerRef.current !== null) {
      window.clearTimeout(dismissResetTimerRef.current);
    }
    dismissResetTimerRef.current = window.setTimeout(() => {
      dismissResetTimerRef.current = null;
      setDrawerOpen(false);
      setToolbarCollapsed(false);
      setShortcutsOpen(false);
      setOpenError(null);
      setArchiveStack([]);
      setContext(null);
      setExternalStaging(false);
    }, 200);
  }, []);

  const hideAndReleaseToTray = useCallback(() => {
    closePreview();
    void FileBridge.hideToTray();
  }, [closePreview]);

  const handlePickFile = useCallback(async () => {
    try {
      const picked = await FileBridge.pickFileDialog();
      if (picked) await openRootPath(picked);
    } catch (err: unknown) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  }, [openRootPath]);

  const stepSibling = useCallback(
    (delta: number) => {
      const activeArchive = archiveStackRef.current[archiveStackRef.current.length - 1];
      if (activeArchive && activeArchive.entries.length > 1) {
        const total = activeArchive.entries.length;
        const nextIdx = (activeArchive.currentEntryIndex + delta + total) % total;
        void openArchiveEntryAt(
          activeArchive.archiveFile,
          activeArchive.parentContext,
          activeArchive.entries,
          nextIdx,
          false
        ).catch((err: unknown) => {
          setOpenError(err instanceof Error ? err.message : String(err));
        });
        return;
      }

      if (!context || context.siblings.length <= 1) return;
      const total = context.siblings.length;
      const nextIdx = (context.current_index + delta + total) % total;
      const target = context.siblings[nextIdx];
      if (target) void openPath(target.path);
    },
    [context, openArchiveEntryAt, openPath]
  );

  const handlePrevSibling = useCallback(() => stepSibling(-1), [stepSibling]);
  const handleNextSibling = useCallback(() => stepSibling(1), [stepSibling]);

  // Check startup CLI argument and sync QuickLook daemon status
  useEffect(() => {
    FileBridge.getStartupFile()
      .then((startupPath) => {
        if (startupPath) void openRootPath(startupPath);
      })
      .catch(() => {});

    FileBridge.getQuickLookEnabled()
      .then((enabled) => setQuickLookEnabled(enabled))
      .catch(() => {});

    FileBridge.getAutostartEnabled()
      .then((enabled) => setAutostartEnabled(enabled))
      .catch(() => {});

    let unlistenOpen: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenAutostart: (() => void) | undefined;
    let unlistenPreviewHidden: (() => void) | undefined;

    const checkPendingAndroidOpen = () => {
      if (!FileBridge.isAndroid() || document.visibilityState === "hidden") return;
      FileBridge.getStartupFile()
        .then((pendingPath) => {
          if (pendingPath) void openRootPath(pendingPath);
        })
        .catch(() => {});
    };

    let pendingAndroidTimer: number | undefined;
    if (FileBridge.isAndroid()) {
      window.__onepeekOnExternalFile = (incomingPath: string) => {
        if (incomingPath) {
          void FileBridge.getStartupFile().catch(() => {});
          void openRootPath(incomingPath);
        }
      };
      window.__onepeekOnExternalModeChange = (ext: boolean) => {
        if (dismissResetTimerRef.current !== null) {
          window.clearTimeout(dismissResetTimerRef.current);
          dismissResetTimerRef.current = null;
        }
        setExternalQuickPeek(ext);
        setExternalStaging(ext);
        if (!ext) {
          setDrawerOpen(false);
        }
      };
      pendingAndroidTimer = window.setTimeout(checkPendingAndroidOpen, 600);
      document.addEventListener("visibilitychange", checkPendingAndroidOpen);
      window.addEventListener("focus", checkPendingAndroidOpen);
    }

    listen<string>("quicklook-open", (ev) => {
      if (ev.payload) void openRootPath(ev.payload);
    })
      .then((fn) => {
        unlistenOpen = fn;
      })
      .catch(() => {});

    listen<boolean>("quicklook-status", (ev) => {
      setQuickLookEnabled(Boolean(ev.payload));
    })
      .then((fn) => {
        unlistenStatus = fn;
      })
      .catch(() => {});

    listen<boolean>("autostart-status", (ev) => {
      setAutostartEnabled(Boolean(ev.payload));
    })
      .then((fn) => {
        unlistenAutostart = fn;
      })
      .catch(() => {});

    listen("preview-hidden", () => {
      closePreview();
    })
      .then((fn) => {
        unlistenPreviewHidden = fn;
      })
      .catch(() => {});

    return () => {
      if (pendingAndroidTimer !== undefined) window.clearTimeout(pendingAndroidTimer);
      if (FileBridge.isAndroid()) {
        window.__onepeekOnExternalFile = undefined;
        window.__onepeekOnExternalModeChange = undefined;
        document.removeEventListener("visibilitychange", checkPendingAndroidOpen);
        window.removeEventListener("focus", checkPendingAndroidOpen);
      }
      unlistenOpen?.();
      unlistenStatus?.();
      unlistenAutostart?.();
      unlistenPreviewHidden?.();
    };
  }, [closePreview, openRootPath]);

  // Subscribe to transient export & action toast notifications
  useEffect(() => {
    const onToast = (ev: Event) => {
      const detail = (ev as CustomEvent<ToastDetail>).detail;
      if (!detail?.message) return;
      setToast(detail);
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => {
        toastTimerRef.current = null;
        setToast(null);
      }, 4200);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Subscribe to native OS file drag-and-drop events via Tauri Webview API
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const kind = event.payload.type;
        if (kind === "enter" || kind === "over") {
          setDragging(true);
        } else if (kind === "leave") {
          setDragging(false);
        } else if (kind === "drop") {
          setDragging(false);
          const firstPath = event.payload.paths[0];
          if (firstPath) void openRootPath(firstPath);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      unlisten?.();
    };
  }, [openRootPath]);

  // Prevent external quick-peek launch from getting stuck on loading spinner
  useEffect(() => {
    if (!externalStaging) return;
    const timer = window.setTimeout(() => setExternalStaging(false), 2000);
    return () => window.clearTimeout(timer);
  }, [externalStaging]);

  // Close overlays, step back out of archive previews, or return to caller app on Android back gesture
  useEffect(() => {
    if (!FileBridge.isAndroid()) return;
    const canInterceptBack = Boolean(
      externalQuickPeek ||
        archiveStack.length > 0 ||
        drawerOpen ||
        shortcutsOpen ||
        context ||
        openError
    );
    setAndroidBackIntercept(canInterceptBack);
    window.__onepeekOnAndroidBack = () => {
      if (closeActiveBottomToolPopover()) {
        return;
      } else if (drawerOpen) {
        setDrawerOpen(false);
      } else if (shortcutsOpen) {
        setShortcutsOpen(false);
      } else if (archiveStackRef.current.length > 0) {
        handleBackToArchive();
      } else if (externalQuickPeek) {
        dismissExternalPopup();
      } else {
        setContext(null);
        setOpenError(null);
      }
    };
    return () => {
      setAndroidBackIntercept(false);
      window.__onepeekOnAndroidBack = undefined;
    };
  }, [
    archiveStack.length,
    context,
    dismissExternalPopup,
    drawerOpen,
    externalQuickPeek,
    handleBackToArchive,
    openError,
    shortcutsOpen,
  ]);

  // Global keyboard shortcuts (Ctrl+O, Alt+Left/Right, Backspace in archive, Space/Esc)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const inEditable = targetTag === "input" || targetTag === "textarea" || targetTag === "select";

      if (e.key === "F1" || ((e.ctrlKey || e.metaKey) && e.key === "/")) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void handlePickFile();
      } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowUp")) {
        e.preventDefault();
        handlePrevSibling();
      } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
        e.preventDefault();
        handleNextSibling();
      } else if (
        e.key === "Backspace" &&
        !inEditable &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        archiveStackRef.current.length > 0
      ) {
        e.preventDefault();
        handleBackToArchive();
      } else if (e.key === "Escape") {
        if (closeActiveBottomToolPopover()) {
          return;
        } else if (drawerOpen) {
          setDrawerOpen(false);
        } else if (shortcutsOpen) {
          setShortcutsOpen(false);
        } else if (archiveStackRef.current.length > 0) {
          handleBackToArchive();
        } else {
          hideAndReleaseToTray();
        }
      } else if (
        e.key === " " &&
        !inEditable &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        const kind = context ? resolveViewer(context.current.ext).kind : null;
        if (kind !== "video" && kind !== "audio") {
          e.preventDefault();
          hideAndReleaseToTray();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    context,
    drawerOpen,
    handleBackToArchive,
    handleNextSibling,
    handlePickFile,
    handlePrevSibling,
    hideAndReleaseToTray,
    shortcutsOpen,
  ]);

  const toggleQuickLook = async () => {
    const next = await FileBridge.setQuickLookEnabled(!quickLookEnabled);
    setQuickLookEnabled(next);
  };

  const toggleAutostart = async () => {
    const next = await FileBridge.setAutostartEnabled(!autostartEnabled);
    setAutostartEnabled(next);
  };

  const toggleTheme = () => {
    setDarkMode((prev) => {
      const next = !prev;
      StorageService.setDarkMode(next);
      return next;
    });
  };

  const toggleToolbarCollapsed = useCallback(() => {
    setToolbarCollapsed((prev) => {
      const next = !prev;
      if (next) {
        setDrawerOpen(false);
      }
      return next;
    });
  }, []);

  const selectPalette = useCallback((next: PaletteId) => {
    setPalette(next);
    StorageService.setPalette(next);
  }, []);

  const activeArchive = archiveStack[archiveStack.length - 1] ?? null;
  const activeDescriptor = context ? resolveViewer(context.current.ext) : null;
  const ActiveViewer = activeDescriptor?.component ?? null;
  const activePath = context?.current.path ?? null;
  const activeKind = activeDescriptor?.kind ?? null;
  const inArchive = archiveStack.length > 0;

  // Release temporary staged disk files automatically when preview switches or closes
  useEffect(() => {
    if (activePath !== null) {
      hadActivePreviewRef.current = true;
      void FileBridge.releasePreviewResources(activePath, activeKind, inArchive);
    } else if (hadActivePreviewRef.current) {
      hadActivePreviewRef.current = false;
      void FileBridge.releasePreviewResources(null, null, false);
    }
  }, [activePath, activeKind, inArchive]);

  const hasSideToolbar = Boolean(
    (context &&
      activeDescriptor &&
      activeDescriptor.kind !== "sheet" &&
      activeDescriptor.kind !== "archive") ||
      (openError && archiveStack.length > 0)
  );

  return (
    <div
      className={[
        "app-root",
        darkMode ? "theme-dark" : "theme-light",
        externalQuickPeek ? "android-quick-peek" : "",
        hasSideToolbar ? "side-toolbar-mode" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-palette={palette}
      data-toolbar-collapsed={toolbarCollapsed ? "true" : "false"}
    >
      {externalQuickPeek && (
        <div
          className="sheet-grabber-bar"
          onTouchStart={(e) => {
            grabberTouchYRef.current = e.touches[0]?.clientY ?? null;
          }}
          onTouchEnd={(e) => {
            const startY = grabberTouchYRef.current;
            grabberTouchYRef.current = null;
            const endY = e.changedTouches[0]?.clientY ?? null;
            if (startY !== null && endY !== null && endY - startY > 48) {
              dismissExternalPopup();
            }
          }}
          title="Swipe down to return"
        >
          <span className="sheet-grabber-pill" />
        </div>
      )}

      <TopToolbar
        context={context}
        openError={openError}
        darkMode={darkMode}
        palette={palette}
        shortcutsOpen={shortcutsOpen}
        quickLookEnabled={quickLookEnabled}
        externalQuickPeek={externalQuickPeek}
        onClosePreview={closePreview}
        onCloseQuickPeek={dismissExternalPopup}
        onToggleShortcuts={() => setShortcutsOpen((o) => !o)}
        onToggleQuickLook={() => void toggleQuickLook()}
        onHideToTray={hideAndReleaseToTray}
        onGoHome={closePreview}
        onToggleTheme={toggleTheme}
        onSelectPalette={selectPalette}
      />

      <div className="workspace-area" ref={workspaceRef}>
        {openError ? (
          <ViewerError title={t("top.openErrorTitle")} detail={openError} />
        ) : context && ActiveViewer ? (
          <ActiveViewer
            key={context.current.path}
            file={context.current}
            onPrevSibling={handlePrevSibling}
            onNextSibling={handleNextSibling}
            onOpenArchiveEntry={handleOpenArchiveEntry}
            onGoHome={externalQuickPeek ? dismissExternalPopup : closePreview}
          />
        ) : externalQuickPeek && externalStaging ? (
          <ViewerLoading message={t("app.quickPeekLoading")} />
        ) : (
          <WelcomeDropzone
            dragging={dragging}
            autostartEnabled={autostartEnabled}
            onToggleAutostart={() => void toggleAutostart()}
            onPickFile={handlePickFile}
            onOpenShortcuts={() => setShortcutsOpen(true)}
          />
        )}

        <SubToolbarFileNav
          workspaceRef={workspaceRef}
          context={context}
          drawerOpen={drawerOpen}
          parentArchiveName={activeArchive?.archiveFile.name ?? null}
          onBackToArchive={handleBackToArchive}
          showFloatingLogo={hasSideToolbar}
          toolbarCollapsed={toolbarCollapsed}
          onToggleToolbarCollapsed={toggleToolbarCollapsed}
          forceFallbackRail={Boolean((context && activeDescriptor?.proOnly) || (openError && archiveStack.length > 0))}
          onPrevSibling={handlePrevSibling}
          onNextSibling={handleNextSibling}
          onToggleDrawer={() => {
            setShortcutsOpen(false);
            setDrawerOpen((o) => !o);
          }}
        />

        {shortcutsOpen && (
          <ShortcutsPage
            hasActiveFile={Boolean(context)}
            onClose={() => setShortcutsOpen(false)}
          />
        )}

        {context && drawerOpen && context.siblings.length > 1 && (
          <>
            <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />
            <SiblingDrawer
              context={context}
              onSelect={(path) => {
                setDrawerOpen(false);
                if (path === context.current.path) return;
                if (path.startsWith("archive-entry://") && activeArchive) {
                  const entryIndex = Number.parseInt(path.slice("archive-entry://".length), 10);
                  const targetIdx = activeArchive.entries.findIndex(
                    (e) => e.index === entryIndex
                  );
                  if (targetIdx >= 0) {
                    void openArchiveEntryAt(
                      activeArchive.archiveFile,
                      activeArchive.parentContext,
                      activeArchive.entries,
                      targetIdx,
                      false
                    ).catch((err: unknown) => {
                      setOpenError(err instanceof Error ? err.message : String(err));
                    });
                  }
                  return;
                }
                void openRootPath(path);
              }}
              onClose={() => setDrawerOpen(false)}
            />
          </>
        )}

        {dragging && context && (
          <div className="global-drop-mask">
            <div className="drop-mask-box">{t("app.dropMask")}</div>
          </div>
        )}

        {toast && (
          <div className={`onepeek-toast tone-${toast.tone}`} role="status" aria-live="polite">
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
}
