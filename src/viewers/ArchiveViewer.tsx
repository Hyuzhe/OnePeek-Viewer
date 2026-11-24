import { useMemo, useState } from "react";
import { Archive, ChevronRight, Folder, Loader2, Search } from "lucide-react";
import type { ViewerProps, ZipEntryInfo } from "../core/types";
import { useAsyncResource } from "../core/useAsyncResource";
import { getViewerBadge, resolveViewer } from "../core/viewerRegistry";
import { useI18n } from "../i18n";
import { FileBridge, formatBytes } from "../services/fileBridge";
import { ViewerError, ViewerLoading } from "../components/StatusView";

function getEntryExt(name: string): string {
  const leaf = name.split("/").pop() ?? name;
  const lower = leaf.toLowerCase();
  if (lower.endsWith(".nii.gz")) return "nii.gz";
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  const dotIdx = leaf.lastIndexOf(".");
  return dotIdx > 0 ? leaf.slice(dotIdx + 1).toLowerCase() : "";
}

export function ArchiveViewer({ file, onOpenArchiveEntry }: ViewerProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [extractingIndex, setExtractingIndex] = useState<number | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const { data, loading, error } = useAsyncResource(
    () => FileBridge.listArchiveEntries(file.path),
    [file.path]
  );

  const fileEntries = useMemo(
    () => (data ? data.filter((e) => !e.is_dir) : []),
    [data]
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    const kw = query.trim().toLowerCase();
    return kw ? data.filter((e) => e.name.toLowerCase().includes(kw)) : data;
  }, [data, query]);

  const handleOpenEntry = async (item: ZipEntryInfo) => {
    if (item.is_dir || !onOpenArchiveEntry || extractingIndex !== null) return;
    try {
      setExtractError(null);
      setExtractingIndex(item.index);
      await onOpenArchiveEntry(item, fileEntries);
    } catch (err: unknown) {
      setExtractError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtractingIndex(null);
    }
  };

  if (loading) return <ViewerLoading message={t("arch.loading")} />;
  if (error || !data) {
    return <ViewerError title={t("arch.errTitle")} detail={error ?? t("arch.empty")} />;
  }

  return (
    <div className="viewer-shell viewer-shell-top-bar">
      <div className="sub-toolbar archive-sub-toolbar">
        <span className="toolbar-pill">
          <Archive size={13} style={{ marginRight: 4, verticalAlign: "middle" }} />
          {t("arch.summary", { total: data.length, files: fileEntries.length })}
        </span>
        <div className="search-box">
          <Search size={14} />
          <input
            type="text"
            placeholder={t("arch.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {extractError && <span className="archive-inline-err">{extractError}</span>}
      </div>

      <div className="sheet-scroll archive-scroll">
        <table className="data-grid archive-grid">
          <colgroup>
            <col className="archive-col-type" />
            <col className="archive-col-path" />
            <col className="archive-col-size" />
            <col className="archive-col-compressed" />
            <col className="archive-col-action" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("arch.colType")}</th>
              <th>
                {t("arch.colPath")}
                <span className="archive-th-hint">{t("arch.colPathHint")}</span>
              </th>
              <th>{t("arch.colSize")}</th>
              <th className="archive-col-compressed">{t("arch.colCompressed")}</th>
              <th>{t("arch.colAction")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const ext = item.is_dir ? "" : getEntryExt(item.name);
              const desc = item.is_dir ? null : resolveViewer(ext);
              const isBusy = extractingIndex === item.index;
              return (
                <tr
                  key={`${item.index}-${item.name}`}
                  className={item.is_dir ? undefined : "archive-file-row"}
                  onClick={item.is_dir ? undefined : () => void handleOpenEntry(item)}
                >
                  <td style={{ textAlign: "center" }}>
                    {item.is_dir ? (
                      <Folder size={15} />
                    ) : (
                      <span
                        className="format-badge small"
                        style={{ background: desc?.color ?? "#64748b" }}
                      >
                        {desc ? getViewerBadge(desc.kind) : t("arch.badgeFallback")}
                      </span>
                    )}
                  </td>
                  <td className="archive-entry-cell" title={item.name}>
                    {item.name}
                  </td>
                  <td>{item.is_dir ? "-" : formatBytes(item.size)}</td>
                  <td className="archive-col-compressed">
                    {item.is_dir ? "-" : formatBytes(item.compressed_size)}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {!item.is_dir && (
                      <span className="archive-preview-tag">
                        {isBusy ? (
                          <>
                            <Loader2 size={12} className="spin-icon" />
                            <span>{t("arch.extracting")}</span>
                          </>
                        ) : (
                          <>
                            <span>{t("arch.preview")}</span>
                            <ChevronRight size={13} />
                          </>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
