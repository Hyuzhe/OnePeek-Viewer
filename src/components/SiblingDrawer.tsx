import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { FileContextPayload } from "../core/types";
import { resolveViewer } from "../core/viewerRegistry";
import { useI18n } from "../i18n";

interface SiblingDrawerProps {
  context: FileContextPayload;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function SiblingDrawer({ context, onSelect, onClose: _onClose }: SiblingDrawerProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");

  const items = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    return kw
      ? context.siblings.filter((s) => s.name.toLowerCase().includes(kw))
      : context.siblings;
  }, [context.siblings, filter]);

  return (
    <aside className="sibling-drawer">
      <div className="drawer-head">
        <span>{t("drawer.header", { count: context.siblings.length })}</span>
      </div>
      <div className="drawer-search">
        <Search size={14} />
        <input
          type="text"
          placeholder={t("drawer.placeholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="drawer-list">
        {items.map((item, idx) => {
          const active =
            item.path.toLowerCase() === context.current.path.toLowerCase() ||
            (!filter.trim() && idx === context.current_index);
          const desc = resolveViewer(item.ext);
          return (
            <button
              key={item.path}
              className={`drawer-row ${active ? "active" : ""}`}
              onClick={() => onSelect(item.path)}
              title={item.name}
            >
              <span className="dot" style={{ background: desc.color }} />
              <span className="drawer-name">{item.name}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
