import { useMemo, useState } from "react";
import { BookOpen, Code2, Eye, Minus, Plus, Type, WrapText } from "lucide-react";
import { marked } from "marked";
import type { ViewerProps } from "../core/types";
import { useAsyncResource } from "../core/useAsyncResource";
import { useI18n } from "../i18n";
import { FileBridge } from "../services/fileBridge";
import { BottomToolBar, type BottomToolGroup } from "../components/BottomToolBar";
import { ViewerError, ViewerLoading } from "../components/StatusView";

const MD_EXTS = new Set(["md", "markdown"]);

export function TextCodeViewer({ file }: ViewerProps) {
  const { t } = useI18n();
  const isMarkdown = MD_EXTS.has(file.ext);
  const isTxt = file.ext === "txt";
  const [rawMode, setRawMode] = useState(false);
  const [readerMode, setReaderMode] = useState(isTxt);
  const [wrap, setWrap] = useState(true);
  const [fontSize, setFontSize] = useState(isTxt ? 17 : 14);

  const { data, loading, error } = useAsyncResource(
    () => FileBridge.readText(file.path, 8 * 1024 * 1024),
    [file.path]
  );

  const renderedHtml = useMemo(() => {
    if (!data || !isMarkdown || rawMode) return "";
    return marked.parse(data.content, { async: false }) as string;
  }, [data, isMarkdown, rawMode]);

  if (loading) return <ViewerLoading message={t("text.loading")} />;
  if (error || !data) {
    return <ViewerError title={t("text.errTitle")} detail={error ?? t("text.unknownErr")} />;
  }

  const toolGroups: BottomToolGroup[] = [
    {
      id: "view",
      label: t("tool.view"),
      icon: <WrapText size={14} />,
      active: wrap || (isTxt && readerMode) || (isMarkdown && rawMode),
      items: [
        {
          kind: "badge",
          key: "encoding",
          text: data.encoding,
        },
        ...(isMarkdown
          ? [
              {
                kind: "action" as const,
                key: "md-raw",
                label: rawMode ? t("text.renderPreview") : t("text.viewSource"),
                icon: rawMode ? <Eye size={14} /> : <Code2 size={14} />,
                active: !rawMode,
                dismiss: "instant" as const,
                onClick: () => setRawMode((r) => !r),
              },
            ]
          : []),
        ...(isTxt
          ? [
              {
                kind: "action" as const,
                key: "txt-reader",
                label: t("text.readerLayout"),
                icon: <BookOpen size={14} />,
                active: readerMode,
                dismiss: "instant" as const,
                onClick: () => setReaderMode((r) => !r),
              },
            ]
          : []),
        {
          kind: "action",
          key: "wrap",
          label: t("text.wrap"),
          icon: <WrapText size={14} />,
          active: wrap,
          dismiss: "instant",
          onClick: () => setWrap((w) => !w),
        },
      ],
    },
    {
      id: "font",
      label: t("tool.font"),
      icon: <Type size={14} />,
      items: [
        {
          kind: "action",
          key: "font-dec",
          label: t("tool.fontDec"),
          icon: <Minus size={14} />,
          dismiss: "stepper",
          onClick: () => setFontSize((s) => Math.max(11, s - 1)),
        },
        {
          kind: "badge",
          key: "font-size",
          text: `${fontSize}px`,
        },
        {
          kind: "action",
          key: "font-inc",
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
      <div className="text-scroll-stage">
        {isMarkdown && !rawMode ? (
          <article
            className="markdown-paper"
            style={{ fontSize }}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : readerMode && isTxt ? (
          <article className="txt-reader-paper" style={{ fontSize }}>
            {data.content}
          </article>
        ) : (
          <pre
            className={`code-block ${wrap ? "wrapped" : ""}`}
            style={{ fontSize }}
          >
            {data.content}
          </pre>
        )}
      </div>

      <BottomToolBar groups={toolGroups} />
    </div>
  );
}
