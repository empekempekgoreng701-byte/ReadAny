/**
 * Phase 10.1 — Android incoming file intents (ACTION_VIEW / ACTION_SEND).
 *
 * Flow: File Manager / other app → "Open with ReadAny" → MainActivity
 * (singleTask, onNewIntent) → expo-linking initial URL / event →
 * here → importBooks (existing pipeline) → navigate to Reader.
 *
 * content:// URIs are handled by the existing pipeline: platform.readFile
 * falls back to base64 read for content://, getMobileFileStat uses
 * getInfoAsync which supports content://. No new import system.
 */
import { useLibraryStore } from "@/stores/library-store";
import { getPlatformService } from "@readany/core/services";
import * as Linking from "expo-linking";
import { navigate } from "./navigationRef";

const SUPPORTED_EXTENSIONS = new Set([
  "epub",
  "pdf",
  "mobi",
  "azw",
  "azw3",
  "cbz",
  "fb2",
  "fbz",
  "txt",
  "umd",
  "docx",
  "html",
  "htm",
  "md",
  "markdown",
]);

function guessNameFromUrl(url: string): string | undefined {
  try {
    const withoutQuery = url.split("?")[0] || "";
    const last = withoutQuery.split("/").pop();
    if (!last) return undefined;
    return decodeURIComponent(last);
  } catch {
    return undefined;
  }
}

function isSupportedIncomingUrl(url: string): boolean {
  // Only handle file-ish URLs, never our own deep links (readany*://) —
  // those go to the shortcut handler (Phase 10.3).
  if (/^readany(-dev|-preview)?:/i.test(url)) return false;
  if (/^exp\+readany:/i.test(url)) return false;
  if (/^(content|file):\/\//i.test(url)) return true;
  return false;
}

export function getExtensionForIncomingUrl(url: string, name?: string): string | null {
  const fromName = (name || "").split(".").pop()?.toLowerCase();
  if (fromName && SUPPORTED_EXTENSIONS.has(fromName)) return fromName;
  const fromUrl = guessNameFromUrl(url)?.split(".").pop()?.toLowerCase();
  if (fromUrl && SUPPORTED_EXTENSIONS.has(fromUrl)) return fromUrl;
  return null;
}

/**
 * Fallback when the incoming URI carries no usable extension
 * (e.g. content://providers/1234): sniff magic bytes.
 * ZIP (PK..) → epub, %PDF- → pdf, else null (do not import blindly).
 */
async function sniffExtension(url: string): Promise<string | null> {
  try {
    const head = (await getPlatformService().readFile(url)).slice(0, 5);
    if (head[0] === 0x50 && head[1] === 0x4b) return "epub";
    if (
      head[0] === 0x25 &&
      head[1] === 0x50 &&
      head[2] === 0x44 &&
      head[3] === 0x46 &&
      head[4] === 0x2d
    ) {
      return "pdf";
    }
    return null;
  } catch {
    return null;
  }
}

let handlingInFlight = false;

export async function handleIncomingFileUrl(url: string | null): Promise<boolean> {
  if (!url || !isSupportedIncomingUrl(url)) return false;
  if (handlingInFlight) return true;
  handlingInFlight = true;
  try {
    const name = guessNameFromUrl(url);
    let ext = getExtensionForIncomingUrl(url, name);
    let fileName = name;
    if (!ext) {
      // No extension in URI — sniff content before importing
      ext = await sniffExtension(url);
      if (!ext) return false;
      fileName = `${name || "book"}.${ext}`;
    }
    // Stage content:// into app cache first: guarantees a stable,
    // seekable file:// path for every downstream consumer (File.copy,
    // getInfoAsync, metadata extractors) regardless of provider quirks.
    // file:// URLs skip staging.
    let importUri = url;
    let stagedName = fileName;
    if (/^content:\/\//i.test(url)) {
      const LegacyFS = await import("expo-file-system/legacy");
      const cacheDir = `${LegacyFS.cacheDirectory || LegacyFS.documentDirectory || ""}incoming/`;
      try {
        const dirInfo = await LegacyFS.getInfoAsync(cacheDir);
        if (!dirInfo.exists) {
          await LegacyFS.makeDirectoryAsync(cacheDir, { intermediates: true });
        }
      } catch {
        // best-effort; copy will fail loudly below if dir is unusable
      }
      const safeName = (fileName || "book").replace(/[^\w.\-]+/g, "_") || "book";
      const dest = `${cacheDir}${Date.now().toString(36)}-${safeName}.${ext}`;
      await LegacyFS.copyAsync({ from: url, to: dest });
      importUri = dest;
      stagedName = dest.split("/").pop();
    }
    const { importBooks, books } = useLibraryStore.getState();
    const before = new Set(books.map((b) => b.id));
    const result = await importBooks([{ uri: importUri, name: stagedName }]);
    const added = result.imported.find((b) => !before.has(b.id)) ?? result.imported[0];
    if (added) {
      navigate("Reader", { bookId: added.id });
    }
    return true;
  } catch (err) {
    console.warn("[Intent] Failed to import incoming file:", err);
    return false;
  } finally {
    handlingInFlight = false;
  }
}

/**
 * Subscribe to incoming file intents (warm start only).
 * Cold start is handled once by the App bootstrap (together with
 * Phase 10.3 shortcuts) to avoid double-handling the initial URL.
 * Warm start (singleTask + onNewIntent): 'url' event listener.
 * Returns an unsubscribe function.
 */
export function subscribeIncomingFileIntents(): () => void {
  const sub = Linking.addEventListener("url", ({ url }) => {
    void handleIncomingFileUrl(url);
  });
  return () => {
    sub.remove();
  };
}
