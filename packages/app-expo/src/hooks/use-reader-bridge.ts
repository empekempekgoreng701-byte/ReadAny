import { useSettingsStore } from "@/stores";
import type { TOCItem } from "@readany/core/types";
/**
 * useReaderBridge — encapsulates RN ↔ WebView postMessage communication
 * for the foliate-js reader engine.
 */
import { useCallback, useMemo, useRef } from "react";
import type { WebView } from "react-native-webview";

export interface RelocateEvent {
  fraction?: number;
  section?: { current: number; total: number };
  location?: { current: number; next: number; total: number };
  page?: { current: number; total: number };
  tocItem?: { label?: string; href?: string; id?: number };
  pageItem?: { label?: string };
  cfi?: string;
  textSnippet?: string;
}

export interface SelectionEvent {
  text: string;
  cfi: string;
  position: {
    x: number;
    y: number;
    selectionTop: number;
    selectionBottom: number;
  };
}

export interface BookmarkPullEvent {
  offset: number;
  armed: boolean;
  active: boolean;
}

export interface VisibleTTSSegment {
  text: string;
  cfi: string;
}

export interface VisibleTTSContext {
  before: VisibleTTSSegment[];
  after: VisibleTTSSegment[];
}

export interface ReaderInitialSettings {
  fontSize?: number;
  lineHeight?: number;
  paragraphSpacing?: number;
  justifyBodyText?: boolean;
  pageMargin?: number;
  fontTheme?: string;
  useBookFonts?: boolean;
  viewMode?: "paginated" | "scroll";
  paginatedLayout?: "single" | "double";
  /** Smooth reading: foliate `animated` page-turn + `scroll-inertia` physics */
  smoothReading?: boolean;
}

function withJustifiedTextSetting(settings: ReaderInitialSettings = {}): ReaderInitialSettings {
  return {
    justifyBodyText: useSettingsStore.getState().readSettings.justifyBodyText !== false,
    ...settings,
  };
}

export interface ReaderBridgeCallbacks {
  onRelocate?: (detail: RelocateEvent) => void;
  onBookTextMetrics?: (detail: { totalCharacters: number }) => void;
  onTocReady?: (items: TOCItem[]) => void;
  onSelection?: (detail: SelectionEvent) => void;
  onSelectionCleared?: () => void;
  onTap?: () => void;
  onSearchResult?: (index: number, count: number) => void;
  onSearchComplete?: (count: number) => void;
  onSearchResultsList?: (detail: {
    results: Array<{
      sectionIndex: number;
      blockIndex: number;
      blockOffset: number;
      excerpt: { pre: string; match: string; post: string };
    }>;
    totalCount: number;
    truncated: boolean;
  }) => void;
  onSearchCacheProgress?: (progress: number) => void;
  onAutoScrollState?: (detail: { active: boolean; speedPxPerSec: number }) => void;
  onSpeedReadState?: (detail: { active: boolean; wpm: number; chunkSize: number }) => void;
  onSpeedReadProgress?: (detail: { index: number; total: number; sectionIndex: number }) => void;
  onImageGallery?: (detail: {
    items: Array<{
      sectionIndex: number;
      imgIndex: number;
      alt: string;
      width: number;
      height: number;
      cfi: string | null;
    }>;
  }) => void;
  onImageGalleryProgress?: (progress: number) => void;
  onImageData?: (detail: {
    sectionIndex: number;
    imgIndex: number;
    dataUrl?: string;
    width: number;
    height: number;
    error?: string;
  }) => void;
  onImageTap?: (detail: {
    src: string;
    alt: string;
    sectionIndex: number;
    imgIndexInSection: number;
  }) => void;
  onError?: (message: string) => void;
  onReady?: () => void;
  onLoaded?: () => void;
  onShowAnnotation?: (detail: {
    value: string;
    range: Range;
    position: { x: number; y: number; selectionTop: number; selectionBottom: number };
  }) => void;
  onNoteTooltip?: (detail: {
    cfi: string;
    note: string;
    position: { x: number; y: number; selectionTop: number; selectionBottom: number };
  }) => void;
  onPageSnippet?: (text: string) => void;
  onBookmarkSnippet?: (text: string) => void;
  onToggleBookmark?: () => void;
  onBookmarkPull?: (detail: BookmarkPullEvent) => void;
}

