import type { ComponentType } from "react";

declare global {
  const __APP_VERSION__: string;
}

export type ToolbarSide = "left" | "right";

export type ViewerKind =
  | "epub"
  | "pdf"
  | "ai"
  | "cdr"
  | "caj"
  | "docx"
  | "pptx"
  | "sheet"
  | "model3d"
  | "cad2d"
  | "psd"
  | "dicom"
  | "image"
  | "video"
  | "audio"
  | "html"
  | "markdown"
  | "text"
  | "archive"
  | "unsupported";

export interface FileMeta {
  path: string;
  name: string;
  ext: string;
  size: number;
}

export interface FileContextPayload {
  current: FileMeta;
  siblings: FileMeta[];
  current_index: number;
}

export interface DecodedText {
  content: string;
  encoding: string;
  truncated: boolean;
}

export interface ZipEntryInfo {
  index: number;
  name: string;
  size: number;
  compressed_size: number;
  is_dir: boolean;
}

export interface ViewerProps {
  file: FileMeta;
  onPrevSibling: () => void;
  onNextSibling: () => void;
  onOpenArchiveEntry?: (entry: ZipEntryInfo, fileEntries: ZipEntryInfo[]) => Promise<void> | void;
  onGoHome?: () => void;
}

export interface ViewerDescriptor {
  kind: ViewerKind;
  badge: string;
  color: string;
  extensions: readonly string[];
  component: ComponentType<ViewerProps>;
  proOnly?: boolean;
  guideSlug?: string;
}
