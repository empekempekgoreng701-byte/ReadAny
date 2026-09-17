/**
 * useChapterTranslation Hook
 *
 * State-machine hook that orchestrates whole-chapter translation:
 * idle → extracting → translating → complete | error
 *
 * Supports progressive injection, cancellation, and visibility toggle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settings-store";
import { getFromCache, hashSourceTexts } from "../translation/cache";
import {
  type TranslationVisualMode,
  clearChapterCache,
  fromVisualMode,
  getChapterTranslationSettings,
  isChapterFullyCached,
  markChapterFullyCached,
  toVisualMode,
  updateChapterTranslationSettings,
} from "../translation/chapter-cache";
import type {
  ChapterParagraph,
  ChapterTranslationProgress,
  ChapterTranslationResult,
} from "../translation/chapter-translator";
import { translateChapter } from "../translation/chapter-translator";
import type { AIConfig } from "../types";
import type { TranslationConfig } from "../types/translation";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type ChapterTranslationState =
  | { status: "idle" }
  | { status: "extracting" }
  | { status: "translating"; progress: ChapterTranslationProgress }
  | { status: "complete"; originalVisible: boolean; translationVisible: boolean }
  | { status: "error"; message: string };

export interface UseChapterTranslationOptions {
  bookId: string;
  sectionIndex: number;
  /** Stable chapter identity when available (stronger than positional index). */
  chapterHref?: string;
  chapterId?: string;
  aiConfig?: AIConfig;
  translationConfig?: TranslationConfig;
  /** Whether the reader is ready (DOM loaded) — auto-restore waits for this */
  ready?: boolean;
  /** Extract paragraphs from the current section DOM */
  getParagraphs: (sectionIndex?: number) => Promise<ChapterParagraph[]> | ChapterParagraph[];
  /** Inject translated paragraphs into the DOM */
  injectTranslations: (
    results: ChapterTranslationResult[],
    visibility?: { originalVisible: boolean; translationVisible: boolean },
    sectionIndex?: number,
  ) => void | Promise<void>;
  /** Remove all injected translations from the DOM */
  removeTranslations: (sectionIndex?: number) => void;
  /** Apply visibility settings to the DOM */
  applyVisibility?: (
    originalVisible: boolean,
    translationVisible: boolean,
    sectionIndex?: number,
  ) => void;
  /** Get current reader position (CFI) — used to restore position after translation injection */
  getCurrentCfi?: () => string | undefined;
  /** Navigate to a CFI — used to restore position after translation injection */
  goToCfi?: (cfi: string) => void | Promise<void>;
  /**
   * Get current reader position as a book fraction (0-1). Preferred over CFI
   * for post-injection restore: foliate fractions derive from static section
   * sizes, so they stay valid when injected translation divs shift CFI child
   * indices (restoring a pre-injection CFI would jump upward).
   */
  getCurrentFraction?: () => number | undefined;
  /** Navigate to a book fraction — used to restore position after translation injection */
  goToFraction?: (fraction: number) => void | Promise<void>;
  /** Wait until layout is stable after DOM injection (replaces arbitrary sleeps). */
  waitForLayoutStable?: () => Promise<void>;
}

export type RestoreTarget =
  | { kind: "fraction"; fraction: number }
  | { kind: "cfi"; cfi: string };

/**
 * Choose the post-injection restore anchor. Book fractions win: they resolve
 * against static section sizes (immune to injected-div CFI drift), while a
 * pre-injection CFI systematically resolves too early once translation divs
 * are interleaved. Fraction 0 (book start) needs no restore — content below
 * the viewport cannot move what is visible.
 */
export function selectRestoreTarget(input: {
  fraction?: number | null;
  cfi?: string | null;
}): RestoreTarget | null {
  const fraction = input.fraction;
  if (typeof fraction === "number" && Number.isFinite(fraction) && fraction > 0) {
    return { kind: "fraction", fraction: Math.min(fraction, 0.999999) };
  }
  if (typeof input.cfi === "string" && input.cfi.length > 0) {
    return { kind: "cfi", cfi: input.cfi };
  }
  return null;
}

function waitForNextFrames(frames = 2): Promise<void> {
  return new Promise((resolve) => {
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16);
    let remaining = frames;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else raf(tick);
    };
    raf(tick);
  });
}

