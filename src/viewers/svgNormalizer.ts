// Normalizes and sanitizes standalone .svg files for safe scalable DOM rendering.

export interface NormalizedSvg {
  svgMarkup: string;
  widthPt: number;
  heightPt: number;
}

const UNSAFE_ELEMENTS = new Set(["script", "foreignobject", "iframe", "object", "embed"]);
const REFERENCE_ATTRS = new Set([
  "fill",
  "stroke",
  "clip-path",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

let scopeCounter = 0;

function parseLengthToUnit(raw: string | null, unitTarget: "pt" | "px"): number | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.endsWith("%")) return null;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?$/i.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (match[2] || "").toLowerCase();
  const dpi = unitTarget === "pt" ? 72 : 96;
  switch (unit) {
    case "pt":
      return unitTarget === "pt" ? value : (value * 96) / 72;
    case "pc":
      return (value * 12 * dpi) / 72;
    case "in":
      return value * dpi;
    case "cm":
      return (value * dpi) / 2.54;
    case "mm":
      return (value * dpi) / 25.4;
    case "px":
    case "":
    default:
      return value;
  }
}

function parseViewBox(raw: string | null): [number, number, number, number] | null {
  if (!raw) return null;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts[2] <= 0 || parts[3] <= 0) return null;
  return [parts[0], parts[1], parts[2], parts[3]];
}

function rewriteUrlReferences(value: string, idMap: Map<string, string>): string {
  return value.replace(/url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g, (full, _q, id) => {
    const mapped = idMap.get(id);
    return mapped ? `url(#${mapped})` : full;
  });
}

function sanitizeAndScopeElement(el: Element, idMap: Map<string, string>): void {
  const toRemove: Element[] = [];
  for (const child of Array.from(el.children)) {
    if (UNSAFE_ELEMENTS.has(child.localName.toLowerCase())) {
      toRemove.push(child);
    }
  }
  for (const dead of toRemove) {
    dead.remove();
  }

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const val = attr.value;

    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
      continue;
    }

    if (name === "href" || name === "xlink:href") {
      const trimmed = val.trim();
      const lower = trimmed.toLowerCase();
      if (trimmed.startsWith("#")) {
        const mapped = idMap.get(trimmed.slice(1));
        if (mapped) el.setAttribute(attr.name, `#${mapped}`);
      } else if (!lower.startsWith("data:image/")) {
        // Drop javascript:, http:, https:, and other external resource URIs.
        el.removeAttribute(attr.name);
      }
      continue;
    }

    if (name === "style" || REFERENCE_ATTRS.has(name)) {
      const rewritten = rewriteUrlReferences(val, idMap);
      if (rewritten !== val) {
        el.setAttribute(attr.name, rewritten);
      }
    }
  }

  if (el.localName.toLowerCase() === "style" && el.textContent) {
    el.textContent = rewriteUrlReferences(el.textContent, idMap);
  }

  for (const child of Array.from(el.children)) {
    sanitizeAndScopeElement(child, idMap);
  }
}

/**
 * Parses an SVG markup string, ensures valid viewBox and logical dimensions,
 * removes active/external script vectors, scopes all internal IDs, and configures
 * percentage sizing so Chromium re-tessellates curves crisply at arbitrary layout sizes.
 */
export function normalizeVectorSvg(
  rawSvg: string,
  unitTarget: "pt" | "px" = "pt"
): NormalizedSvg {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawSvg.trim(), "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("SVG 文档解析失败");
  }

  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg") {
    throw new Error("文档根节点不是有效 SVG 元素");
  }

  const vb = parseViewBox(root.getAttribute("viewBox"));
  const attrW = parseLengthToUnit(root.getAttribute("width"), unitTarget);
  const attrH = parseLengthToUnit(root.getAttribute("height"), unitTarget);

  const widthPt = attrW ?? vb?.[2] ?? 800;
  const heightPt = attrH ?? vb?.[3] ?? 600;

  if (!vb) {
    root.setAttribute("viewBox", `0 0 ${widthPt} ${heightPt}`);
  }

  scopeCounter += 1;
  const prefix = `opsvg_${scopeCounter}_`;
  const idMap = new Map<string, string>();
  const tagged = root.querySelectorAll("[id]");
  tagged.forEach((node, idx) => {
    const origId = node.getAttribute("id");
    if (!origId) return;
    const scopedId = `${prefix}${idx}_${origId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    idMap.set(origId, scopedId);
    node.setAttribute("id", scopedId);
  });

  sanitizeAndScopeElement(root, idMap);

  root.setAttribute("width", "100%");
  root.setAttribute("height", "100%");
  if (!root.getAttribute("preserveAspectRatio")) {
    root.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }
  root.setAttribute("style", "display:block;width:100%;height:100%");

  const svgMarkup = new XMLSerializer().serializeToString(root);
  return { svgMarkup, widthPt, heightPt };
}
