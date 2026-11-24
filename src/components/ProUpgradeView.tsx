import { Crown, ExternalLink, Lock } from "lucide-react";
import type { ViewerProps } from "../core/types";
import { getViewerBadge, resolveFormatGuideSlug, resolveViewer } from "../core/viewerRegistry";
import { useI18n } from "../i18n";
import { FileBridge } from "../services/fileBridge";

// Handoff card rendered when opening proprietary Pro formats in Community Edition
export function ProUpgradeView({ file, onGoHome }: ViewerProps) {
  const { t, locale } = useI18n();
  const descriptor = resolveViewer(file.ext);
  const badge = getViewerBadge(descriptor.kind);
  const slug = resolveFormatGuideSlug(file.ext, descriptor.guideSlug);
  const prefix = locale === "zh" ? "https://onepeek.top/zh" : "https://onepeek.top";
  const targetUrl = slug ? `${prefix}/open/${slug}/` : `${prefix}/`;

  return (
    <div className="pro-locked-view">
      <div className="pro-locked-card">
        <div className="pro-locked-icon">
          <Lock size={26} />
        </div>
        <div className="pro-locked-badge">
          {locale === "zh" ? `${badge} · OnePeek Pro` : `${badge} · OnePeek Pro`}
        </div>
        <h2>{file.name}</h2>
        <p>
          {locale === "zh"
            ? `当前开源社区版专注于轻量看图、PDF、网页、代码、音视频与压缩包。${badge} 等专业/工程/医学/办公格式由 OnePeek Pro 商业版离线引擎提供。`
            : `OnePeek Community (GPLv3) includes images, PDF, HTML, Markdown/code, media, and archives. Specialized formats like ${badge} are powered by OnePeek Pro's offline native engines.`}
        </p>
        <div className="pro-locked-actions">
          <button
            className="primary-btn"
            onClick={() => void FileBridge.openExternalUrl(targetUrl)}
          >
            <Crown size={15} />
            <span>{locale === "zh" ? "前往官网查看 Pro 版" : "View Format in OnePeek Pro"}</span>
            <ExternalLink size={12} />
          </button>
          {onGoHome && (
            <button className="icon-btn" onClick={onGoHome}>
              <span>{t("common.backHome")}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
