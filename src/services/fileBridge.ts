import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { tKey } from "../i18n";
import type { DecodedText, FileContextPayload, ZipEntryInfo } from "../core/types";

declare global {
  interface Window {
    __ONEPEEK_ANDROID__?: {
      pickFile(): void;
      consumePendingFile(): string | null;
      setBackIntercept(enabled: boolean): void;
      isExternalQuickPeek(): boolean;
      dismissQuickPeek(): void;
      openDefaultAppSettings(): void;
      trimAppCaches(activePath: string | null, inArchive: boolean): void;
      saveExportedFile?(stagedPath: string, fileName: string, mimeType: string): void;
      openExternalUrl?(url: string): boolean;
    };
    __onepeekOnFilePicked?: (path: string | null, error: string | null) => void;
    __onepeekOnExternalFile?: (path: string) => void;
    __onepeekOnExternalModeChange?: (external: boolean) => void;
    __onepeekOnAndroidBack?: () => void;
    __onepeekOnExportDone?: (savedLocation: string | null, error: string | null) => void;
  }
}

export function isAndroidRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__ONEPEEK_ANDROID__" in window || /android/i.test(navigator.userAgent))
  );
}

export function setAndroidBackIntercept(enabled: boolean): void {
  window.__ONEPEEK_ANDROID__?.setBackIntercept(enabled);
}

export function waitForNextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function toArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) {
    if (
      raw.byteOffset === 0 &&
      raw.byteLength === raw.buffer.byteLength &&
      raw.buffer instanceof ArrayBuffer
    ) {
      return raw.buffer;
    }
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice().buffer;
  }
  if (Array.isArray(raw)) {
    return new Uint8Array(raw as number[]).buffer;
  }
  throw new Error("Unsupported binary IPC payload format");
}