export function useReaderBridge(callbacks: ReaderBridgeCallbacks) {
  const webViewRef = useRef<WebView>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const pendingVisibleTextResolveRef = useRef<((text: string) => void) | null>(null);
  const pendingVisibleTTSSegmentsResolveRef = useRef(
    new Map<string, (segments: VisibleTTSSegment[]) => void>(),
  );
  const lastTTSHighlightRef = useRef<{
    cfi: string | null;
    color: string | null;
  }>({
    cfi: null,
    color: null,
  });
  const pendingTTSContextResolveRef = useRef(
    new Map<string, (context: VisibleTTSContext) => void>(),
  );
  const pendingHrefTTSSegmentsResolveRef = useRef(
    new Map<string, (segments: VisibleTTSSegment[]) => void>(),
  );
  const pendingSectionTTSSegmentsResolveRef = useRef(
    new Map<string, (segments: VisibleTTSSegment[]) => void>(),
  );
  const pendingChapterParagraphsResolveRef = useRef<
    ((paragraphs: Array<{ id: string; text: string; tagName: string }>) => void) | null
  >(null);
  const pendingChapterTranslationInjectionResolveRef = useRef(new Map<string, () => void>());

  // ─── Send commands to WebView ───

  const inject = useCallback((code: string) => {
    webViewRef.current?.injectJavaScript(`${code}; true;`);
  }, []);

  const createRequestId = useCallback(
    (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  const openBook = useCallback(
    (params: {
      uri?: string;
      base64?: string;
      fileName?: string;
      mimeType?: string;
      lastLocation?: string;
      pageMargin?: number;
      paginatedLayout?: "single" | "double";
      settings?: ReaderInitialSettings;
    }) => {
      const msg = JSON.stringify({
        type: "openBook",
        ...params,
        settings: withJustifiedTextSetting(params.settings),
      });
      inject(`handleCommand(${msg})`);
    },
    [inject],
  );

  const goNext = useCallback(
    (distance?: number) => {
      inject(`window.goNext(${Number.isFinite(distance) ? distance : ""})`);
    },
    [inject],
  );

  const goPrev = useCallback(
    (distance?: number) => {
      inject(`window.goPrev(${Number.isFinite(distance) ? distance : ""})`);
    },
    [inject],
  );

  const goLeft = useCallback(() => {
    inject("window.goLeft()");
  }, [inject]);

  const goRight = useCallback(() => {
    inject("window.goRight()");
  }, [inject]);

  const goToFraction = useCallback(
    (fraction: number) => {
      inject(`window.goToProgress(${fraction})`);
    },
    [inject],
  );

  const goToHref = useCallback(
    (href: string) => {
      inject(`window.goToHref(${JSON.stringify(href)})`);
    },
    [inject],
  );

  const goToSection = useCallback(
    (sectionIndex: number) => {
      inject(`window.goToSection(${sectionIndex})`);
    },
    [inject],
  );

  const goToCFI = useCallback(
    (cfi: string) => {
      inject(`window.goToCFI(${JSON.stringify(cfi)})`);
    },
    [inject],
  );

  const search = useCallback(
    (query: string, opts?: { matchCase?: boolean; wholeWord?: boolean }) => {
      inject(`window.search(${JSON.stringify(query)}, ${JSON.stringify(opts ?? {})})`);
    },
    [inject],
  );

  const clearSearch = useCallback(() => {
    inject("window.clearSearch()");
  }, [inject]);

  const navigateSearch = useCallback(
    (index: number) => {
      inject(`window.navigateSearch(${index})`);
    },
    [inject],
  );

  const goToSearchMatch = useCallback(
    (sectionIndex: number, blockIndex: number, blockOffset: number) => {
      inject(`window.goToSearchMatch(${sectionIndex}, ${blockIndex}, ${blockOffset})`);
    },
    [inject],
  );

  const ensureBookTextCache = useCallback(() => {
    inject("window.ensureBookTextCache()");
  }, [inject]);

  const setAutoScroll = useCallback(
    (active: boolean, speedPxPerSec?: number) => {
      inject(`window.setAutoScroll(${active ? "true" : "false"}, ${Number(speedPxPerSec) || 0})`);
    },
    [inject],
  );

  const setSpeedRead = useCallback(
    (active: boolean, wpm?: number, chunkSize?: number) => {
      inject(
        `window.setSpeedRead(${active ? "true" : "false"}, ${Number(wpm) || 0}, ${Number(chunkSize) || 0})`,
      );
    },
    [inject],
  );

  const setBrightness = useCallback(
    (value: number) => {
      inject(`window.setBrightnessValue(${Number(value) || 0})`);
    },
    [inject],
  );

  const setEyeCare = useCallback(
    (active: boolean) => {
      inject(`window.setEyeCare(${active ? "true" : "false"})`);
    },
    [inject],
  );

  const setReadingRuler = useCallback(
    (active: boolean) => {
      inject(`window.setReadingRuler(${active ? "true" : "false"})`);
    },
    [inject],
  );

  const setBackgroundPreset = useCallback(
    (preset: string) => {
      inject(`window.setBackgroundPreset(${JSON.stringify(preset)})`);
    },
    [inject],
  );

  const requestImageGallery = useCallback(() => {
    inject("window.requestImageGallery()");
  }, [inject]);

  const requestImageData = useCallback(
    (sectionIndex: number, imgIndex: number, maxDim?: number) => {
      inject(
        `window.requestImageData(${sectionIndex}, ${imgIndex}, ${Number(maxDim) || 0})`,
      );
    },
    [inject],
  );

  const goToImageLocation = useCallback(
    (sectionIndex: number, imgIndex: number) => {
      inject(`window.goToImageLocation(${sectionIndex}, ${imgIndex})`);
    },
    [inject],
  );

  const addAnnotation = useCallback(
    (annotation: { value: string; type?: string; color?: string; note?: string }) => {
      const annotationStr = JSON.stringify(annotation);
      // Direct view.addAnnotation for immediate render + handleCommand to maintain userAnnotations map
      webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (!window.__view && document.querySelector('foliate-view')) {
              window.__view = document.querySelector('foliate-view');
            }
            var v = window.__view;
            if (v) v.addAnnotation(${annotationStr}).catch(function(){});
            if (typeof handleCommand === 'function') {
              handleCommand(${JSON.stringify({ type: "addAnnotation", annotation })});
            }
          } catch(e) {}
        })();
        true;
      `);
    },
    [],
  );

  const removeAnnotation = useCallback((annotation: { value: string; type?: string }) => {
    const annotationStr = JSON.stringify(annotation);
    webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (!window.__view && document.querySelector('foliate-view')) {
              window.__view = document.querySelector('foliate-view');
            }
            var v = window.__view;
            if (v) v.deleteAnnotation(${annotationStr}).catch(function(){});
            if (typeof handleCommand === 'function') {
              handleCommand(${JSON.stringify({ type: "removeAnnotation", annotation })});
            }
          } catch(e) {}
        })();
        true;
      `);
  }, []);

  const highlightCFITemporarily = useCallback(
    (cfi: string, duration = 1000) => {
      inject(`window.addAnnotation(${JSON.stringify({ value: cfi, color: "orange" })})`);
      setTimeout(() => {
        inject(`window.removeAnnotation(${JSON.stringify({ value: cfi })})`);
      }, duration);
    },
    [inject],
  );

  const applySettings = useCallback(
    (settings: {
      fontSize?: number;
      lineHeight?: number;
      paragraphSpacing?: number;
      justifyBodyText?: boolean;
      pageMargin?: number;
      fontTheme?: string;
      useBookFonts?: boolean;
      viewMode?: "paginated" | "scroll";
      paginatedLayout?: "single" | "double";
      customFontFaceCSS?: string;
      customFontFamily?: string;
      smoothReading?: boolean;
    }) => {
      const msg = JSON.stringify({
        type: "applySettings",
        settings: withJustifiedTextSetting(settings),
      });
      inject(`handleCommand(${msg})`);
    },
    [inject],
  );

  const setThemeColors = useCallback(
    (colors: {
      background: string;
      foreground: string;
      muted: string;
      primary?: string;
      themeMode?: "light" | "dark" | "sepia" | "oled";
    }) => {
      const msg = JSON.stringify({ type: "setThemeColors", colors, themeMode: colors.themeMode });
      inject(`handleCommand(${msg})`);
    },
    [inject],
  );

  const setNavigationLocked = useCallback(
    (locked: boolean) => {
      inject(`window.setNavigationLocked(${locked})`);
    },
    [inject],
  );

  const setBookmarkPullState = useCallback(
    (params: {
      bookmarked: boolean;
      pullToAdd: string;
      releaseToAdd: string;
      pullToRemove: string;
      releaseToRemove: string;
    }) => {
      inject(`window.setBookmarkPullState(${JSON.stringify(params)})`);
    },
    [inject],
  );

  const requestPageSnippet = useCallback(() => {
    inject("window.requestPageSnippet()");
  }, [inject]);

  const getVisibleText = useCallback(() => {
    return new Promise<string>((resolve) => {
      // Store the resolve function so handleMessage can call it
      pendingVisibleTextResolveRef.current = resolve;

      webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (!window.getVisibleText) {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'visibleText',text:'',error:'getVisibleText not defined'}));
              return;
            }
            var resultStr = window.getVisibleText();
            var result = JSON.parse(resultStr);
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type:'visibleText',
              text: result.text || '',
              error: result.error || null,
              debug: result.debug || null
            }));
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'visibleText',text:'',error:String(e)}));
          }
        })();
        true;
      `);
      // Resolve with empty string after timeout
      setTimeout(() => {
        if (pendingVisibleTextResolveRef.current === resolve) {
          pendingVisibleTextResolveRef.current = null;
          resolve("");
        }
      }, 2000);
    });
  }, []);

  const getVisibleTTSSegments = useCallback(
    (alignCfi?: string | null) => {
      return new Promise<VisibleTTSSegment[]>((resolve) => {
        const requestId = createRequestId("visible-tts");
        pendingVisibleTTSSegmentsResolveRef.current.set(requestId, resolve);

        webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (window.doGetVisibleTTSSegments) {
              window.doGetVisibleTTSSegments(${JSON.stringify(alignCfi || null)}, ${JSON.stringify(requestId)});
            } else {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'visibleTTSSegments',requestId:${JSON.stringify(requestId)},segments:[],error:'doGetVisibleTTSSegments not defined'}));
            }
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'visibleTTSSegments',requestId:${JSON.stringify(requestId)},segments:[],error:String(e)}));
          }
        })();
        true;
      `);

        setTimeout(() => {
          const pendingResolve = pendingVisibleTTSSegmentsResolveRef.current.get(requestId);
          if (pendingResolve === resolve) {
            pendingVisibleTTSSegmentsResolveRef.current.delete(requestId);
            resolve([]);
          }
        }, 4000);
      });
    },
    [createRequestId],
  );

  const getTTSSegmentContext = useCallback(
    (cfi: string, before = 10, after = 10) => {
      return new Promise<VisibleTTSContext>((resolve) => {
        const requestId = createRequestId("tts-context");
        pendingTTSContextResolveRef.current.set(requestId, resolve);

        webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (window.doGetTTSSegmentContext) {
              window.doGetTTSSegmentContext(${JSON.stringify(cfi)}, ${before}, ${after}, ${JSON.stringify(requestId)});
            } else {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'ttsSegmentContext',requestId:${JSON.stringify(requestId)},before:[],after:[],error:'doGetTTSSegmentContext not defined'}));
            }
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'ttsSegmentContext',requestId:${JSON.stringify(requestId)},before:[],after:[],error:String(e)}));
          }
        })();
        true;
      `);

        setTimeout(() => {
          const pendingResolve = pendingTTSContextResolveRef.current.get(requestId);
          if (pendingResolve === resolve) {
            pendingTTSContextResolveRef.current.delete(requestId);
            resolve({ before: [], after: [] });
          }
        }, 4000);
      });
    },
    [createRequestId],
  );

  const getHrefTTSSegments = useCallback(
    (href: string, count = 24) => {
      return new Promise<VisibleTTSSegment[]>((resolve) => {
        const requestId = createRequestId("href-tts");
        pendingHrefTTSSegmentsResolveRef.current.set(requestId, resolve);

        webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (window.doGetHrefTTSSegments) {
              window.doGetHrefTTSSegments(${JSON.stringify(href)}, ${Math.max(1, count)}, ${JSON.stringify(requestId)});
            } else {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'hrefTTSSegments',requestId:${JSON.stringify(requestId)},segments:[],error:'doGetHrefTTSSegments not defined'}));
            }
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'hrefTTSSegments',requestId:${JSON.stringify(requestId)},segments:[],error:String(e)}));
          }
        })();
        true;
      `);

        setTimeout(() => {
          const pendingResolve = pendingHrefTTSSegmentsResolveRef.current.get(requestId);
          if (pendingResolve === resolve) {
            pendingHrefTTSSegmentsResolveRef.current.delete(requestId);
            resolve([]);
          }
        }, 5000);
      });
    },
    [createRequestId],
  );

  const getSectionTTSSegments = useCallback(
    (sectionIndex: number, count = 24) => {
      return new Promise<VisibleTTSSegment[]>((resolve) => {
        const requestId = createRequestId("section-tts");
        pendingSectionTTSSegmentsResolveRef.current.set(requestId, resolve);

        webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (window.doGetSectionTTSSegments) {
              window.doGetSectionTTSSegments(${sectionIndex}, ${Math.max(1, count)}, ${JSON.stringify(requestId)});
            } else {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'sectionTTSSegments',requestId:${JSON.stringify(requestId)},segments:[],error:'doGetSectionTTSSegments not defined'}));
            }
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'sectionTTSSegments',requestId:${JSON.stringify(requestId)},segments:[],error:String(e)}));
          }
        })();
        true;
      `);

        setTimeout(() => {
          const pendingResolve = pendingSectionTTSSegmentsResolveRef.current.get(requestId);
          if (pendingResolve === resolve) {
            pendingSectionTTSSegmentsResolveRef.current.delete(requestId);
            resolve([]);
          }
        }, 6000);
      });
    },
    [createRequestId],
  );

  const setTTSHighlight = useCallback((cfi: string | null, color?: string, force = false) => {
    const previousCfi = lastTTSHighlightRef.current.cfi;
    const previousColor = lastTTSHighlightRef.current.color;
    const nextColor = color || null;
    if (
      !force &&
      lastTTSHighlightRef.current.cfi === cfi &&
      lastTTSHighlightRef.current.color === nextColor
    ) {
      return;
    }
    lastTTSHighlightRef.current = { cfi, color: nextColor };

    const previousCfiStr = JSON.stringify(previousCfi);
    const previousColorStr = JSON.stringify(previousColor);
    const cfiStr = JSON.stringify(cfi);
    const colorStr = JSON.stringify(nextColor);
    if (!cfi) {
      webViewRef.current?.injectJavaScript(`
          (function() {
            try {
              if (typeof handleCommand === 'function' && ${previousCfiStr}) {
                handleCommand({
                  type: 'removeAnnotation',
                  annotation: { value: ${previousCfiStr}, type: 'tts-highlight' },
                });
              }
            } catch (e) {}
          })();
          true;
        `);
      return;
    }

    webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            var removePrevious = function() {
              if (typeof handleCommand !== 'function' || !${previousCfiStr}) return Promise.resolve();
              return Promise.resolve(handleCommand({
                type: 'removeAnnotation',
                annotation: { value: ${previousCfiStr}, type: 'tts-highlight' },
              }));
            };
            var apply = function() {
              if (typeof handleCommand !== 'function') return Promise.resolve();
              return Promise.resolve(handleCommand({
                type: 'addAnnotation',
                annotation: {
                  value: ${cfiStr},
                  type: 'tts-highlight',
                  color: ${colorStr},
                },
              }));
            };
            var shouldReplace =
              ${force ? "true" : "false"} ||
              (!!${previousCfiStr} && (${previousCfiStr} !== ${cfiStr} || ${previousColorStr} !== ${colorStr}));
            (shouldReplace ? removePrevious() : Promise.resolve()).finally(apply);
          } catch (e) {}
        })();
        true;
      `);
  }, []);

  const flashHighlight = useCallback(
    (cfi: string, color?: string, duration?: number) => {
      const colorArg = color ? `'${color}'` : "null";
      const durationArg = duration ? duration : "null";
      inject(`window.flashHighlight('${cfi}', ${colorArg}, ${durationArg})`);
    },
    [inject],
  );

  const getChapterParagraphs = useCallback((sectionIndex?: number) => {
    return new Promise<Array<{ id: string; text: string; tagName: string }>>((resolve) => {
      pendingChapterParagraphsResolveRef.current = resolve;
      // Pass "undefined" (not null — Number(null) === 0 would match section 0)
      // so the WebView falls back to the primary rendered section.
      const indexArg = typeof sectionIndex === "number" ? String(sectionIndex) : "undefined";

      webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (window.doGetChapterParagraphs) {
              window.doGetChapterParagraphs(${indexArg});
            } else {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'chapterParagraphs',paragraphs:[],error:'doGetChapterParagraphs not defined'}));
            }
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'chapterParagraphs',paragraphs:[],error:String(e)}));
          }
        })();
        true;
      `);

      // Timeout fallback
      setTimeout(() => {
        if (pendingChapterParagraphsResolveRef.current === resolve) {
          pendingChapterParagraphsResolveRef.current = null;
          resolve([]);
        }
      }, 5000);
    });
  }, []);

  const injectChapterTranslations = useCallback(
    (
      results: Array<{ paragraphId: string; originalText: string; translatedText: string }>,
      visibility = { originalVisible: true, translationVisible: true },
      sectionIndex?: number,
    ) => {
      return new Promise<void>((resolve) => {
        const requestId = createRequestId("chapter-translation-inject");
        pendingChapterTranslationInjectionResolveRef.current.set(requestId, resolve);

        const payload = JSON.stringify(results);
        const visibilityPayload = JSON.stringify(visibility);
        const indexArg = typeof sectionIndex === "number" ? String(sectionIndex) : "undefined";
        webViewRef.current?.injectJavaScript(`
          (function() {
            var requestId = ${JSON.stringify(requestId)};
            var done = function(error) {
              try {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'chapterTranslationsInjected',
                  requestId: requestId,
                  error: error || null
                }));
              } catch(e) {}
            };
            try {
              if (window.doInjectChapterTranslations) {
                Promise.resolve(window.doInjectChapterTranslations(${payload}, ${visibilityPayload}, ${indexArg}))
                  .then(function() { done(null); })
                  .catch(function(e) { done(String(e)); });
              } else {
                done('doInjectChapterTranslations not defined');
              }
            } catch(e) {
              done(String(e));
            }
          })();
          true;
        `);

        setTimeout(() => {
          const pendingResolve =
            pendingChapterTranslationInjectionResolveRef.current.get(requestId);
          if (pendingResolve === resolve) {
            pendingChapterTranslationInjectionResolveRef.current.delete(requestId);
            resolve();
          }
        }, 3000);
      });
    },
    [createRequestId],
  );

  const removeChapterTranslations = useCallback((sectionIndex?: number) => {
    const indexArg = typeof sectionIndex === "number" ? String(sectionIndex) : "undefined";
    webViewRef.current?.injectJavaScript(`
      (function() {
        try {
          if (window.doRemoveChapterTranslations) {
            window.doRemoveChapterTranslations(${indexArg});
          }
        } catch(e) { console.error('[WebView] removeChapterTranslations error:', e); }
      })();
      true;
    `);
  }, []);

  // ─── Ruby Annotation Commands ───
  const setRubyDicts = useCallback((wordDictJson: string | null, charDictJson: string | null) => {
    const wordArg = wordDictJson ? JSON.stringify(wordDictJson) : "null";
    const charArg = charDictJson ? JSON.stringify(charDictJson) : "null";
    webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (window.setRubyDicts) {
              window.setRubyDicts(${wordArg}, ${charArg});
            }
          } catch(e) { console.error('[WebView] setRubyDicts error:', e); }
        })();
        true;
      `);
  }, []);

  const injectRuby = useCallback((mode: string) => {
    webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            if (window.injectRuby) window.injectRuby(${JSON.stringify(mode)});
          } catch(e) { console.error('[WebView] injectRuby error:', e); }
        })();
        true;
      `);
  }, []);

  const removeRuby = useCallback(() => {
    webViewRef.current?.injectJavaScript(`
      (function() {
        try {
          if (window.removeRuby) window.removeRuby();
        } catch(e) { console.error('[WebView] removeRuby error:', e); }
      })();
      true;
    `);
  }, []);

  // ─── Handle messages from WebView ───

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        const cb = callbacksRef.current;

        switch (msg.type) {
          case "ready":
            cb.onReady?.();
            break;
          case "loaded":
            cb.onLoaded?.();
            break;
          case "relocate":
            cb.onRelocate?.(msg);
            break;
          case "bookTextMetrics":
            cb.onBookTextMetrics?.({
              totalCharacters: Number(msg.totalCharacters) || 0,
            });
            break;
          case "toc":
            cb.onTocReady?.(msg.items || []);
            break;
          case "selection":
            cb.onSelection?.(msg);
            break;
          case "selectionCleared":
            cb.onSelectionCleared?.();
            break;
          case "tap":
            cb.onTap?.();
            break;
          case "searchResult":
            cb.onSearchResult?.(msg.index || 0, msg.count || 0);
            break;
          case "searchComplete":
            cb.onSearchComplete?.(msg.count || 0);
            break;
          case "searchResultsList":
            cb.onSearchResultsList?.({
              results: Array.isArray(msg.results) ? msg.results : [],
              totalCount: Number(msg.totalCount) || 0,
              truncated: !!msg.truncated,
            });
            break;
          case "searchCacheProgress":
            cb.onSearchCacheProgress?.(Number(msg.progress) || 0);
            break;
          case "autoScrollState":
            cb.onAutoScrollState?.({
              active: !!msg.active,
              speedPxPerSec: Number(msg.speedPxPerSec) || 0,
            });
            break;
          case "speedReadState":
            cb.onSpeedReadState?.({
              active: !!msg.active,
              wpm: Number(msg.wpm) || 0,
              chunkSize: Number(msg.chunkSize) || 0,
            });
            break;
          case "speedReadProgress":
            cb.onSpeedReadProgress?.({
              index: Number(msg.index) || 0,
              total: Number(msg.total) || 0,
              sectionIndex: Number(msg.sectionIndex) || 0,
            });
            break;
          case "imageGallery":
            cb.onImageGallery?.({
              items: Array.isArray(msg.items) ? msg.items : [],
            });
            break;
          case "imageGalleryProgress":
            cb.onImageGalleryProgress?.(Number(msg.progress) || 0);
            break;
          case "imageData":
            cb.onImageData?.({
              sectionIndex: Number(msg.sectionIndex) || 0,
              imgIndex: Number(msg.imgIndex) || 0,
              dataUrl: typeof msg.dataUrl === "string" ? msg.dataUrl : undefined,
              width: Number(msg.width) || 0,
              height: Number(msg.height) || 0,
              error: typeof msg.error === "string" ? msg.error : undefined,
            });
            break;
          case "imageTap":
            cb.onImageTap?.({
              src: String(msg.src || ""),
              alt: String(msg.alt || ""),
              sectionIndex: Number(msg.sectionIndex) || 0,
              imgIndexInSection: Number(msg.imgIndexInSection ?? msg.imgIndex) || 0,
            });
            break;
          case "error":
            console.error("[ReaderBridge] Error from WebView:", msg.message);
            cb.onError?.(msg.message || "Unknown error");
            break;
          case "foliate-loaded":
            break;
          case "show-annotation":
            if (msg.value && msg.position) {
              cb.onShowAnnotation?.({
                value: msg.value,
                range: msg.range,
                position: msg.position,
              });
            }
            break;
          case "note-tooltip":
            if (msg.cfi && msg.note && msg.position) {
              cb.onNoteTooltip?.({
                cfi: msg.cfi,
                note: msg.note,
                position: msg.position,
              });
            }
            break;
          case "pageSnippet":
            cb.onPageSnippet?.(msg.textSnippet || "");
            break;
          case "bookmarkSnippet":
            cb.onBookmarkSnippet?.(msg.textSnippet || "");
            break;
          case "toggleBookmark":
            cb.onToggleBookmark?.();
            break;
          case "bookmarkPull":
            cb.onBookmarkPull?.({
              offset: typeof msg.offset === "number" ? msg.offset : 0,
              armed: !!msg.armed,
              active: !!msg.active,
            });
            break;
          case "visibleText":
            console.log(
              "[ReaderBridge] received visibleText:",
              JSON.stringify({
                textLength: msg.text?.length || 0,
                error: msg.error || "none",
                debug: msg.debug || null,
              }),
            );
            if (pendingVisibleTextResolveRef.current) {
              pendingVisibleTextResolveRef.current(msg.text || "");
              pendingVisibleTextResolveRef.current = null;
            }
            break;
          case "visibleTTSSegments":
            {
              if (msg.debug) {
                console.log("[ReaderBridge] visibleTTSSegments debug:", JSON.stringify(msg.debug));
              }
              const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
              const pendingResolve = requestId
                ? pendingVisibleTTSSegmentsResolveRef.current.get(requestId)
                : pendingVisibleTTSSegmentsResolveRef.current.values().next().value;
              if (pendingResolve) {
                if (msg.error) {
                  console.warn("[ReaderBridge] visibleTTSSegments error:", msg.error);
                }
                pendingResolve(msg.segments || []);
                if (requestId) {
                  pendingVisibleTTSSegmentsResolveRef.current.delete(requestId);
                } else {
                  pendingVisibleTTSSegmentsResolveRef.current.clear();
                }
              }
            }
            break;
          case "ttsSegmentContext":
            {
              const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
              const pendingResolve = requestId
                ? pendingTTSContextResolveRef.current.get(requestId)
                : pendingTTSContextResolveRef.current.values().next().value;
              if (pendingResolve) {
                if (msg.error) {
                  console.warn("[ReaderBridge] ttsSegmentContext error:", msg.error);
                }
                pendingResolve({
                  before: msg.before || [],
                  after: msg.after || [],
                });
                if (requestId) {
                  pendingTTSContextResolveRef.current.delete(requestId);
                } else {
                  pendingTTSContextResolveRef.current.clear();
                }
              }
            }
            break;
          case "hrefTTSSegments":
            {
              const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
              const pendingResolve = requestId
                ? pendingHrefTTSSegmentsResolveRef.current.get(requestId)
                : pendingHrefTTSSegmentsResolveRef.current.values().next().value;
              if (pendingResolve) {
                if (msg.error) {
                  console.warn("[ReaderBridge] hrefTTSSegments error:", msg.error);
                }
                pendingResolve(msg.segments || []);
                if (requestId) {
                  pendingHrefTTSSegmentsResolveRef.current.delete(requestId);
                } else {
                  pendingHrefTTSSegmentsResolveRef.current.clear();
                }
              }
            }
            break;
          case "sectionTTSSegments":
            {
              const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
              const pendingResolve = requestId
                ? pendingSectionTTSSegmentsResolveRef.current.get(requestId)
                : pendingSectionTTSSegmentsResolveRef.current.values().next().value;
              if (pendingResolve) {
                if (msg.error) {
                  console.warn("[ReaderBridge] sectionTTSSegments error:", msg.error);
                }
                pendingResolve(msg.segments || []);
                if (requestId) {
                  pendingSectionTTSSegmentsResolveRef.current.delete(requestId);
                } else {
                  pendingSectionTTSSegmentsResolveRef.current.clear();
                }
              }
            }
            break;
          case "chapterParagraphs":
            console.log(
              "[ChapterTranslation] Received chapterParagraphs:",
              JSON.stringify({
                count: msg.paragraphs?.length || 0,
                error: msg.error || "none",
                sectionIndex: msg.sectionIndex ?? "unknown",
              }),
            );
            if (pendingChapterParagraphsResolveRef.current) {
              if (msg.error) {
                console.warn("[ChapterTranslation] WebView error:", msg.error);
              }
              pendingChapterParagraphsResolveRef.current(msg.paragraphs || []);
              pendingChapterParagraphsResolveRef.current = null;
            } else {
              console.warn(
                "[ChapterTranslation] No pending resolve for chapterParagraphs (timed out?)",
              );
            }
            break;
          case "chapterTranslationsInjected":
            {
              const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
              const pendingResolve = requestId
                ? pendingChapterTranslationInjectionResolveRef.current.get(requestId)
                : pendingChapterTranslationInjectionResolveRef.current.values().next().value;
              if (pendingResolve) {
                if (msg.error) {
                  console.warn("[ChapterTranslation] WebView injection error:", msg.error);
                }
                pendingResolve();
                if (requestId) {
                  pendingChapterTranslationInjectionResolveRef.current.delete(requestId);
                } else {
                  pendingChapterTranslationInjectionResolveRef.current.clear();
                }
              }
            }
            break;
          case "debug":
            console.log("[WebView]", msg.message);
            break;
          default:
            break;
        }
      } catch (err) {
        console.error("[ReaderBridge] Parse error:", err);
      }
    },
    [],
  );

  return useMemo(
    () => ({
      webViewRef,
      handleMessage,
      // Commands
      openBook,
      goNext,
      goPrev,
      goLeft,
      goRight,
      goToFraction,
      goToHref,
      goToSection,
      goToCFI,
      search,
      clearSearch,
      navigateSearch,
      goToSearchMatch,
      ensureBookTextCache,
      setAutoScroll,
      setSpeedRead,
      setBrightness,
      setEyeCare,
      setReadingRuler,
      setBackgroundPreset,
      requestImageGallery,
      requestImageData,
      goToImageLocation,
      addAnnotation,
      removeAnnotation,
      highlightCFITemporarily,
      applySettings,
      setThemeColors,
      setNavigationLocked,
      setBookmarkPullState,
      requestPageSnippet,
      getVisibleText,
      getVisibleTTSSegments,
      getTTSSegmentContext,
      getHrefTTSSegments,
      getSectionTTSSegments,
      setTTSHighlight,
      flashHighlight,
      getChapterParagraphs,
      injectChapterTranslations,
      removeChapterTranslations,
      setRubyDicts,
      injectRuby,
      removeRuby,
    }),
    [
      handleMessage,
      openBook,
      goNext,
      goPrev,
      goLeft,
      goRight,
      goToFraction,
      goToHref,
      goToSection,
      goToCFI,
      search,
      clearSearch,
      navigateSearch,
      goToSearchMatch,
      ensureBookTextCache,
      setAutoScroll,
      setSpeedRead,
      setBrightness,
      setEyeCare,
      setReadingRuler,
      setBackgroundPreset,
      requestImageGallery,
      requestImageData,
      goToImageLocation,
      addAnnotation,
      removeAnnotation,
      highlightCFITemporarily,
      applySettings,
      setThemeColors,
      setNavigationLocked,
      setBookmarkPullState,
      requestPageSnippet,
      getVisibleText,
      getVisibleTTSSegments,
      getTTSSegmentContext,
      getHrefTTSSegments,
      getSectionTTSSegments,
      setTTSHighlight,
      flashHighlight,
      getChapterParagraphs,
      injectChapterTranslations,
      removeChapterTranslations,
      setRubyDicts,
      injectRuby,
      removeRuby,
    ],
  );
}