export function useChapterTranslation(options: UseChapterTranslationOptions) {
  const {
    bookId,
    sectionIndex,
    chapterHref,
    chapterId,
    aiConfig: aiConfigOverride,
    ready = true,
    translationConfig: translationConfigOverride,
    getParagraphs,
    injectTranslations,
    removeTranslations,
    applyVisibility,
    getCurrentCfi,
    goToCfi,
    getCurrentFraction,
    goToFraction,
    waitForLayoutStable,
  } = options;

  const [state, setState] = useState<ChapterTranslationState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const startTranslationRef = useRef<() => void>(() => {});
  const getParagraphsRef = useRef(getParagraphs);
  const injectTranslationsRef = useRef(injectTranslations);
  const removeTranslationsRef = useRef(removeTranslations);
  const applyVisibilityRef = useRef(applyVisibility);
  const getCurrentCfiRef = useRef(getCurrentCfi);
  const goToCfiRef = useRef(goToCfi);
  const getCurrentFractionRef = useRef(getCurrentFraction);
  const goToFractionRef = useRef(goToFraction);
  const waitForLayoutStableRef = useRef(waitForLayoutStable);
  const visibilityRef = useRef({ originalVisible: true, translationVisible: true });

  const translationConfigFromStore = useSettingsStore((s) => s.translationConfig);
  const aiConfigFromStore = useSettingsStore((s) => s.aiConfig);
  const translationConfig = translationConfigOverride || translationConfigFromStore;
  const aiConfig = aiConfigOverride || aiConfigFromStore;

  getParagraphsRef.current = getParagraphs;
  injectTranslationsRef.current = injectTranslations;
  removeTranslationsRef.current = removeTranslations;
  applyVisibilityRef.current = applyVisibility;
  getCurrentCfiRef.current = getCurrentCfi;
  goToCfiRef.current = goToCfi;
  getCurrentFractionRef.current = getCurrentFraction;
  goToFractionRef.current = goToFraction;
  waitForLayoutStableRef.current = waitForLayoutStable;

  // ---- Start Translation ---------------------------------------------------
  /** @param overrideTargetLang — if provided, overrides the settings targetLang for this run */
  const startTranslation = useCallback(
    async (overrideTargetLang?: string) => {
      const requestId = ++requestIdRef.current;
      const isCurrent = () => requestIdRef.current === requestId;
      // Cancel any in-flight work for the previous request/chapter.
      abortRef.current?.abort();
      abortRef.current = null;
      try {
        removeTranslationsRef.current?.(sectionIndex);
      } catch {
        // no-op
      }
      if (!isCurrent()) return;
      // A fresh explicit translation invalidates previous chapter state.
      await clearChapterCache(bookId, sectionIndex);

      // Build effective config (resolve AI endpoint)
      const config = { ...translationConfig };
      if (overrideTargetLang) {
        config.targetLang = overrideTargetLang as typeof config.targetLang;
      }
      if (config.provider.id === "ai") {
        const endpointId = config.provider.endpointId || aiConfig.activeEndpointId;
        const endpoint = aiConfig.endpoints.find((e) => e.id === endpointId);
        if (endpoint) {
          config.provider = {
            ...config.provider,
            apiKey: endpoint.apiKey,
            baseUrl: endpoint.baseUrl,
            useExactRequestUrl: endpoint.useExactRequestUrl,
            model: config.provider.model || aiConfig.activeModel,
          };
        }
      }
      // Fail fast with an actionable message instead of letting every chunk
      // fail with a provider auth error (reader-sheet parity with the
      // overview's pre-flight guard).
      if (config.provider.id === "ai" && !config.provider.apiKey) {
        if (!isCurrent()) return;
        setState({
          status: "error",
          message: "AI endpoint not configured — add an endpoint with an API key in Settings.",
        });
        return;
      }

      if (!isCurrent()) return;
      setState({ status: "extracting" });

      try {
        const paragraphs = await getParagraphsRef.current?.(sectionIndex);
        if (!isCurrent()) return;

        if (!paragraphs || paragraphs.length === 0) {
          setState({ status: "error", message: "No text to translate" });
          return;
        }
        const capturedSection = sectionIndex;
        const capturedHref = chapterHref;
        const capturedChapterId = chapterId ?? String(sectionIndex);
        const sourceHash = hashSourceTexts(paragraphs.map((p) => p.text));
        const identity = {
          bookId,
          chapterId: capturedChapterId,
          chapterHref: capturedHref,
          sourceHash,
        };

        const abortController = new AbortController();
        abortRef.current = abortController;

        const totalChars = paragraphs.reduce((sum, p) => sum + p.text.length, 0);
        setState({
          status: "translating",
          progress: { totalChars, translatedChars: 0 },
        });

        const results = await translateChapter({
          paragraphs,
          sourceLang: "AUTO",
          targetLang: config.targetLang,
          config,
          identity,
          onProgress: (progress) => {
            if (!isCurrent()) return;
            setState({ status: "translating", progress });
          },
          onChunkComplete: (chunkResults) => {
            if (!isCurrent()) return;
            void injectTranslationsRef.current?.(
              chunkResults,
              visibilityRef.current,
              capturedSection,
            );
          },
          signal: abortController.signal,
        });
        if (!isCurrent()) return;

        // Only mark fully cached when every paragraph persisted non-empty.
        const hasEmpty = results.some((r) => !r.translatedText);
        await markChapterFullyCached(bookId, capturedSection, config.targetLang, {
          chapterHref: capturedHref,
          chapterId: capturedChapterId,
          sourceHash,
          sourceLang: "AUTO",
          providerId: config.provider.id,
          verification: {
            expectedCount: paragraphs.length,
            actualCount: results.length,
            hasEmpty,
          },
        });

        setState({ status: "complete", ...visibilityRef.current });
      } catch (err) {
        if (!isCurrent()) return;
        if ((err as Error)?.name === "AbortError") {
          // Cancelled — keep whatever was already injected, go to complete
          setState({ status: "complete", ...visibilityRef.current });
        } else {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (isCurrent()) abortRef.current = null;
      }
    },
    [translationConfig, aiConfig, bookId, sectionIndex, chapterHref, chapterId],
  );

  // Keep ref in sync so auto-restore effect doesn't depend on startTranslation identity
  startTranslationRef.current = startTranslation;

  // ---- Cancel ---------------------------------------------------------------
  const cancelTranslation = useCallback(() => {
    abortRef.current?.abort();
    // State will be set to complete in the catch block above
  }, []);

  const applyMode = useCallback(
    (mode: TranslationVisualMode) => {
      const visibility = fromVisualMode(mode);
      visibilityRef.current = visibility;
      try {
        applyVisibilityRef.current?.(
          visibility.originalVisible,
          visibility.translationVisible,
          sectionIndex,
        );
      } catch {
        // no-op
      }
      updateChapterTranslationSettings(bookId, sectionIndex, {
        ...visibility,
        visualMode: mode,
        targetLang: translationConfig.targetLang,
      }).catch(() => {});
      setState((prev) => {
        if (prev.status !== "complete") return { status: "complete", ...visibility };
        return { ...prev, ...visibility };
      });
    },
    [bookId, sectionIndex, translationConfig.targetLang],
  );

  // ---- Explicit visual modes: ORIGINAL / TRANSLATION / BILINGUAL ------------
  const setVisualMode = useCallback(
    (mode: TranslationVisualMode) => {
      applyMode(mode);
    },
    [applyMode],
  );

  // ---- Toggle Original Visibility (compat) ----------------------------------
  const toggleOriginalVisible = useCallback(() => {
    const current = toVisualMode(
      visibilityRef.current.originalVisible,
      visibilityRef.current.translationVisible,
    );
    if (current === "bilingual") applyMode("translation");
    else if (current === "translation") applyMode("bilingual");
    else applyMode("bilingual");
  }, [applyMode]);

  // ---- Toggle Translation Visibility (compat) --------------------------------
  const toggleTranslationVisible = useCallback(() => {
    const current = toVisualMode(
      visibilityRef.current.originalVisible,
      visibilityRef.current.translationVisible,
    );
    if (current === "bilingual") applyMode("original");
    else if (current === "original") applyMode("bilingual");
    else applyMode("bilingual");
  }, [applyMode]);

  // ---- Reset (e.g. on chapter change) ---------------------------------------
  const reset = useCallback(async () => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      removeTranslationsRef.current?.(sectionIndex);
    } catch {
      // no-op
    }
    visibilityRef.current = { originalVisible: true, translationVisible: true };
    setState({ status: "idle" });
    // Note: we do NOT clear the persistent chapter cache here.
    // This allows auto-restore to work when the user returns to this chapter.
  }, [sectionIndex]);

  // ---- Auto-restore cached translations on section load -----------------------
  useEffect(() => {
    if (!ready || state.status !== "idle") return;

    const requestId = ++requestIdRef.current;
    let cancelled = false;
    async function restoreCachedTranslations() {
      try {
        const capturedSection = sectionIndex;
        const capturedHref = chapterHref;
        const capturedChapterId = chapterId ?? String(sectionIndex);
        const targetLang = translationConfig.targetLang;
        const providerId = translationConfig.provider.id;
        const cached = await isChapterFullyCached(bookId, capturedSection, targetLang);
        if (!cached || cancelled || requestIdRef.current !== requestId) return;

        // Load saved visibility preferences (scoped by language)
        const savedSettings = await getChapterTranslationSettings(
          bookId,
          capturedSection,
          targetLang,
        );
        // Provider change must not silently reuse incompatible results: require a
        // provider-matching flag when identity is available, else fall back to
        // per-paragraph verification below.
        if (savedSettings?.providerId && savedSettings.providerId !== providerId) {
          return;
        }
        const visibility = {
          originalVisible: savedSettings?.originalVisible ?? true,
          translationVisible: savedSettings?.translationVisible ?? true,
        };
        visibilityRef.current = visibility;

        const paragraphs = await getParagraphsRef.current?.(capturedSection);
        if (cancelled || requestIdRef.current !== requestId || !paragraphs?.length) return;
        const sourceHash = hashSourceTexts(paragraphs.map((p) => p.text));
        if (savedSettings?.sourceHash && savedSettings.sourceHash !== sourceHash) {
          return;
        }
        const identity = {
          bookId,
          chapterId: capturedChapterId,
          chapterHref: capturedHref,
          sourceHash,
        };
        const results: ChapterTranslationResult[] = [];

        for (const p of paragraphs) {
          if (cancelled || requestIdRef.current !== requestId) return;
          const translation = await getFromCache(p.text, "AUTO", targetLang, providerId, identity);
          if (translation) {
            results.push({
              paragraphId: p.id,
              originalText: p.text,
              translatedText: translation,
            });
          }
        }

        if (results.length > 0 && !cancelled && requestIdRef.current === requestId) {
          // Remember position before injection. Prefer the book fraction: it
          // resolves against static section sizes, so unlike a pre-injection
          // CFI it stays valid after translation divs shift child indices.
          const restoreTarget = selectRestoreTarget({
            fraction: getCurrentFractionRef.current?.(),
            cfi: getCurrentCfiRef.current?.(),
          });

          await injectTranslationsRef.current?.(results, visibility, capturedSection);
          if (cancelled || requestIdRef.current !== requestId) return;

          // Restore position after layout is actually stable (no arbitrary sleep).
          if (restoreTarget) {
            try {
              if (waitForLayoutStableRef.current) await waitForLayoutStableRef.current();
              else await waitForNextFrames(2);
            } catch {
              // no-op
            }
            if (cancelled || requestIdRef.current !== requestId) return;
            if (restoreTarget.kind === "fraction" && goToFractionRef.current) {
              await goToFractionRef.current(restoreTarget.fraction);
            } else if (restoreTarget.kind === "cfi" && goToCfiRef.current) {
              await goToCfiRef.current(restoreTarget.cfi);
            }
          }
          if (cancelled || requestIdRef.current !== requestId) return;

          setState({
            status: "complete",
            ...visibility,
          });
        }
      } catch (err) {
        console.warn("[Translation] Auto-restore translation failed:", err);
      }
    }

    restoreCachedTranslations();

    return () => {
      cancelled = true;
    };
  }, [
    ready,
    state.status,
    bookId,
    sectionIndex,
    chapterHref,
    chapterId,
    translationConfig.targetLang,
    translationConfig.provider.id,
  ]);

  return {
    state,
    startTranslation,
    cancelTranslation,
    toggleOriginalVisible,
    toggleTranslationVisible,
    setVisualMode,
    visualMode:
      state.status === "complete"
        ? toVisualMode(state.originalVisible, state.translationVisible)
        : ("bilingual" as TranslationVisualMode),
    reset,
  };
}
