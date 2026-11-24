import { tKey } from "../i18n";
import type { ViewerDescriptor, ViewerKind } from "./types";
import { ProUpgradeView } from "../components/ProUpgradeView";
import { ArchiveViewer } from "../viewers/ArchiveViewer";
import { FallbackViewer } from "../viewers/FallbackViewer";
import { HtmlViewer } from "../viewers/HtmlViewer";
import { ImageViewer } from "../viewers/ImageViewer";
import { MediaViewer } from "../viewers/MediaViewer";
import { PdfViewer } from "../viewers/PdfViewer";
import { TextCodeViewer } from "../viewers/TextCodeViewer";

// Strategy registry: built-in Community viewers plus format-aware Pro edition handoff descriptors
const DESCRIPTORS: readonly ViewerDescriptor[] = [
  {
    kind: "pdf",
    badge: "PDF",
    color: "#ef4444",
    extensions: ["pdf"],
    component: PdfViewer,
    proOnly: false,
    guideSlug: "pdf",
  },
  {
    kind: "image",
    badge: "Image",
    color: "#06b6d4",
    extensions: ["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp", "ico", "avif", "jfif"],
    component: ImageViewer,
    proOnly: false,
  },
  {
    kind: "video",
    badge: "Video",
    color: "#ec4899",
    extensions: ["mp4", "webm", "mkv", "mov", "m4v", "avi", "ogv"],
    component: MediaViewer,
    proOnly: false,
  },
  {
    kind: "audio",
    badge: "Audio",
    color: "#f59e0b",
    extensions: ["mp3", "flac", "wav", "m4a", "aac", "opus", "wma", "ogg"],
    component: MediaViewer,
    proOnly: false,
  },
  {
    kind: "html",
    badge: "HTML",
    color: "#f97316",
    extensions: ["html", "htm", "xhtml", "shtml"],
    component: HtmlViewer,
    proOnly: false,
  },
  {
    kind: "markdown",
    badge: "Markdown",
    color: "#0ea5e9",
    extensions: ["md", "markdown"],
    component: TextCodeViewer,
    proOnly: false,
  },
  {
    kind: "text",
    badge: "Text/Code",
    color: "#64748b",
    extensions: [
      "txt", "log", "json", "yaml", "yml", "toml", "xml", "ini", "conf", "env",
      "srt", "lrc", "ass", "py", "js", "ts", "tsx", "jsx", "rs", "go", "java",
      "c", "cpp", "h", "hpp", "cs", "css", "scss", "sql", "sh",
      "bat", "ps1", "vue",
    ],
    component: TextCodeViewer,
    proOnly: false,
  },
  {
    kind: "archive",
    badge: "Archive",
    color: "#78716c",
    extensions: ["zip", "7z", "rar", "tar", "tgz", "tar.gz", "jar", "apk", "nupkg", "cbz", "whl"],
    component: ArchiveViewer,
    proOnly: false,
  },
  {
    kind: "cad2d",
    badge: "CAD 2D",
    color: "#4f46e5",
    extensions: ["dwg", "dxf"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "dwg",
  },
  {
    kind: "model3d",
    badge: "3D Model",
    color: "#14b8a6",
    extensions: [
      "stl", "obj", "ply", "glb", "gltf", "3mf", "fbx", "dae",
      "stp", "step", "p21", "igs", "iges", "brep", "brp",
    ],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "stp",
  },
  {
    kind: "cdr",
    badge: "CDR",
    color: "#15803d",
    extensions: ["cdr", "cmx"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "cdr",
  },
  {
    kind: "psd",
    badge: "PSD",
    color: "#0369a1",
    extensions: ["psd", "psb"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "psd",
  },
  {
    kind: "ai",
    badge: "AI Vector",
    color: "#d97706",
    extensions: ["ai"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "ai",
  },
  {
    kind: "dicom",
    badge: "Medical",
    color: "#0d9488",
    extensions: ["dcm", "dicom", "dic", "ima", "nii", "nii.gz", "nrrd"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "dcm",
  },
  {
    kind: "caj",
    badge: "CAJ",
    color: "#0284c7",
    extensions: ["caj", "kdh", "nh", "teb"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "caj",
  },
  {
    kind: "epub",
    badge: "eBook",
    color: "#8b5cf6",
    extensions: ["epub", "rpub", "mobi", "azw3", "azw", "prc"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "epub",
  },
  {
    kind: "docx",
    badge: "Word",
    color: "#2563eb",
    extensions: ["docx", "doc", "dotx"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "docx",
  },
  {
    kind: "pptx",
    badge: "PPT",
    color: "#ea580c",
    extensions: ["pptx", "ppt", "ppsx", "potx"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "pptx",
  },
  {
    kind: "sheet",
    badge: "Sheet",
    color: "#16a34a",
    extensions: ["xlsx", "xls", "xlsm", "xlsb", "csv", "tsv", "ods"],
    component: ProUpgradeView,
    proOnly: true,
    guideSlug: "xlsx",
  },
];

const FALLBACK_DESCRIPTOR: ViewerDescriptor = {
  kind: "unsupported",
  badge: "Unknown",
  color: "#6b7280",
  extensions: [],
  component: FallbackViewer,
  proOnly: false,
};

const EXT_TO_GUIDE_SLUG: Record<string, string> = {
  dwg: "dwg",
  dxf: "dxf",
  stp: "stp",
  step: "stp",
  p21: "stp",
  igs: "igs",
  iges: "igs",
  stl: "stl",
  "3mf": "3mf",
  glb: "glb",
  gltf: "glb",
  cdr: "cdr",
  cmx: "cdr",
  psd: "psd",
  psb: "psd",
  ai: "ai",
  dcm: "dcm",
  dicom: "dcm",
  dic: "dcm",
  ima: "dcm",
  nii: "nii",
  "nii.gz": "nii",
  caj: "caj",
  kdh: "caj",
  nh: "caj",
  teb: "caj",
  pdf: "pdf",
  epub: "epub",
  rpub: "epub",
  mobi: "mobi",
  azw3: "mobi",
  azw: "mobi",
  prc: "mobi",
  docx: "docx",
  doc: "docx",
  dotx: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
  xlsm: "xlsx",
  xlsb: "xlsx",
  pptx: "pptx",
  ppt: "pptx",
  ppsx: "pptx",
  potx: "pptx",
};

const EXTENSION_REGISTRY = new Map<string, ViewerDescriptor>();
for (const desc of DESCRIPTORS) {
  for (const ext of desc.extensions) {
    EXTENSION_REGISTRY.set(ext, desc);
  }
}

export function resolveViewer(ext: string): ViewerDescriptor {
  return EXTENSION_REGISTRY.get(ext.toLowerCase()) ?? FALLBACK_DESCRIPTOR;
}

export function resolveFormatGuideSlug(ext: string, fallbackSlug?: string): string | undefined {
  return EXT_TO_GUIDE_SLUG[ext.toLowerCase()] ?? fallbackSlug;
}

export function getViewerBadge(kind: ViewerKind): string {
  return tKey(`badge.${kind}`);
}
