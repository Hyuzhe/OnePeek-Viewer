import { useEffect, useState } from "react";
import { Code2, Globe, Minus, Plus, RefreshCw, Type, WrapText, ZoomIn } from "lucide-react";
import type { DecodedText, ViewerProps } from "../core/types";
import { useAsyncResource } from "../core/useAsyncResource";
import { useI18n } from "../i18n";
import { FileBridge } from "../services/fileBridge";
import { BottomToolBar, type BottomToolGroup } from "../components/BottomToolBar";
import { ViewerError, ViewerLoading } from "../components/StatusView";

export function HtmlViewer({ file, onPrevSibling, onNextSibling }: ViewerProps) {
  const { t } = useI18n();
  const [sourceMode, setSourceMode] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [reloadTick, setReloadTick] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [fontSize, setFontSize] = useState(14);
  const [sourceData, setSourceData] = useState<DecodedText | null>(null);

  const { data: entryHref, loading, error } = useAsyncResource(
    () => FileBridge.mountHtml(file.path),
    [file.path]
  );

  // Lazily load raw source text only when user switches to source code view
  useEffect(() => {
    setSourceData(null);
  }, [file.path]);

  useEffect(() => {
    if (!sourceMode || sourceData) return;
    let cancelled = false;
    FileBridge.readText(file.path, 8 * 1024 * 1024)
      .then((res) => {
        if (!cancelled) setSourceData(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file.path, sourceData, sourceMode]);

  // Forward QuickLook and sibling shortcuts from inside the sandboxed HTML iframe
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || ev.data.type !== "OMNI_HTML_KEY") return;
      if (ev.data.key === "Escape" || ev.data.key === " ") {
        void FileBridge.hideToTray();
      } else if (ev.data.altKey && ev.data.key === "ArrowLeft") {
        onPrevSibling();
      } else if (ev.data.altKey && ev.data.key === "ArrowRight") {
        onNextSibling();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onNextSibling, onPrevSibling]);

  if (loading) return <ViewerLoading message={t("html.loading")} />;
  if (error || !entryHref) {
    return <ViewerError title={t("html.errTitle")} detail={error ?? t("html.errDetail")} />;
  }

  const pageUrl = `${FileBridge.toHtmlUrl(entryHref)}?v=${reloadTick}`;
  const scaleRatio = zoom / 100;

  const toolGroups: BottomToolGroup[] = [
    {
      id: "mode",
      label: t("html.mode"),
      icon: <Globe size={14} />,
      active: sourceMode,
      items: [
        {
          kind: "action",
          key: "mode-web",
          label: t("html.webPreview"),
          icon: <Globe size={14} />,
          active: !sourceMode,
          dismiss: "instant",
          onClick: () => setSourceMode(false),
        },
        {
          kind: "action",
          key: "mode-src",
          label: t("html.viewSource"),
          icon: <Code2 size={14} />,
          active: sourceMode,
          dismiss: "instant",
          onClick: () => setSourceMode(true),
        },
        ...(!sourceMode
          ? [
              {
                kind: "action" as const,
                key: "reload",
                label: t("html.reload"),
                icon: <RefreshCw size={14} />,
                dismiss: "instant" as const,
                title: t("html.reloadTitle"),
                onClick: () => setReloadTick((tck) => tck + 1),
              },
            ]
          : [
              ...(sourceData
                ? [
                    {
                      kind: "badge" as const,
                      key: "src-encoding",
                      text: sourceData.encoding,
                    },
                  ]
                : []),
              {
                kind: "action" as const,
                key: "src-wrap",
                label: t("html.wrap"),
                icon: <WrapText size={14} />,
                active: wrap,
                dismiss: "instant" as const,
                onClick: () => setWrap((w) => !w),
              },
            ]),
      ],
    },
    !sourceMode
      ? {
          id: "zoom",
          label: t("tool.zoom"),
          icon: <ZoomIn size={14} />,
          items: [
            {
              kind: "action",
              key: "web-zoom-out",
              label: t("tool.zoomOut"),
              icon: <Minus size={14} />,
              dismiss: "stepper",
              title: t("tool.zoomOut"),
              onClick: () => setZoom((z) => Math.max(50, z - 10)),
            },
            {
              kind: "badge",
              key: "web-zoom-pct",
              text: `${zoom}%`,
              title: t("html.zoomResetTitle"),
              onClick: () => setZoom(100),
            },
            {
              kind: "action",
              key: "web-zoom-in",
              label: t("tool.zoomIn"),
              icon: <Plus size={14} />,
              dismiss: "stepper",
              title: t("tool.zoomIn"),
              onClick: () => setZoom((z) => Math.min(200, z + 10)),
            },
          ],
        }
      : {
          id: "font",
          label: t("tool.font"),
          icon: <Type size={14} />,
          items: [
            {
              kind: "action",
              key: "src-font-dec",
              label: t("tool.fontDec"),
              icon: <Minus size={14} />,
              dismiss: "stepper",
              onClick: () => setFontSize((s) => Math.max(11, s - 1)),
            },
            {
              kind: "badge",
              key: "src-font-size",
              text: `${fontSize}px`,
            },
            {
              kind: "action",
              key: "src-font-inc",
              label: t("tool.fontInc"),
              icon: <Plus size={14} />,
              dismiss: "stepper",
              onClick: () => setFontSize((s) => Math.min(28, s + 1)),
            },
          ],
        },
  ];

  return (
    <div className="viewer-shell viewer-shell-rel">
      {!sourceMode ? (
        <div className="html-stage">
          <iframe
            src={pageUrl}
            title={file.name}
            className="html-preview-iframe"
            style={
              scaleRatio !== 1
                ? {
                    width: `${100 / scaleRatio}%`,
                    height: `${100 / scaleRatio}%`,
                    transform: `scale(${scaleRatio})`,
                    transformOrigin: "0 0",
                  }
                : undefined
            }
          />
        </div>
      ) : (
        <div className="text-scroll-stage">
          {sourceData ? (
            <pre className={`code-block ${wrap ? "wrapped" : ""}`} style={{ fontSize }}>
              {sourceData.content}
            </pre>
          ) : (
            <ViewerLoading message={t("html.loadingSrc")} />
          )}
        </div>
      )}

      <BottomToolBar groups={toolGroups} />
    </div>
  );
}
