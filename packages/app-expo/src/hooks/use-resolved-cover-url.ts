import { getPlatformService } from "@readany/core/services";
import { useEffect, useState } from "react";

/**
 * Resolve a book's relative coverUrl to an absolute path/URI, with a safe
 * undefined fallback when the cover is missing or unresolvable (never throws,
 * never crashes the caller).
 */
export function useResolvedCoverUrl(coverUrl: string | undefined): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!coverUrl) {
      setResolved(undefined);
      return;
    }
    if (coverUrl.startsWith("http") || coverUrl.startsWith("blob") || coverUrl.startsWith("file")) {
      setResolved(coverUrl);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const platform = getPlatformService();
        const appData = await platform.getAppDataDir();
        const absPath = await platform.joinPath(appData, coverUrl);
        if (!cancelled) setResolved(absPath);
      } catch {
        if (!cancelled) setResolved(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [coverUrl]);

  return resolved;
}
