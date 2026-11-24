import { useState } from "react";
import { FileQuestion, FileText } from "lucide-react";
import type { ViewerProps } from "../core/types";
import { useI18n } from "../i18n";
import { formatBytes } from "../services/fileBridge";
import { TextCodeViewer } from "./TextCodeViewer";

export function FallbackViewer(props: ViewerProps) {
  const { t } = useI18n();
  const [forceText, setForceText] = useState(false);

  if (forceText) {
    return <TextCodeViewer {...props} />;
  }

  return (
    <div className="viewer-shell">
      <div className="state-box">
        <FileQuestion size={42} />
        <h3>{t("fallback.title", { ext: props.file.ext || t("fallback.noExt") })}</h3>
        <p>{t("fallback.meta", { name: props.file.name, size: formatBytes(props.file.size) })}</p>
        <button className="primary-btn" onClick={() => setForceText(true)}>
          <FileText size={16} />
          <span>{t("fallback.openAsText")}</span>
        </button>
      </div>
    </div>
  );
}
