import {
  Archive,
  Box,
  Code2,
  Crown,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Keyboard,
  Power,
  Settings,
} from "lucide-react";
import { useI18n } from "../i18n";
import { FileBridge } from "../services/fileBridge";
import { OnePeekLogo } from "./OnePeekLogo";

interface WelcomeProps {
  dragging: boolean;
  autostartEnabled: boolean;
  onToggleAutostart: () => void;
  onPickFile: () => void;
  onOpenShortcuts: () => void;
}

export function WelcomeDropzone({
  dragging,
  autostartEnabled,
  onToggleAutostart,
  onPickFile,
  onOpenShortcuts,
}: WelcomeProps) {
  const { t, locale } = useI18n();
  const isAndroid = FileBridge.isAndroid();
  const isZh = locale === "zh";
  const proUrl = isZh ? "https://onepeek.top/zh/" : "https://onepeek.top/";

  const communityCards = [
    {
      icon: ImageIcon,
      title: isZh ? "图片与 SVG 矢量图" : "Images & Vector SVG",
      desc: isZh
        ? "PNG · JPG · WebP · SVG · GIF · AVIF（缩放旋转 / 高清导出）"
        : "PNG · JPG · WebP · SVG · GIF · AVIF (Zoom, Rotate & PNG Export)",
    },
    {
      icon: FileText,
      title: isZh ? "PDF 与本地网页" : "PDF & Local Web Pages",
      desc: isZh
        ? "PDF 高清分页渲染导出 · HTML / XHTML 离线沙箱预览"
        : "HiDPI PDF reader & PNG export · Offline HTML/XHTML sandbox",
    },
    {
      icon: Code2,
      title: isZh ? "Markdown 与代码文本" : "Markdown & 35+ Code Languages",
      desc: isZh
        ? "Markdown 双栏切换 · TXT 编码自动识别 · JSON / YAML / Rust / TS"
        : "Markdown reader · Smart GBK/UTF-8 text · JSON, YAML, Rust, TS, Python",
    },
    {
      icon: Archive,
      title: isZh ? "压缩包与音视频" : "Archives & Media",
      desc: isZh
        ? "ZIP · 7Z · RAR · TAR 免解压穿透预览 · MP4 · MKV · MP3 · FLAC"
        : "ZIP · 7Z · RAR · TAR instant browse · MP4 · MKV · MP3 · FLAC",
    },
  ];

  const proCards = [
    {
      icon: Box,
      title: isZh ? "2D / 3D CAD 工业图纸" : "2D / 3D CAD Engineering",
      desc: isZh
        ? "DWG · DXF · STEP · IGES · STL · 3MF · GLB（Pro 商业版离线引擎）"
        : "DWG · DXF · STEP · IGES · STL · 3MF · GLB (OnePeek Pro)",
    },
    {
      icon: Crown,
      title: isZh ? "设计 · 医学影像 · 学术文献 · 办公" : "Design, Medical, CAJ & Office",
      desc: isZh
        ? "CDR · PSD · AI · DICOM/NIfTI · CAJ · EPUB · Word / Excel / PPT（Pro）"
        : "CDR · PSD · AI · DICOM/NIfTI · CAJ · EPUB · DOCX/XLSX/PPTX (Pro)",
    },
  ];

  return (
    <main className="welcome-wrap">
      <div className={`drop-hero ${dragging ? "drag-over" : ""}`}>
        <div className="hero-badge">
          <OnePeekLogo size={18} />
          <span>
            {isZh
              ? `OnePeek Community v${__APP_VERSION__} · 开源轻量离线速览 (GPLv3)`
              : `OnePeek Community v${__APP_VERSION__} · Open-Source Offline Viewer (GPLv3)`}
          </span>
        </div>
        <h1>{isAndroid ? t("welcome.titleAndroid") : t("welcome.titleDesktop")}</h1>
        <p className="hero-sub">
          {isAndroid ? t("welcome.subAndroid") : t("welcome.subDesktop")}
        </p>

        <div className="hero-actions">
          <button className="primary-btn large" onClick={onPickFile}>
            <FolderOpen size={18} />
            <span>{isAndroid ? t("welcome.pickAndroid") : t("welcome.pickDesktop")}</span>
          </button>
          {isAndroid ? (
            <button
              className="icon-btn large-ghost"
              onClick={() => FileBridge.openAndroidDefaultSettings()}
              title={t("welcome.androidSettingsTitle")}
            >
              <Settings size={16} />
              <span>{t("welcome.androidSettings")}</span>
            </button>
          ) : (
            <>
              <button
                className={`icon-btn large-ghost ${autostartEnabled ? "active" : ""}`}
                onClick={onToggleAutostart}
                title={t("welcome.autostartTitle")}
              >
                <Power size={16} />
                <span>{autostartEnabled ? t("welcome.autostartOn") : t("welcome.autostartOff")}</span>
              </button>
              <button
                className="icon-btn large-ghost"
                onClick={onOpenShortcuts}
                title={t("welcome.shortcutsBtnTitle")}
              >
                <Keyboard size={16} />
                <span>{t("welcome.shortcutsBtn")}</span>
              </button>
            </>
          )}
        </div>

        <div className="home-formats-section">
          <div className="home-formats-heading">
            {isZh
              ? "社区版内置免费格式 & Pro 版专业扩展"
              : "Built-In Community Formats & OnePeek Pro Extensions"}
          </div>
          <div className="capability-grid">
            {communityCards.map((card) => (
              <div key={card.title} className="cap-card">
                <span className="cap-icon-box">
                  <card.icon size={18} />
                </span>
                <div className="cap-body">
                  <div className="cap-title">{card.title}</div>
                  <div className="cap-desc">{card.desc}</div>
                </div>
              </div>
            ))}
            {proCards.map((card) => (
              <button
                key={card.title}
                type="button"
                className="cap-card"
                onClick={() => void FileBridge.openExternalUrl(proUrl)}
                style={{ width: "100%", textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }}
              >
                <span className="cap-icon-box">
                  <card.icon size={18} />
                </span>
                <div className="cap-body">
                  <div className="cap-title">{card.title}</div>
                  <div className="cap-desc">{card.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
