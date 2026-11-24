import { ArrowLeft, Keyboard, MousePointerClick, SlidersHorizontal } from "lucide-react";
import { useI18n, type I18nKey } from "../i18n";

interface ShortcutsPageProps {
  hasActiveFile: boolean;
  onClose: () => void;
}

interface GuideKeyPair {
  key: I18nKey;
  desc: I18nKey;
}

const GLOBAL_KEYS: readonly GuideKeyPair[] = [
  { key: "sc.g1.k", desc: "sc.g1.d" },
  { key: "sc.g2.k", desc: "sc.g2.d" },
  { key: "sc.g3.k", desc: "sc.g3.d" },
  { key: "sc.g4.k", desc: "sc.g4.d" },
  { key: "sc.g5.k", desc: "sc.g5.d" },
  { key: "sc.g6.k", desc: "sc.g6.d" },
  { key: "sc.g7.k", desc: "sc.g7.d" },
  { key: "sc.g8.k", desc: "sc.g8.d" },
  { key: "sc.g9.k", desc: "sc.g9.d" },
];

const TOPBAR_KEYS: readonly GuideKeyPair[] = [
  { key: "sc.t1.k", desc: "sc.t1.d" },
  { key: "sc.t2.k", desc: "sc.t2.d" },
  { key: "sc.t3.k", desc: "sc.t3.d" },
  { key: "sc.t4.k", desc: "sc.t4.d" },
  { key: "sc.t5.k", desc: "sc.t5.d" },
  { key: "sc.t6.k", desc: "sc.t6.d" },
  { key: "sc.t7.k", desc: "sc.t7.d" },
];

const VIEWER_GROUPS: readonly { titleKey: I18nKey; items: readonly GuideKeyPair[] }[] = [
  {
    titleKey: "sc.v1.t",
    items: [
      { key: "sc.v1.i1.k", desc: "sc.v1.i1.d" },
      { key: "sc.v1.i2.k", desc: "sc.v1.i2.d" },
      { key: "sc.v1.i3.k", desc: "sc.v1.i3.d" },
    ],
  },
  {
    titleKey: "sc.v2.t",
    items: [
      { key: "sc.v2.i1.k", desc: "sc.v2.i1.d" },
      { key: "sc.v2.i2.k", desc: "sc.v2.i2.d" },
      { key: "sc.v2.i3.k", desc: "sc.v2.i3.d" },
    ],
  },
  {
    titleKey: "sc.v3.t",
    items: [
      { key: "sc.v3.i1.k", desc: "sc.v3.i1.d" },
      { key: "sc.v3.i2.k", desc: "sc.v3.i2.d" },
      { key: "sc.v3.i3.k", desc: "sc.v3.i3.d" },
    ],
  },
  {
    titleKey: "sc.v4.t",
    items: [
      { key: "sc.v4.i1.k", desc: "sc.v4.i1.d" },
      { key: "sc.v4.i2.k", desc: "sc.v4.i2.d" },
      { key: "sc.v4.i3.k", desc: "sc.v4.i3.d" },
    ],
  },
];

function GuideRowList({ items, isKey }: { items: readonly GuideKeyPair[]; isKey: boolean }) {
  const { t } = useI18n();
  return (
    <div className="shortcut-list">
      {items.map((item) => (
        <div key={item.key} className="shortcut-row">
          <span className={isKey ? "kbd-tag" : "btn-tag"}>{t(item.key)}</span>
          <span className="shortcut-desc">{t(item.desc)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Dedicated concise reference page documenting global shortcuts, top bar controls,
 * and per-viewer toolbar buttons.
 */
export function ShortcutsPage({ hasActiveFile, onClose }: ShortcutsPageProps) {
  const { t } = useI18n();
  return (
    <div className="shortcuts-page">
      <div className="shortcuts-container">
        <div className="shortcuts-header">
          <div>
            <h2>{t("sc.title")}</h2>
            <p>{t("sc.subtitle")}</p>
          </div>
          <button className="primary-btn" onClick={onClose}>
            <ArrowLeft size={16} />
            <span>{hasActiveFile ? t("sc.backPreview") : t("common.backHome")}</span>
          </button>
        </div>

        <div className="shortcuts-grid">
          <section className="shortcut-card">
            <div className="shortcut-card-title">
              <Keyboard size={16} />
              <span>{t("sc.globalTitle")}</span>
            </div>
            <GuideRowList items={GLOBAL_KEYS} isKey />
          </section>

          <section className="shortcut-card">
            <div className="shortcut-card-title">
              <MousePointerClick size={16} />
              <span>{t("sc.topbarTitle")}</span>
            </div>
            <GuideRowList items={TOPBAR_KEYS} isKey={false} />
          </section>
        </div>

        <section className="shortcut-card">
          <div className="shortcut-card-title">
            <SlidersHorizontal size={16} />
            <span>{t("sc.viewersTitle")}</span>
          </div>
          <div className="viewer-guide-grid">
            {VIEWER_GROUPS.map((group) => (
              <div key={group.titleKey} className="viewer-guide-group">
                <h4>{t(group.titleKey)}</h4>
                <GuideRowList items={group.items} isKey={false} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