function buildProtocolUrl(scheme: string, href: string): string {
  const base = convertFileSrc("", scheme).replace(/\/+$/, "");
  const encodedSegments = href
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${base}/${encodedSegments}`;
}

async function pickAndStageAndroidFile(): Promise<string | null> {
  const bridge = window.__ONEPEEK_ANDROID__;
  if (bridge) {
    return new Promise((resolve, reject) => {
      window.__onepeekOnFilePicked = (path, err) => {
        window.__onepeekOnFilePicked = undefined;
        if (err) {
          reject(new Error(err));
        } else {
          resolve(path || null);
        }
      };
      try {
        bridge.pickFile();
      } catch (err) {
        window.__onepeekOnFilePicked = undefined;
        reject(err);
      }
    });
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "*/*";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(val);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        finish(null);
        return;
      }
      try {
        const batchId = `${Date.now()}`;
        let firstPath: string | null = null;
        for (const file of files) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const stagedPath = await invoke<string>("stage_picked_file", bytes, {
            headers: {
              "x-file-name": encodeURIComponent(file.name),
              "x-batch-id": batchId,
            },
          });
          if (!firstPath) firstPath = stagedPath;
        }
        finish(firstPath);
      } catch (err) {
        if (!settled) {
          settled = true;
          input.remove();
          reject(err);
        }
      }
    });

    input.click();
  });
}

// Purely local Tauri IPC & custom protocol bridge for OnePeek Community
export const FileBridge = {
  isAndroid(): boolean {
    return isAndroidRuntime();
  },

  isExternalQuickPeek(): boolean {
    return Boolean(window.__ONEPEEK_ANDROID__?.isExternalQuickPeek?.());
  },

  dismissQuickPeek(): void {
    window.__ONEPEEK_ANDROID__?.dismissQuickPeek?.();
  },

  openAndroidDefaultSettings(): void {
    window.__ONEPEEK_ANDROID__?.openDefaultAppSettings?.();
  },

  async pickFileDialog(): Promise<string | null> {
    if (isAndroidRuntime()) {
      return pickAndStageAndroidFile();
    }
    const selected = await open({
      multiple: false,
      directory: false,
      title: tKey("bridge.pickTitle"),
    });
    return typeof selected === "string" ? selected : null;
  },

  async saveExportDialog(defaultName: string, ext: "png" | "pdf"): Promise<string | null> {
    if (isAndroidRuntime()) {
      return null;
    }
    const selected = await save({
      defaultPath: defaultName,
      title: tKey("bridge.saveTitle", { ext: ext.toUpperCase() }),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    return typeof selected === "string" ? selected : null;
  },

  async writeExportFile(targetPath: string, bytes: Uint8Array): Promise<string> {
    return invoke<string>("write_export_file", bytes, {
      headers: {
        "x-export-path": encodeURIComponent(targetPath),
      },
    });
  },

  async saveAndroidExport(
    fileName: string,
    ext: "png" | "pdf",
    bytes: Uint8Array
  ): Promise<string | null> {
    const bridge = window.__ONEPEEK_ANDROID__;
    if (!bridge?.saveExportedFile) {
      throw new Error("Native Android export bridge unavailable");
    }
    const stagedPath = await invoke<string>("stage_export_file", bytes, {
      headers: {
        "x-export-name": encodeURIComponent(fileName),
      },
    });
    const mimeType = ext === "pdf" ? "application/pdf" : "image/png";
    return new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (window.__onepeekOnExportDone === onDone) {
          delete window.__onepeekOnExportDone;
        }
      };
      const onDone = (savedLocation: string | null, error: string | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(new Error(error));
        else resolve(savedLocation);
      };
      window.__onepeekOnExportDone = onDone;
      try {
        bridge.saveExportedFile!(stagedPath, fileName, mimeType);
      } catch (err) {
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  },

  async openExternalUrl(url: string): Promise<void> {
    if (isAndroidRuntime()) {
      try {
        if (window.__ONEPEEK_ANDROID__?.openExternalUrl?.(url)) {
          return;
        }
      } catch {
        // Fall through to Rust command or web fallback on older Android shells
      }
    }
    try {
      await invoke("open_external_url", { url });
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  },

  async getStartupFile(): Promise<string | null> {
    if (isAndroidRuntime()) {
      const nativePending = window.__ONEPEEK_ANDROID__?.consumePendingFile();
      if (nativePending) return nativePending;
    }
    return invoke<string | null>("get_startup_file");
  },

  async openFileContext(path: string): Promise<FileContextPayload> {
    return invoke<FileContextPayload>("open_file_context", { path });
  },

  async readBinary(path: string): Promise<ArrayBuffer> {
    const [raw] = await Promise.all([
      invoke<unknown>("read_binary_file", { path }),
      waitForNextPaint(),
    ]);
    return toArrayBuffer(raw);
  },

  async readText(path: string, maxBytes?: number): Promise<DecodedText> {
    return invoke<DecodedText>("read_text_file", { path, maxBytes });
  },

  async listArchiveEntries(path: string): Promise<ZipEntryInfo[]> {
    return invoke<ZipEntryInfo[]>("list_archive_entries", { path });
  },

  async extractArchiveEntry(archivePath: string, entryIndex: number): Promise<string> {
    return invoke<string>("extract_archive_entry", { archivePath, entryIndex });
  },

  async mountHtml(path: string): Promise<string> {
    return invoke<string>("mount_html_page", { path });
  },

  async hideToTray(): Promise<void> {
    await invoke("hide_to_tray");
  },

  async releasePreviewResources(
    activePath: string | null,
    activeKind: string | null,
    inArchive: boolean
  ): Promise<void> {
    try {
      window.__ONEPEEK_ANDROID__?.trimAppCaches?.(activePath, inArchive);
    } catch {
      // Ignore bridge errors on older Android native shells
    }
    try {
      await invoke("release_preview_resources", { activePath, activeKind, inArchive });
    } catch {
      // Ignore cleanup errors when runtime is shutting down
    }
  },

  async getQuickLookEnabled(): Promise<boolean> {
    return invoke<boolean>("get_quicklook_enabled");
  },

  async setQuickLookEnabled(enabled: boolean): Promise<boolean> {
    return invoke<boolean>("set_quicklook_enabled", { enabled });
  },

  async getAutostartEnabled(): Promise<boolean> {
    return invoke<boolean>("get_autostart_enabled");
  },

  async setAutostartEnabled(enabled: boolean): Promise<boolean> {
    return invoke<boolean>("set_autostart_enabled", { enabled });
  },

  async getMediaStreamUrl(filePath: string): Promise<string> {
    if (isAndroidRuntime()) {
      return invoke<string>("mount_media_stream", { path: filePath });
    }
    return convertFileSrc(filePath);
  },

  toAssetUrl(filePath: string): string {
    return convertFileSrc(filePath);
  },

  toHtmlUrl(relativeHref: string): string {
    return buildProtocolUrl("localhtml", relativeHref);
  },
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
