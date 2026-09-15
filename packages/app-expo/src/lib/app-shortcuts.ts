import { useLibraryStore } from "@/stores/library-store";
/**
 * Phase 10.3 — Launcher shortcut deep-link handler (JS side).
 *
 * Static shortcuts (see plugins/withAndroidShortcuts.js) carry only a
 * deep link; all data resolves here at open time:
 *   - readany://library[?filter=favorites] → Tabs/Library (+ favorites filter)
 *   - readany://continue-reading         → latest book via library-store
 *
 * Works for cold start (handled after nav ready) and warm start
 * (url event). Coexists with 10.1 file intents: file-ish URLs go to
 * handleIncomingFileUrl, shortcut links come here.
 */
import * as Linking from "expo-linking";
import { navigate } from "./navigationRef";

export function isShortcutUrl(url: string): boolean {
  try {
    const parsed = Linking.parse(url);
    if (
      parsed.scheme !== "readany" &&
      parsed.scheme !== "readany-dev" &&
      parsed.scheme !== "readany-preview"
    ) {
      return false;
    }
    const path = (parsed.path || "").replace(/^\/+/, "");
    return path === "library" || path === "continue-reading";
  } catch {
    return false;
  }
}

export async function handleShortcutUrl(url: string | null): Promise<boolean> {
  if (!url || !isShortcutUrl(url)) return false;
  try {
    const parsed = Linking.parse(url);
    const path = (parsed.path || "").replace(/^\/+/, "");
    if (path === "library") {
      const filter = parsed.queryParams?.filter;
      if (filter === "favorites") {
        useLibraryStore.getState().setActiveTag("__favorites__");
      }
      navigate("Tabs");
      return true;
    }
    if (path === "continue-reading") {
      const { books, loadBooks } = useLibraryStore.getState();
      let list = books;
      if (list.length === 0) {
        try {
          await loadBooks();
          list = useLibraryStore.getState().books;
        } catch {
          // fall through to library
        }
      }
      const latest = [...list]
        .filter((b) => b.lastOpenedAt)
        .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0];
      if (latest) {
        navigate("Reader", { bookId: latest.id, cfi: latest.currentCfi });
      } else {
        navigate("Tabs");
      }
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[Shortcuts] Failed to handle shortcut URL:", err);
    return false;
  }
}

/**
 * Subscribe to shortcut deep links (warm start). Cold start is handled by
 * the caller after navigation is ready (see useAppShortcuts note in App).
 */
export function subscribeShortcutLinks(onUrl: (url: string) => void): () => void {
  const sub = Linking.addEventListener("url", ({ url }) => onUrl(url));
  return () => sub.remove();
}
