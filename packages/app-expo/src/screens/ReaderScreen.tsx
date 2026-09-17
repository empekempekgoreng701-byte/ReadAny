import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { BookmarkRibbon } from "@/components/reader/BookmarkRibbon";
import { ChapterTranslationSheet } from "@/components/reader/ChapterTranslationSheet";
import { ReadingProgressSlider } from "@/components/reader/ReadingProgressSlider";
import { SelectionPopover } from "@/components/reader/SelectionPopover";
import { TTSPage } from "@/components/reader/TTSPage";
import { TranslationPanel } from "@/components/reader/TranslationPanel";
import {
  BookmarkFilledIcon,
  BookmarkIcon,
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HeadphonesIcon,
  LanguagesIcon,
  MinusIcon,
  NotebookPenIcon,
  PaletteIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from "@/components/ui/Icon";
import { SyncButton } from "@/components/ui/SyncButton";
import { useReaderBridge } from "@/hooks/use-reader-bridge";
import type { RelocateEvent, SelectionEvent, VisibleTTSSegment } from "@/hooks/use-reader-bridge";
import { startFileServer, stopFileServer } from "@/lib/reader/local-file-server";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import {
  useAnnotationStore,
  useLibraryStore,
  useReaderStore,
  useReadingSessionStore,
  useSettingsStore,
  useTTSStore,
} from "@/stores";
import { useMissingBookPromptStore } from "@/stores/missing-book-prompt-store";
import { useTheme } from "@/styles/ThemeContext";
import { useColors, withOpacity } from "@/styles/theme";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { readingContextService } from "@readany/core/ai/reading-context-service";
import { runWithDbRetry } from "@readany/core/db/write-retry";
import { useChapterTranslation } from "@readany/core/hooks";
import { useReadingSession } from "@readany/core/hooks/use-reading-session";
import { createSelectionNoteMutation } from "@readany/core/reader";
import { getPlatformService } from "@readany/core/services";
import { getCSSFontFace, useFontStore } from "@readany/core/stores";
import type { HighlightColor, ReadSettings, TOCItem } from "@readany/core/types";
import { eventBus } from "@readany/core/utils/event-bus";
import { lruRecordDelete, lruRecordPut } from "@readany/core/utils/lru-record";
import { throttle } from "@readany/core/utils/throttle";
import { Asset } from "expo-asset";
import * as DocumentPicker from "expo-document-picker";
/**
 * ReaderScreen — WebView-based reader with foliate-js engine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  type AppStateStatus,
  Easing,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

// ── Extracted modules ──
import { ReaderNoteViewModal } from "./reader/ReaderNoteViewModal";

const REFLOWABLE_CHARACTERS_PER_LOCATION = 1500;
const MAX_TRACKED_LOCATION_DELTA = 20;
const MAX_TRACKED_PAGE_DELTA = 20;
const MAX_TRACKED_FRACTION_DELTA = 0.08;
const INITIAL_PROGRESS_RESTORE_GUARD_MS = 1800;
const PROGRAMMATIC_NAV_GUARD_MS = 1200;
const BOOK_MIME_TYPES = [
  "application/epub+zip",
  "application/pdf",
  "application/x-mobipocket-ebook",
  "application/vnd.amazon.ebook",
  "application/vnd.comicbook+zip",
  "application/x-fictionbook+xml",
  "text/plain",
  "text/html",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
];

const BOOK_FORMAT_MIME_TYPES: Partial<Record<string, string>> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/vnd.amazon.ebook",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook+zip",
  fb2: "application/x-fictionbook+xml",
  fbz: "application/x-zip-compressed-fb2",
  txt: "text/plain",
  // Converted at import time and stored as EPUB bytes (same as TXT/UMD):
  // reader must receive EPUB mime so foliate routes to the EPUB engine.
  docx: "application/epub+zip",
  html: "application/epub+zip",
  md: "application/epub+zip",
};

function normalizeBookIdentityText(value?: string): string {
  return (value || "").toLowerCase().replace(/[\s\p{P}\p{S}_-]+/gu, "");
}

function authorsLikelyMatch(a?: string, b?: string): boolean {
  const left = normalizeBookIdentityText(a);
  const right = normalizeBookIdentityText(b);
  if (!left || !right) return true;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const leftParts = left.split(/[,，、/&]+/).filter((part) => part.length > 1);
  const rightParts = right.split(/[,，、/&]+/).filter((part) => part.length > 1);
  return leftParts.some((part) =>
    rightParts.some((candidate) => part.includes(candidate) || candidate.includes(part)),
  );
}

function shouldConfirmReimportCandidate(
  originalBook: { meta: { title: string; author: string }; format: string; fileHash?: string },
  candidate: { title: string; author: string; format: string; fileHash?: string },
): boolean {
  if (candidate.fileHash && originalBook.fileHash && candidate.fileHash === originalBook.fileHash) {
    return false;
  }
  const originalTitle = normalizeBookIdentityText(originalBook.meta.title);
  const candidateTitle = normalizeBookIdentityText(candidate.title);
  const titleMismatch =
    !!originalTitle &&
    !!candidateTitle &&
    originalTitle !== candidateTitle &&
    !originalTitle.includes(candidateTitle) &&
    !candidateTitle.includes(originalTitle);
  const authorMismatch = !authorsLikelyMatch(originalBook.meta.author, candidate.author);
  const formatMismatch = originalBook.format !== candidate.format;
  return titleMismatch || (formatMismatch && authorMismatch);
}
const NOTE_TOOLTIP_WIDTH = 300;
const NOTE_TOOLTIP_SIDE_PADDING = 12;
const NOTE_TOOLTIP_ABOVE_OFFSET = 2;
const NOTE_TOOLTIP_BELOW_OFFSET = 8;
const NOTE_TOOLTIP_TOP_THRESHOLD = 180;
import { useRubyStore } from "@readany/core/stores/ruby-store";
import { ImageFullscreenViewer } from "./reader/ReaderImageGallery";
import { ReaderSettingsPanel } from "./reader/ReaderSettingsPanel";
import { ReaderTOCPanel } from "./reader/ReaderTOCPanel";
import {
  CONTROLS_TIMEOUT,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from "./reader/reader-constants";
import { BatteryIcon, ListIcon, SettingsIcon } from "./reader/reader-icons";
import { makeStyles, noteTooltipMdStyles } from "./reader/reader-styles";
import { useReaderBookmark } from "./reader/useReaderBookmark";
import { useReaderSearch } from "./reader/useReaderSearch";
import { useReaderSystemInfo } from "./reader/useReaderSystemInfo";
import { useReaderTTS } from "./reader/useReaderTTS";
import { useVolumeButtonPaging } from "./reader/useVolumeButtonPaging";

const READER_HTML_ASSET = Asset.fromModule(require("../../assets/reader/reader.html"));
const LOCAL_FONT_SERVER_DIR = "readany-fonts";

type Props = NativeStackScreenProps<RootStackParamList, "Reader">;
type TTSSegment = VisibleTTSSegment;

// ──────────────────────────── helpers ────────────────────────────

function buildCustomFontFaceCSS(
  fonts: import("@readany/core/types/font").CustomFont[],
  selectedFontId: string | null,
  localServerUrl?: string | null,
): string {
  if (!selectedFontId) return "";
  const platform = getPlatformService();
  return fonts
    .filter((f) => f.id === selectedFontId)
    .map((f) => {
      // CSS-based remote fonts: @import into the reader iframe
      if (f.source === "remote" && f.remoteCssUrl) {
        return `@import url('${f.remoteCssUrl}');`;
      }
      if (f.source === "remote") return getCSSFontFace(f);
      if (!f.filePath) return "";
      const fileUrl = localServerUrl
        ? `${localServerUrl.replace(/\/$/, "")}/${LOCAL_FONT_SERVER_DIR}/${encodeURIComponent(f.fileName)}`
        : platform.convertFileSrc(f.filePath);
      const cssFormat =
        f.format === "otf"
          ? "opentype"
          : f.format === "woff"
            ? "woff"
            : f.format === "woff2"
              ? "woff2"
              : "truetype";
      return `@font-face {\n  font-family: ${JSON.stringify(f.fontFamily)};\n  src: url('${fileUrl}') format('${cssFormat}');\n  font-weight: normal;\n  font-style: normal;\n}`;
    })
    .filter(Boolean)
    .join("\n");
}

// ──────────────────────────── ReaderScreen ────────────────────────────
export function ReaderScreen({ route, navigation }: Props) {
  const colors = useColors();
  const { mode: themeMode } = useTheme();
  const s = makeStyles(colors);
  const {
    bookId,
    cfi,
    href: initialHref,
    highlight: shouldHighlight,
    openTTS,
    openSearch: shouldOpenSearch,
  } = route.params;
  const { t, i18n } = useTranslation();
  const isWideLayout = SCREEN_WIDTH >= 768;
  const isIPadLayout = Platform.OS === "ios" && Platform.isPad;
  const shouldToggleSystemStatusBar = !isIPadLayout;
  const baseTopInset = Platform.OS === "ios" ? 20 : 24;

  // State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(false);
  const [showTOC, setShowTOC] = useState(false);
  const [tocActiveTab, setTocActiveTab] = useState<"toc" | "bookmarks" | "images">("toc");
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotebook, setShowNotebook] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translationText, setTranslationText] = useState("");
  const [showTTS, setShowTTS] = useState(false);
  const [showChapterTranslation, setShowChapterTranslation] = useState(false);
  // Auto-scroll state (speed in px/sec; persisted per session only)
  const [autoScrollActive, setAutoScrollActive] = useState(false);
  const [autoScrollSpeed, setAutoScrollSpeed] = useState(50);
  const autoScrollSpeedRef = useRef(50);
  autoScrollSpeedRef.current = autoScrollSpeed;
  const autoScrollActiveRef = useRef(false);
  const setAutoScrollActiveTracked = useCallback((active: boolean) => {
    autoScrollActiveRef.current = active;
    setAutoScrollActive(active);
  }, []);
  // Speed-read RSVP state
  const [speedReadActive, setSpeedReadActive] = useState(false);
  const [speedReadWpm, setSpeedReadWpm] = useState(300);
  const [speedReadChunk, setSpeedReadChunk] = useState(3);
  const [speedReadProgress, setSpeedReadProgress] = useState<{
    index: number;
    total: number;
  } | null>(null);
  const speedReadActiveRef = useRef(false);
  // Phase 2: brightness / eye-care / ruler / background
  const [showPhase2, setShowPhase2] = useState(false);
  const [brightness, setBrightness] = useState(100);
  const [eyeCare, setEyeCare] = useState(false);
  const [rulerOn, setRulerOn] = useState(false);
  const [bgPreset, setBgPreset] = useState("default");
  // Phase 7: image gallery
  const [imageItems, setImageItems] = useState<
    Array<{
      sectionIndex: number;
      imgIndex: number;
      alt: string;
      width: number;
      height: number;
      cfi: string | null;
    }>
  >([]);
  const [imageProgress, setImageProgress] = useState<number | null>(null);
  const [imageDataMap, setImageDataMap] = useState<Record<string, string>>({});
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const imageDataPendingRef = useRef<Set<string>>(new Set());
  const imageItemsRef = useRef<typeof imageItems>([]);
  imageItemsRef.current = imageItems;
  const viewerIndexRef = useRef<number | null>(null);
  viewerIndexRef.current = viewerIndex;

  // Gallery helpers — metadata first, lazy thumb, full-res on demand (P0-6).
  // Bounded LRU + stale-request guards: old image callbacks must never mutate
  // a destroyed gallery or a newly opened book.
  const IMAGE_DATA_MAP_LIMIT = 100;
  const MAX_IMAGE_IN_FLIGHT = 4;
  const IMAGE_RETRY_QUEUE_LIMIT = 20;
  const imageGalleryVersionRef = useRef(0);
  // Generation of the last gallery scan request; stale scan callbacks are ignored.
  const imageGalleryRequestVersionRef = useRef(0);
  // Retry queue for image requests dropped while all slots are busy (P0: dropped
  // thumbs were lost forever because viewability rarely refires).
  const imageRetryQueueRef = useRef<
    Array<{ key: string; sectionIndex: number; imgIndex: number; maxDim: number }>
  >([]);
  const enqueueImageRequest = (entry: {
    key: string;
    sectionIndex: number;
    imgIndex: number;
    maxDim: number;
  }) => {
    const q = imageRetryQueueRef.current;
    if (q.some((e) => e.key === entry.key && e.maxDim === entry.maxDim)) return;
    q.push(entry);
    if (q.length > IMAGE_RETRY_QUEUE_LIMIT) q.shift();
  };
  // Dequeue while slots are free. `cache` must be a fresh map snapshot.
  const pumpImageRetryQueue = (cache: Record<string, string>) => {
    const q = imageRetryQueueRef.current;
    while (q.length > 0 && imageDataPendingRef.current.size < MAX_IMAGE_IN_FLIGHT) {
      const next = q.shift();
      if (!next || cache[next.key] || imageDataPendingRef.current.has(next.key)) continue;
      imageDataPendingRef.current.add(next.key);
      bridgeRef.current?.requestImageData(next.sectionIndex, next.imgIndex, next.maxDim);
    }
  };
  const imageKeyFor = useCallback(
    (sectionIndex: number, imgIndex: number) => {
      const item = imageItemsRef.current.find(
        (it) => it.sectionIndex === sectionIndex && it.imgIndex === imgIndex,
      );
      if (item?.cfi) return `cfi:${item.cfi}`;
      const alt = (item?.alt || "").trim().slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, "_");
      return `sec:${sectionIndex}:idx:${imgIndex}${alt ? `:alt:${alt}` : ""}`;
    },
    [],
  );
  const putImageData = useCallback((key: string, dataUrl: string) => {
    const version = imageGalleryVersionRef.current;
    setImageDataMap((prev) => {
      if (imageGalleryVersionRef.current !== version) return prev;
      // Bounded LRU (unit-tested core helper): hits promote, overflows evict
      // least-recently-used so visible/full-res images survive longest.
      return lruRecordPut(prev, key, dataUrl, IMAGE_DATA_MAP_LIMIT);
    });
  }, []);
  const requestGalleryThumb = useCallback(
    (sectionIndex: number, imgIndex: number) => {
      const key = imageKeyFor(sectionIndex, imgIndex);
      const legacy = `${sectionIndex}:${imgIndex}`;
      if (imageDataMap[key] || imageDataMap[legacy]) return;
      // Pending + map share ONE key (legacy): onImageData deletes exactly this
      // key, so the in-flight flag always drains. The previous stable-key add
      // never matched the legacy-key delete and wedged the 4-slot window.
      if (imageDataPendingRef.current.has(legacy)) return;
      if (imageDataPendingRef.current.size >= MAX_IMAGE_IN_FLIGHT) {
        enqueueImageRequest({ key: legacy, sectionIndex, imgIndex, maxDim: 240 });
        return;
      }
      imageDataPendingRef.current.add(legacy);
      bridgeRef.current?.requestImageData(sectionIndex, imgIndex, 240);
    },
    [imageDataMap, imageKeyFor],
  );
  // Bebaskan full-res saat viewer tutup.
  const closeImageViewer = useCallback(() => {
    const idx = viewerIndexRef.current;
    setViewerIndex(null);
    if (idx != null) {
      const item = imageItemsRef.current[idx];
      if (item) {
        const key = item.cfi ? `cfi:${item.cfi}` : `${item.sectionIndex}:${item.imgIndex}`;
        const stable = imageKeyFor(item.sectionIndex, item.imgIndex);
        imageDataPendingRef.current.delete(key);
        imageDataPendingRef.current.delete(stable);
        setImageDataMap((prev) => lruRecordDelete(prev, [key, stable]));
      }
    }
  }, [imageKeyFor]);
  const openGalleryTab = useCallback(() => {
    if (imageItems.length === 0 && imageProgress == null) {
      imageGalleryVersionRef.current += 1;
      imageGalleryRequestVersionRef.current = imageGalleryVersionRef.current;
      imageDataPendingRef.current.clear();
      imageRetryQueueRef.current.length = 0;
      bridgeRef.current?.requestImageGallery();
    }
  }, [imageItems.length, imageProgress]);
  const openImageViewer = useCallback(
    (index: number) => {
      const item = imageItems[index];
      if (!item) return;
      setViewerIndex(index);
      const key = imageKeyFor(item.sectionIndex, item.imgIndex);
      const legacy = `${item.sectionIndex}:${item.imgIndex}`;
      if (imageDataMap[key] || imageDataMap[legacy]) return;
      // Same single-key rule as thumbs (see requestGalleryThumb).
      if (imageDataPendingRef.current.has(legacy)) return;
      if (imageDataPendingRef.current.size >= MAX_IMAGE_IN_FLIGHT) {
        enqueueImageRequest({
          key: legacy,
          sectionIndex: item.sectionIndex,
          imgIndex: item.imgIndex,
          maxDim: 1600,
        });
        return;
      }
      imageDataPendingRef.current.add(legacy);
      bridgeRef.current?.requestImageData(item.sectionIndex, item.imgIndex, 1600);
    },
    [imageItems, imageDataMap, imageKeyFor],
  );
  const goToGalleryImage = useCallback(
    (sectionIndex: number, imgIndex: number) => {
      // TAP = navigate to reader location (never auto-zoom).
      setViewerIndex(null);
      setShowTOC(false);
      bridgeRef.current?.goToImageLocation(sectionIndex, imgIndex);
    },
    [],
  );
  const [isReimporting, setIsReimporting] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [progress, setProgress] = useState(0);
  const [currentChapter, setCurrentChapter] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [toc, setToc] = useState<TOCItem[]>([]);
  const [bookTitle, setBookTitle] = useState("");
  const [webViewReady, setWebViewReady] = useState(false);
  const [translationReady, setTranslationReady] = useState(false);
  const [readerHtmlUri, setReaderHtmlUri] = useState<string | null>(null);
  const [currentCfi, setCurrentCfi] = useState("");
  const [selection, setSelection] = useState<SelectionEvent | null>(null);
  const [fontServerUrl, setFontServerUrl] = useState<string | null>(null);
  const [noteViewHighlight, setNoteViewHighlight] = useState<{
    id: string;
    text: string;
    note?: string;
    cfi: string;
    color: string;
  } | null>(null);
  const [noteViewEditing, setNoteViewEditing] = useState(false);
  const [noteViewContent, setNoteViewContent] = useState("");
  const [noteTooltip, setNoteTooltip] = useState<{
    note: string;
    cfi: string;
    position: { x: number; y: number; selectionTop: number; selectionBottom: number };
  } | null>(null);
  const noteTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTooltipVisibleRef = useRef(false);
  const suppressReaderTapUntilRef = useRef(0);
  const assetLoadedRef = useRef(false);
  // Mediator ref so onRelocate can fire TTS continuation without direct hook dependency
  const ttsPendingContinueRef = useRef<{
    pendingTTSContinueCallbackRef: React.RefObject<(() => void) | null>;
    pendingTTSContinueSafetyTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  } | null>(null);

  const bridgeRef = useRef<{
    requestPageSnippet: () => void;
    goNext: () => void;
    search: (
      query: string,
      opts?: { matchCase?: boolean; wholeWord?: boolean; direction?: string },
    ) => void;
    clearSearch: () => void;
    navigateSearch: (index: number) => void;
    goToSearchMatch: (sectionIndex: number, blockIndex: number, blockOffset: number) => void;
    ensureBookTextCache: () => void;
    setAutoScroll: (active: boolean, speedPxPerSec?: number) => void;
    setSpeedRead: (active: boolean, wpm?: number, chunkSize?: number) => void;
    setBrightness: (value: number) => void;
    setEyeCare: (active: boolean) => void;
    setReadingRuler: (active: boolean) => void;
    setBackgroundPreset: (preset: string) => void;
    requestImageGallery: () => void;
    requestImageData: (sectionIndex: number, imgIndex: number, maxDim?: number) => void;
    goToImageLocation: (sectionIndex: number, imgIndex: number) => void;
    getVisibleText: () => Promise<string>;
    getVisibleTTSSegments: (alignCfi?: string | null) => Promise<TTSSegment[]>;
    getChapterParagraphs: () => Promise<Array<{ id: string; text: string; tagName: string }>>;
    getTTSSegmentContext: (
      cfi: string,
      before?: number,
      after?: number,
    ) => Promise<{ before: TTSSegment[]; after: TTSSegment[] }>;
    getHrefTTSSegments?: (href: string, count?: number) => Promise<TTSSegment[]>;
    getSectionTTSSegments?: (sectionIndex: number, count?: number) => Promise<TTSSegment[]>;
    goToFraction: (fraction: number) => void;
    goToSection: (sectionIndex: number) => void;
    goToCFI: (cfi: string) => void;
    goToHref: (href: string) => void;
    flashHighlight: (cfi: string, color?: string, duration?: number) => void;
    addAnnotation: (annotation: {
      value: string;
      type?: string;
      color?: string;
      note?: string;
    }) => void;
    removeAnnotation: (annotation: { value: string; type?: string }) => void;
    setTTSHighlight: (cfi: string | null, color?: string, force?: boolean) => void;
  } | null>(null);

  // Chapter translation state
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const currentSectionIndexRef = useRef(0);
  useEffect(() => {
    currentSectionIndexRef.current = currentSectionIndex;
  }, [currentSectionIndex]);
  const chapterTranslationBridgeRef = useRef<{
    getChapterParagraphs: (
      sectionIndex?: number,
    ) => Promise<Array<{ id: string; text: string; tagName: string }>>;
    injectChapterTranslations: (
      results: Array<{ paragraphId: string; originalText: string; translatedText: string }>,
      visibility?: { originalVisible: boolean; translationVisible: boolean },
      sectionIndex?: number,
    ) => Promise<void>;
    removeChapterTranslations: (sectionIndex?: number) => void;
  } | null>(null);

  // Scroll idle detection for translation restore
  const [scrollSettled, setScrollSettled] = useState(true);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRelocateTimeRef = useRef(0);

  const readSettings = useSettingsStore((s) => s.readSettings);
  const updateReadSettings = useSettingsStore((s) => s.updateReadSettings);
  const translationConfig = useSettingsStore((s) => s.translationConfig);
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const showTopTitleProgress = readSettings.showTopTitleProgress !== false;
  const showBottomTimeBattery = readSettings.showBottomTimeBattery !== false;

  // Track OS-level accessibility font scale; re-renders when the user
  // changes the system font size while the reader is open.
  const { fontScale: systemFontScale } = useWindowDimensions();
  // Apply the system scale only when the user has opted into
  // followSystemFontScale. The store keeps the user's raw fontSize, so
  // toggling the option (or changing OS font size) doesn't drift the
  // stepper value.
  const computeEffectiveFontSize = useCallback(
    (rawFontSize: number, follow: boolean | undefined): number =>
      follow ? Math.max(1, Math.round(rawFontSize * systemFontScale)) : rawFontSize,
    [systemFontScale],
  );

  // Custom fonts — build @font-face CSS per-font using individual filePath
  const customFonts = useFontStore((s) => s.fonts);
  const selectedFontId = useFontStore((s) => s.selectedFontId);
  const customFontFamily = useMemo(() => {
    if (!selectedFontId) return "";
    return customFonts.find((f) => f.id === selectedFontId)?.fontFamily ?? "";
  }, [customFonts, selectedFontId]);
  const customFontFaceCSS = useMemo(
    () => buildCustomFontFaceCSS(customFonts, selectedFontId, fontServerUrl),
    [customFonts, selectedFontId, fontServerUrl],
  );

  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const TOOLBAR_HIDE_OFFSET = 100;
  const toolbarAnim = useRef(new Animated.Value(TOOLBAR_HIDE_OFFSET)).current;
  const readerPullAnim = useRef(new Animated.Value(0)).current;
  const lastCfiRef = useRef<string>("");
  const progressRef = useRef(0);
  const locationHistoryRef = useRef<string[]>([]);
  const lastNavigatedCfiRef = useRef<string | undefined>(undefined);
  const lastNavigatedHrefRef = useRef<string | undefined>(undefined);
  const fileServerRef = useRef<string | null>(null);
  const sessionProgressRef = useRef<{
    mode: "location" | "page" | "characters";
    current: number;
    fraction?: number;
    section?: number;
    page?: number;
  } | null>(null);
  const totalBookCharactersRef = useRef<number | null>(null);
  const progressTrackingGuardUntilRef = useRef(0);

  const incrementPagesRead = useReadingSessionStore((s) => s.incrementPagesRead);
  const incrementCharactersRead = useReadingSessionStore((s) => s.incrementCharactersRead);
  const { sendEvent } = useReadingSession(bookId); // Added useReadingSession hook
  const { books, updateBook } = useLibraryStore();
  const setGoToCfiFn = useReaderStore((s) => s.setGoToCfiFn);

  // Throttled progress save (same as desktop - 5 seconds)
  const throttledSaveProgress = useRef(
    throttle((bId: string, prog: number, cfi: string) => {
      updateBook(bId, {
        progress: prog,
        currentCfi: cfi,
      });
    }, 5000),
  ).current;
  const {
    addHighlight,
    updateHighlight,
    removeHighlight,
    loadAnnotations,
    highlights,
    removeBookmark,
  } = useAnnotationStore();
  const book = useMemo(() => books.find((b) => b.id === bookId), [books, bookId]);

  // ── System info (clock/battery/statusBar/SafeArea) ─────────────────────────
  const { readerClock, batteryLevel, isBatteryCharging, stableTopInset, insets } =
    useReaderSystemInfo({ showSearch, isIPadLayout, shouldToggleSystemStatusBar, baseTopInset });

  // ── Bookmark ───────────────────────────────────────────────────────────────
  const bookmark = useReaderBookmark({
    bookId,
    currentCfi,
    currentChapter,
    requestPageSnippet: () => bridgeRef.current?.requestPageSnippet(),
  });
  const { isBookmarked, bookBookmarks, handleToggleBookmark } = bookmark;

  const suppressProgressTracking = useCallback((duration = PROGRAMMATIC_NAV_GUARD_MS) => {
    progressTrackingGuardUntilRef.current = Math.max(
      progressTrackingGuardUntilRef.current,
      Date.now() + duration,
    );
  }, []);

  const goToCFISafely = useCallback(
    (targetCfi: string) => {
      if (!targetCfi) return;
      suppressProgressTracking();
      bridgeRef.current?.goToCFI(targetCfi);
    },
    [suppressProgressTracking],
  );

  const goToHrefSafely = useCallback(
    (href: string) => {
      if (!href) return;
      suppressProgressTracking();
      bridgeRef.current?.goToHref(href);
    },
    [suppressProgressTracking],
  );

  // ── Search ─────────────────────────────────────────────────────────────────
  // Use bridgeRef for lazy access (bridge is initialized later)
  const search = useReaderSearch({
    currentCfi,
    bridge: {
      // NOTE: every hook capability must be forwarded. Previously
      // goToSearchMatch/ensureBookTextCache/opts were dropped here, which
      // silently disabled result taps, prev/next, search prewarm, and
      // match-case/whole-word/direction options.
      search: (q, opts) => bridgeRef.current?.search?.(q, opts),
      clearSearch: () => bridgeRef.current?.clearSearch?.(),
      navigateSearch: (idx) => bridgeRef.current?.navigateSearch?.(idx),
      goToSearchMatch: (s, b, o) => bridgeRef.current?.goToSearchMatch?.(s, b, o),
      ensureBookTextCache: () => bridgeRef.current?.ensureBookTextCache?.(),
      goToCFI: (cfi) => goToCFISafely(cfi),
    },
  });

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    sessionProgressRef.current = null;
    totalBookCharactersRef.current = null;
    suppressProgressTracking(INITIAL_PROGRESS_RESTORE_GUARD_MS);
    // Drop previous book's image state (thumbs + pending + viewer) and
    // invalidate stale callbacks via version bump.
    imageGalleryVersionRef.current += 1;
    imageDataPendingRef.current.clear();
    imageRetryQueueRef.current.length = 0;
    setImageDataMap({});
    setImageItems([]);
    setImageProgress(null);
    setViewerIndex(null);
  }, [bookId]);
  const chapterTranslation = useChapterTranslation({
    bookId,
    sectionIndex: currentSectionIndex,
    chapterHref: toc?.[currentSectionIndex]?.href,
    chapterId: String(currentSectionIndex),
    aiConfig,
    ready: translationReady && scrollSettled,
    translationConfig,
    getParagraphs: async (section) => {
      if (!chapterTranslationBridgeRef.current) return [];
      // Pass the section index so the WebView extracts from the chapter
      // actually being read — not contents[0] (often a preloaded neighbor).
      const target = typeof section === "number" ? section : currentSectionIndex;
      return chapterTranslationBridgeRef.current.getChapterParagraphs(target);
    },
    injectTranslations: (results, visibility, section) => {
      const target = typeof section === "number" ? section : currentSectionIndex;
      // Guard: never inject a stale chapter's results into the current chapter.
      if (target !== currentSectionIndexRef.current) return Promise.resolve();
      return chapterTranslationBridgeRef.current?.injectChapterTranslations(
        results,
        visibility,
        target,
      );
    },
    removeTranslations: (section) => {
      const target = typeof section === "number" ? section : currentSectionIndex;
      chapterTranslationBridgeRef.current?.removeChapterTranslations(target);
    },
    applyVisibility: (originalVisible, translationVisible, section) => {
      const target = typeof section === "number" ? section : currentSectionIndex;
      const bridgeAny = bridge as unknown as {
        applyChapterTranslationVisibility?: (
          o: boolean,
          t: boolean,
          s?: number,
        ) => void;
      };
      if (bridgeAny.applyChapterTranslationVisibility) {
        bridgeAny.applyChapterTranslationVisibility(originalVisible, translationVisible, target);
      }
    },
    getCurrentCfi: () => currentCfi,
    goToCfi: (cfi) => bridgeRef.current?.goToCFI(cfi),
    waitForLayoutStable: async () => {
      // Deterministic: two animation frames in RN + one WebView frame round-trip
      // instead of an arbitrary sleep.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    },
  });

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // Also read ttsPlayState from store for volume paging guard
  const ttsPlayState = useTTSStore((s) => s.playState);
  const ttsConfig = useTTSStore((s) => s.config);

  // Focus & foreground state for volume paging whitelist
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(true);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s: AppStateStatus) =>
      setAppActive(s === "active"),
    );
    return () => sub.remove();
  }, []);

  // Load reader HTML asset
  useEffect(() => {
    if (assetLoadedRef.current) return;
    assetLoadedRef.current = true;

    const loadAsset = async () => {
      try {
        const asset = READER_HTML_ASSET;
        await asset.downloadAsync();
        const uri = asset.localUri || asset.uri;
        setReaderHtmlUri(uri);
      } catch (err) {
        console.error("[ReaderScreen] Failed to load reader.html asset:", err);
        setError("Failed to load reader");
      }
    };
    loadAsset();
  }, []);

  // Controls toggle — declared before bridge so onTap can reference it without TS error
  const toggleControls = useCallback(() => {
    const willShow = !showControls;
    setShowControls(willShow);
    Animated.timing(toolbarAnim, {
      toValue: willShow ? 0 : TOOLBAR_HIDE_OFFSET,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    if (willShow) {
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      controlsTimer.current = setTimeout(() => {
        setShowControls(false);
        Animated.timing(toolbarAnim, {
          toValue: TOOLBAR_HIDE_OFFSET,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      }, CONTROLS_TIMEOUT);
    }
  }, [showControls, toolbarAnim]);

  // Reader bridge
  const bridge = useReaderBridge({
    onReady: () => {
      setWebViewReady(true);
      bridge.webViewRef.current?.injectJavaScript(`
        (function() {
          if (!window.__view && document.querySelector('foliate-view')) {
            window.__view = document.querySelector('foliate-view');
          }
        })();
        true;
      `);
    },
    onLoaded: () => {
      setLoading(false);
      // Prewarm whole-book text cache in background so first search is instant
      search.ensureCache();
      const settings = useSettingsStore.getState().readSettings;
      const { fonts, selectedFontId: selId } = useFontStore.getState();
      const fontCSS = buildCustomFontFaceCSS(fonts, selId, fileServerRef.current);
      const fontFamily = selId ? fonts.find((f) => f.id === selId)?.fontFamily : "";
      console.log("[ReaderScreen][Font] selection", {
        selectedFontId: selId,
        fontFamily,
        fontCSSLength: fontCSS.length,
      });
      bridge.applySettings({
        fontSize: computeEffectiveFontSize(settings.fontSize, settings.followSystemFontScale),
        lineHeight: settings.lineHeight,
        paragraphSpacing: settings.paragraphSpacing,
        pageMargin: settings.pageMargin,
        fontTheme: settings.fontTheme,
        useBookFonts: settings.useBookFonts,
        viewMode: settings.viewMode,
        paginatedLayout: settings.paginatedLayout,
        smoothReading: settings.smoothReading === true,
        customFontFaceCSS: fontCSS,
        customFontFamily: fontFamily ?? "",
      });

      // Auto-restore ruby annotations if enabled for this book
      const rubyMode = useRubyStore.getState().getBookRuby(bookId);
      if (rubyMode) {
        void (async () => {
          try {
            const { checkExistingDictMobile, readDictStrings } = await import(
              "@/lib/ruby/dict-service-mobile"
            );
            const exists = await checkExistingDictMobile();
            if (exists) {
              const { wordDict, charDict } = await readDictStrings();
              if (wordDict || charDict) {
                bridge.setRubyDicts(wordDict, charDict);
                setTimeout(() => bridge.injectRuby(rubyMode), 150);
              }
            }
          } catch (err) {
            console.error("[ReaderScreen] Ruby auto-restore failed:", err);
          }
        })();
      }
    },
    onBookTextMetrics: ({ totalCharacters }) => {
      totalBookCharactersRef.current = totalCharacters > 0 ? totalCharacters : null;
    },
    onRelocate: (detail: RelocateEvent) => {
      console.log("[ReaderScreen] onRelocate", {
        section: detail.section,
        fraction: detail.fraction,
        cfi: detail.cfi,
        routeCfi: cfi,
        lastNavigated: lastNavigatedCfiRef.current,
      });

      // ── Scroll idle detection ──
      lastRelocateTimeRef.current = Date.now();
      if (scrollSettled) {
        setScrollSettled(false);
      }
      if (scrollIdleTimerRef.current) {
        clearTimeout(scrollIdleTimerRef.current);
      }
      scrollIdleTimerRef.current = setTimeout(() => {
        setScrollSettled(true);
      }, 500);

      // ── Batch state updates to reduce re-renders ──
      const newSection = detail.section?.current ?? 0;
      const sectionChanged = newSection !== currentSectionIndex;
      
      // Calculate page numbers once
      let newCurrentPage = currentPage;
      let newTotalPages = totalPages;
      if (detail.page) {
        newCurrentPage = Math.max(1, detail.page.current);
        newTotalPages = Math.max(1, detail.page.total);
      } else if (detail.section?.total && !detail.location?.total) {
        newCurrentPage = Math.max(1, detail.section.current + 1);
        newTotalPages = Math.max(1, detail.section.total);
      } else {
        newCurrentPage = 0;
        newTotalPages = 0;
      }

      // Batch all state updates into minimal calls
      if (loading) {
        setLoading(false);
      }
      
      if (sectionChanged) {
        currentSectionIndexRef.current = newSection;
        setCurrentSectionIndex(newSection);
        setTranslationReady(false);
        void chapterTranslation.reset();
      }

      // Only update if values actually changed
      if (detail.fraction != null && detail.fraction !== progress) {
        setProgress(detail.fraction);
      }

      if (newCurrentPage !== currentPage || newTotalPages !== totalPages) {
        setCurrentPage(newCurrentPage);
        setTotalPages(newTotalPages);
      }

      const trackingSuppressed = Date.now() < progressTrackingGuardUntilRef.current;

      if (detail.location?.total) {
        const totalBookCharacters = totalBookCharactersRef.current;
        const fraction = detail.fraction ?? 0;
        if (totalBookCharacters && totalBookCharacters > 0) {
          const currentCharacters = Math.round(totalBookCharacters * fraction);
          const previous = sessionProgressRef.current;
          const currentSection = detail.section?.current ?? 0;
          const currentRendererPage = detail.page?.current ?? null;

          if (
            !trackingSuppressed &&
            previous?.mode === "characters" &&
            currentCharacters > previous.current
          ) {
            if (currentRendererPage != null && previous.page != null && previous.section != null) {
              const samePage =
                previous.section === currentSection && previous.page === currentRendererPage;
              const movedForwardWithinSection =
                previous.section === currentSection &&
                currentRendererPage > previous.page &&
                currentRendererPage - previous.page <= MAX_TRACKED_PAGE_DELTA;
              const movedForwardAcrossSection =
                currentSection > previous.section && currentSection - previous.section <= 1;

              if (!samePage && (movedForwardWithinSection || movedForwardAcrossSection)) {
                incrementCharactersRead(currentCharacters - previous.current);
              }
            } else if (
              Math.abs(fraction - (previous.fraction ?? 0)) <= MAX_TRACKED_FRACTION_DELTA
            ) {
              incrementCharactersRead(currentCharacters - previous.current);
            }
          }
          sessionProgressRef.current = {
            mode: "characters",
            current: currentCharacters,
            fraction,
            section: currentSection,
            page: currentRendererPage ?? undefined,
          };
        } else {
          const previous = sessionProgressRef.current;
          if (
            !trackingSuppressed &&
            previous?.mode === "location" &&
            detail.location.current > previous.current
          ) {
            const delta = detail.location.current - previous.current;
            if (delta <= MAX_TRACKED_LOCATION_DELTA) {
              incrementCharactersRead(delta * REFLOWABLE_CHARACTERS_PER_LOCATION);
            }
          }
          sessionProgressRef.current = {
            mode: "location",
            current: detail.location.current,
            fraction,
          };
        }
      } else if (detail.section?.total) {
        const previous = sessionProgressRef.current;
        if (
          !trackingSuppressed &&
          previous?.mode === "page" &&
          detail.section.current > previous.current
        ) {
          const delta = detail.section.current - previous.current;
          if (delta <= MAX_TRACKED_PAGE_DELTA) {
            incrementPagesRead(delta);
          }
        }
        sessionProgressRef.current = { mode: "page", current: detail.section.current };
      }
      if (detail.tocItem?.label && detail.tocItem.label !== currentChapter) {
        setCurrentChapter(detail.tocItem.label);
      }
      if (detail.cfi) {
        if (lastCfiRef.current && detail.cfi !== lastCfiRef.current) {
          const fractionDiff = Math.abs((detail.fraction ?? 0) - progress);
          if (fractionDiff > 0.02 || locationHistoryRef.current.length === 0) {
            locationHistoryRef.current.push(lastCfiRef.current);
            if (locationHistoryRef.current.length > 50) {
              locationHistoryRef.current.shift();
            }
          }
        }
        lastCfiRef.current = detail.cfi;
        if (detail.cfi !== currentCfi) {
          setCurrentCfi(detail.cfi);
        }
        // Use throttled save instead of immediate update
        throttledSaveProgress(bookId, detail.fraction ?? 0, detail.cfi);
      }

      // Mark translation ready after first successful relocate (CFI navigation done)
      // Only set once per section to avoid unnecessary re-renders
      if (!translationReady && !sectionChanged) {
        setTranslationReady(true);
      }

      // If TTS is waiting for a page turn to complete, fire the continuation callback now
      // that the renderer has fully updated its position (renderer.start reflects new page).
      if (ttsPendingContinueRef.current?.pendingTTSContinueCallbackRef.current) {
        console.log("[ReaderScreen][TTS] onRelocate triggered pending TTS continuation");
        const cb = ttsPendingContinueRef.current.pendingTTSContinueCallbackRef.current;
        ttsPendingContinueRef.current.pendingTTSContinueCallbackRef.current = null;
        // Cancel the safety timer since onRelocate fired successfully
        const safetyTimerRef = ttsPendingContinueRef.current.pendingTTSContinueSafetyTimerRef;
        if (safetyTimerRef.current) {
          clearTimeout(safetyTimerRef.current);
          safetyTimerRef.current = null;
        }
        void cb();
      }

      // Sync reading context for AI tools
      readingContextService.updateContext({
        bookId,
        bookTitle: book?.meta?.title || "",
        currentChapter: {
          index: detail.section?.current ?? 0,
          title: detail.tocItem?.label || "",
          href: detail.tocItem?.href || "",
        },
        currentPosition: {
          cfi: detail.cfi || "",
          percentage: (detail.fraction ?? 0) * 100,
        },
      });
    },
    onTocReady: (items: TOCItem[]) => {
      setToc(items);
    },
    onSelection: (detail: SelectionEvent) => {
      setSelection(detail);
      // Sync selection for AI tools
      if (detail.cfi) {
        readingContextService.updateSelection({
          text: detail.text,
          cfi: detail.cfi,
          chapterIndex: 0,
          chapterTitle: "",
        });
      }
    },
    onSelectionCleared: () => {
      setSelection(null);
      readingContextService.clearSelection();
    },
    onTap: () => {
      if (noteTooltipVisibleRef.current || Date.now() < suppressReaderTapUntilRef.current) {
        return;
      }
      sendEvent({ type: "activity" });
      if (selection) {
        setSelection(null);
        return;
      }
      // Tap pauses an active auto-scroll / speed-read instead of toggling controls
      if (autoScrollActiveRef.current) {
        bridgeRef.current?.setAutoScroll(false);
        return;
      }
      if (speedReadActiveRef.current) {
        bridgeRef.current?.setSpeedRead(false);
        return;
      }
      toggleControls();
    },
    onAutoScrollState: (detail: { active: boolean; speedPxPerSec: number }) => {
      setAutoScrollActiveTracked(detail.active);
    },
    onSpeedReadState: (detail: { active: boolean; wpm: number; chunkSize: number }) => {
      speedReadActiveRef.current = detail.active;
      setSpeedReadActive(detail.active);
      if (detail.wpm) setSpeedReadWpm(detail.wpm);
      if (detail.chunkSize) setSpeedReadChunk(detail.chunkSize);
      if (!detail.active) setSpeedReadProgress(null);
    },
    onSpeedReadProgress: (detail: { index: number; total: number }) => {
      setSpeedReadProgress({ index: detail.index, total: detail.total });
    },
    onImageGallery: (detail) => {
      // Ignore stale scans (e.g. previous book's late arrival).
      if (imageGalleryVersionRef.current !== imageGalleryRequestVersionRef.current) return;
      setImageItems(detail.items);
      setImageProgress(null);
    },
    onImageGalleryProgress: (progress: number) => {
      if (imageGalleryVersionRef.current !== imageGalleryRequestVersionRef.current) return;
      setImageProgress(progress >= 1 ? null : progress);
    },
    onImageGalleryError: () => {
      if (imageGalleryVersionRef.current !== imageGalleryRequestVersionRef.current) return;
      // Terminal scan failure: clear the spinner so reopening the tab retries.
      setImageProgress(null);
    },
    onImageData: (detail) => {
      const key = `${detail.sectionIndex}:${detail.imgIndex}`;
      imageDataPendingRef.current.delete(key);
      if (!detail.dataUrl) {
        // Error replies must also free the slot (previously leaked) and pump retries.
        pumpImageRetryQueue(imageDataMap);
        return;
      }
      putImageData(key, detail.dataUrl);
      pumpImageRetryQueue(imageDataMap);
    },
    onImageTap: (detail) => {
      // Tap gambar di reader → buka fullscreen viewer di gambar tsb bila ada di gallery
      const idx = imageItemsRef.current.findIndex(
        (it) =>
          it.sectionIndex === detail.sectionIndex &&
          (it.imgIndex === detail.imgIndexInSection || detail.imgIndexInSection < 0),
      );
      if (idx >= 0) {
        setViewerIndex(idx);
      }
    },
    onToggleBookmark: () => {
      handleToggleBookmark();
    },
    onBookmarkPull: ({ offset, active }) => {
      if (active) {
        readerPullAnim.setValue(offset);
        return;
      }

      Animated.timing(readerPullAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
    },
    onSearchResult: (index: number, count: number) => {
      search.onSearchResult(index, count);
    },
    onSearchComplete: (count: number) => {
      search.onSearchComplete(count);
    },
    onSearchResultsList: (detail) => {
      search.onSearchResultsList(detail);
    },
    onSearchCacheProgress: (progress: number) => {
      search.onSearchCacheProgress(progress);
    },
    onError: (message: string) => {
      console.error("[Reader] WebView error:", message);
      if (loading) {
        setError(message);
        setLoading(false);
      }
    },
    onShowAnnotation: (detail: {
      value: string;
      position: { x: number; y: number; selectionTop: number; selectionBottom: number };
    }) => {
      suppressReaderTapUntilRef.current = Date.now() + 650;
      const highlight = highlights.find((h) => h.cfi === detail.value);
      if (!highlight) return;
      setSelection({
        text: highlight.text,
        cfi: highlight.cfi,
        position: detail.position,
      });
    },
    onNoteTooltip: (detail) => {
      suppressReaderTapUntilRef.current = Date.now() + 900;
      // Dismiss any existing tooltip
      if (noteTooltipTimer.current) {
        clearTimeout(noteTooltipTimer.current);
      }
      setNoteTooltip({
        note: detail.note,
        cfi: detail.cfi,
        position: detail.position,
      });
      // Auto-hide after 4 seconds
      noteTooltipTimer.current = setTimeout(() => {
        setNoteTooltip(null);
        noteTooltipTimer.current = null;
      }, 4000);
    },
    onPageSnippet: (_text: string) => {
      // page snippet handled by bookmark hook if pending
    },
    onBookmarkSnippet: (text: string) => {
      bookmark.onBookmarkSnippet(text);
    },
  });

  useEffect(() => {
    noteTooltipVisibleRef.current = !!noteTooltip;
  }, [noteTooltip]);

  // ── Volume button paging ─────────────────────────────────────────────────
  const isPureReadingContext = useMemo(
    () =>
      Platform.OS === "android" &&
      readSettings.volumeButtonsPageTurn === true &&
      webViewReady &&
      !loading &&
      !error &&
      !isReimporting &&
      !showSearch &&
      !showTOC &&
      !showSettings &&
      !showNotebook &&
      !showTTS &&
      !showTranslation &&
      !showChapterTranslation &&
      chapterTranslation.state.status === "idle" &&
      !selection &&
      !noteViewHighlight &&
      !noteTooltip &&
      ttsPlayState === "stopped" &&
      isFocused &&
      appActive,
    // 维护约定：任何新增遮盖正文/输入态/导航跳转，必须在此追加判定。
    [
      readSettings.volumeButtonsPageTurn, webViewReady, loading, error, isReimporting,
      showSearch, showTOC, showSettings, showNotebook, showTTS,
      showTranslation, showChapterTranslation, chapterTranslation.state.status,
      selection, noteViewHighlight, noteTooltip, ttsPlayState, isFocused, appActive,
    ],
  );

  useVolumeButtonPaging({
    active: isPureReadingContext,
    onPrev: () => bridge.goPrev(),
    onNext: () => bridge.goNext(),
  });

  bridgeRef.current = bridge;
  chapterTranslationBridgeRef.current = bridge;

  // ── useReaderTTS ──
  const tts = useReaderTTS({
    bookId,
    bookTitle: bookTitle || book?.meta.title || "",
    currentChapter,
    currentSectionIndex,
    currentCfi,
    webViewReady,
    showTTS,
    setShowTTS,
    setShowControls,
    bridgeRef,
    toc,
    bookCoverUrl: book?.meta.coverUrl,
    colors,
    goToHref: bridge.goToHref,
  });

  // Bind mediator ref so onRelocate can fire the TTS continuation callback
  ttsPendingContinueRef.current = {
    pendingTTSContinueCallbackRef: tts.pendingTTSContinueCallbackRef,
    pendingTTSContinueSafetyTimerRef: tts.pendingTTSContinueSafetyTimerRef,
  };

  // ── Non-TTS callbacks ──────────────────────────────────────────────────────

  const goToTocItem = useCallback(
    (href: string) => {
      if (lastCfiRef.current) {
        locationHistoryRef.current.push(lastCfiRef.current);
      }
      goToHrefSafely(href);
      setShowTOC(false);
    },
    [goToHrefSafely],
  );

  const goBackToPreviousLocation = useCallback(() => {
    if (locationHistoryRef.current.length === 0) return;
    const previousCfi = locationHistoryRef.current.pop();
    if (previousCfi) {
      goToCFISafely(previousCfi);
    }
  }, [goToCFISafely]);

  const canGoBack = locationHistoryRef.current.length > 0;

  const updateSetting = useCallback(
    <K extends keyof ReadSettings>(key: K, value: ReadSettings[K]) => {
      const updates = { [key]: value } as Partial<ReadSettings>;
      updateReadSettings(updates);
      const currentSettings = useSettingsStore.getState().readSettings;
      const { fonts, selectedFontId: selId } = useFontStore.getState();
      const fontCSS = buildCustomFontFaceCSS(fonts, selId, fileServerRef.current);
      const fontFamily = selId ? fonts.find((f) => f.id === selId)?.fontFamily : "";
      // Recompute effective fontSize after every settings change — covers
      // both stepper changes and toggling followSystemFontScale on/off.
      const merged = { ...currentSettings, ...updates };
      bridge.applySettings({
        ...merged,
        fontSize: computeEffectiveFontSize(merged.fontSize, merged.followSystemFontScale),
        customFontFaceCSS: fontCSS,
        customFontFamily: fontFamily ?? "",
      });
      // Page/scroll mode change while auto-scroll is active: restart with correct strategy
      if ((key === "viewMode" || key === "paginatedLayout") && autoScrollActiveRef.current) {
        const s = autoScrollSpeedRef.current;
        // Give renderer a tick to apply new flow mode before restarting
        setTimeout(() => bridgeRef.current?.setAutoScroll(true, s), 180);
      }
      // Changing flow mode invalidates speed-read word layout — pause it
      if ((key === "viewMode" || key === "paginatedLayout") && speedReadActiveRef.current) {
        bridgeRef.current?.setSpeedRead(false);
      }
    },
    [bridge, updateReadSettings, computeEffectiveFontSize],
  );

  // Selection popover handlers
  const handleHighlight = useCallback(
    (color: HighlightColor = readSettings.defaultHighlightColor ?? "yellow") => {
      if (!selection) return;
      updateReadSettings({ defaultHighlightColor: color });

      const existingHighlight = highlights.find(
        (h) => h.bookId === bookId && h.cfi === selection.cfi,
      );

      if (existingHighlight) {
        updateHighlight(existingHighlight.id, {
          color,
          updatedAt: Date.now(),
        });
        bridge.removeAnnotation({ value: existingHighlight.cfi });
        bridge.addAnnotation({
          value: existingHighlight.cfi,
          type: "highlight",
          color,
          note: existingHighlight.note,
        });
        setSelection(null);
        return;
      }

      const highlight = {
        id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        bookId,
        cfi: selection.cfi,
        text: selection.text,
        color,
        chapterTitle: currentChapter,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      addHighlight(highlight);
      bridge.addAnnotation({ value: selection.cfi, type: "highlight", color });
      setSelection(null);
    },
    [
      selection,
      readSettings.defaultHighlightColor,
      updateReadSettings,
      highlights,
      bookId,
      currentChapter,
      addHighlight,
      updateHighlight,
      bridge,
    ],
  );

  const handleDismissSelection = useCallback(() => {
    setSelection(null);
  }, []);

  useEffect(() => {
    setGoToCfiFn(() => bridge.goToCFI);
    return () => setGoToCfiFn(null);
  }, [bridge.goToCFI, setGoToCfiFn]);

  // ── Book loading effects ───────────────────────────────────────────────────

  // Load book metadata and annotations
  useEffect(() => {
    if (!book) {
      setError(t("reader.bookNotFound", "书籍未找到"));
      setLoading(false);
      return;
    }
    setBookTitle(book.meta.title);
    updateBook(bookId, { lastOpenedAt: Date.now() });
    loadAnnotations(bookId);

    return () => {
      readingContextService.clearContext();
    };
  }, [bookId]);

  useEffect(() => {
    return eventBus.on("sync:completed", () => {
      void loadAnnotations(bookId);
    });
  }, [bookId, loadAnnotations]);

  // Save progress immediately on unmount
  useEffect(() => {
    return () => {
      if (fileServerRef.current) {
        stopFileServer();
        fileServerRef.current = null;
      }
      if (lastCfiRef.current) {
        const db = require("@readany/core/db/database");
        runWithDbRetry(
          () =>
            db.updateBook(bookId, {
              progress: progressRef.current,
              currentCfi: lastCfiRef.current,
            }),
          { attempts: 10, initialDelayMs: 150 },
        ).catch((err: Error) => console.error("Failed to save progress on unmount:", err));
      }
      const { useSyncStore } = require("@readany/core/stores/sync-store");
      useSyncStore.getState().syncNow?.();
      // Reader unmount: invalidate in-flight image work (refs only, no setState).
      imageGalleryVersionRef.current += 1;
      imageDataPendingRef.current.clear();
      imageRetryQueueRef.current.length = 0;
    };
  }, [bookId]);

  // When WebView is ready and book is available, send the open command
  useEffect(() => {
    if (!webViewReady || !book?.filePath) {
      return;
    }

    const loadBook = async () => {
      try {
        setLoading(true);
        setError(null);
        const platform = getPlatformService();
        const appData = await platform.getAppDataDir();
        const absPath = await platform.joinPath(appData, book.filePath);
        // Open directly at the requested CFI (e.g. from a note/highlight tap)
        // instead of saved progress + a second seek — one layout, not two.
        const lastLocation = cfi || book.currentCfi || undefined;
        const fileName = book.filePath.split("/").pop() || "book.epub";
        const mimeType = BOOK_FORMAT_MIME_TYPES[book.format] || "application/octet-stream";

        // Start a local HTTP server so the WebView can fetch the file directly.
        // This avoids loading the entire file into RN memory + base64 encoding (33% overhead)
        // and the massive JSON serialization through injectJavaScript.
        const serverUrl = await startFileServer(appData);
        fileServerRef.current = serverUrl;
        setFontServerUrl(serverUrl);
        const encodedPath = book.filePath
          .split("/")
          .map((s) => encodeURIComponent(s))
          .join("/");

        bridge.openBook({
          uri: `${serverUrl}/${encodedPath}`,
          fileName,
          mimeType,
          lastLocation,
          pageMargin: readSettings.pageMargin,
          paginatedLayout: readSettings.paginatedLayout,
          settings: {
            fontSize: readSettings.fontSize,
            lineHeight: readSettings.lineHeight,
            paragraphSpacing: readSettings.paragraphSpacing,
            pageMargin: readSettings.pageMargin,
            fontTheme: readSettings.fontTheme,
            useBookFonts: readSettings.useBookFonts,
            viewMode: readSettings.viewMode,
            paginatedLayout: readSettings.paginatedLayout,
            smoothReading: readSettings.smoothReading === true,
          },
        });

        bridge.setThemeColors({
          background: colors.background,
          foreground: colors.foreground,
          muted: colors.mutedForeground,
          primary: colors.primary,
          themeMode,
        });
      } catch (err: any) {
        console.error("[ReaderScreen] Failed to load book:", err);
        setError(err.message || "Failed to load book file");
        setLoading(false);
      }
    };

    loadBook();
  }, [bookId, book?.filePath, loadAttempt, webViewReady]);

  const handleReimportMissingBook = useCallback(async () => {
    if (isReimporting) return;
    setIsReimporting(true);

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: BOOK_MIME_TYPES,
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const selectedUri = result.assets[0].uri;
      if (book) {
        const candidate = await useLibraryStore.getState().inspectDeletedBookCandidate(bookId, {
          uri: selectedUri,
          name: result.assets[0].name,
        });
        if (candidate && shouldConfirmReimportCandidate(book, candidate)) {
          const shouldContinue = await useMissingBookPromptStore.getState().showPrompt({
            title: t("reader.reimportMismatchTitle", "这份文件看起来和原书不太一致"),
            description: t(
              "reader.reimportMismatchDescription",
              "原书《{{originalTitle}}》与当前文件《{{candidateTitle}}》信息差异较大。仍要把它接回原来的笔记和阅读统计吗？",
              {
                originalTitle: book.meta.title,
                candidateTitle: candidate.title || t("reader.unknownBook", "未命名书籍"),
              },
            ),
            confirmLabel: t("reader.reimportContinue", "继续接回"),
            cancelLabel: t("reader.reimportPickAnotherFile", "重新选择"),
          });
          if (!shouldContinue) return;
        }
      }

      const restoredBook = await useLibraryStore
        .getState()
        .reimportDeletedBook(bookId, { uri: selectedUri, name: result.assets[0].name });

      if (!restoredBook) {
        setError(t("reader.reimportFailed", "重新导入失败，请稍后再试。"));
        return;
      }

      setError(null);
      setLoading(true);
    } catch (err) {
      console.error("[ReaderScreen] Failed to re-import missing book:", err);
      setError(
        err instanceof Error
          ? err.message
          : t("reader.reimportFailed", "重新导入失败，请稍后再试。"),
      );
    } finally {
      setIsReimporting(false);
    }
  }, [bookId, isReimporting, t]);

  // Apply theme colors when theme changes
  useEffect(() => {
    if (!webViewReady) return;
    bridge.setThemeColors({
      background: colors.background,
      foreground: colors.foreground,
      muted: colors.mutedForeground,
      primary: colors.primary,
      themeMode,
    });
  }, [themeMode, webViewReady]);

  // Re-apply font settings when custom fonts or selected font changes
  useEffect(() => {
    if (!webViewReady) return;
    bridge.applySettings({
      customFontFaceCSS: customFontFaceCSS,
      customFontFamily: customFontFamily,
    });
  }, [customFontFaceCSS, customFontFamily, webViewReady]);

  // Re-apply effective fontSize when the OS-level font scale changes while
  // the reader is open (e.g. user changes "Display & Brightness → Text Size"
  // in iOS Settings, then comes back). Only fires when followSystemFontScale
  // is on; otherwise the stored fontSize is used as-is and there's nothing
  // to re-push.
  //
  // We also re-send paragraphSpacing and pageMargin so the webview's
  // layoutScale-based scaling (in reader.template.html) re-runs against the
  // new effective font size — otherwise the renderer would keep margins
  // computed from the previous size.
  useEffect(() => {
    if (!webViewReady) return;
    if (!readSettings.followSystemFontScale) return;
    bridge.applySettings({
      fontSize: computeEffectiveFontSize(readSettings.fontSize, true),
      paragraphSpacing: readSettings.paragraphSpacing,
      pageMargin: readSettings.pageMargin,
    });
  }, [
    systemFontScale,
    readSettings.followSystemFontScale,
    readSettings.fontSize,
    readSettings.paragraphSpacing,
    readSettings.pageMargin,
    webViewReady,
    bridge,
    computeEffectiveFontSize,
  ]);

  // Load annotations into reader when ready
  useEffect(() => {
    if (!webViewReady || loading || highlights.length === 0) return;
    for (const h of highlights) {
      bridge.addAnnotation({ value: h.cfi, type: "highlight", color: h.color, note: h.note });
    }
  }, [webViewReady, loading, highlights]);

  // Reset last navigated CFI when book changes
  useEffect(() => {
    lastNavigatedCfiRef.current = undefined;
    lastNavigatedHrefRef.current = undefined;
  }, [bookId]);

  // Navigate to CFI when book is loaded (from NotesPage or AI citation navigation)
  useEffect(() => {
    if (!webViewReady || loading || !cfi || cfi === lastNavigatedCfiRef.current) return;
    goToCFISafely(cfi);
    lastNavigatedCfiRef.current = cfi;
    navigation.setParams({ bookId, cfi: undefined, highlight: undefined });

    if (shouldHighlight) {
      let flashCount = 0;
      const doFlash = () => {
        if (flashCount >= 3) return;
        bridge.flashHighlight(cfi, "orange", 500);
        flashCount++;
        if (flashCount < 3) setTimeout(doFlash, 600);
      };
      setTimeout(doFlash, 100);
    }
  }, [webViewReady, loading, cfi, shouldHighlight, goToCFISafely, navigation, bookId]);

  // Navigate to a chapter href when launched from Book Overview chapter tap.
  // CFI (exact location) always wins when both are present.
  useEffect(() => {
    if (!webViewReady || loading || cfi) return;
    if (!initialHref || initialHref === lastNavigatedHrefRef.current) return;
    goToHrefSafely(initialHref);
    lastNavigatedHrefRef.current = initialHref;
    navigation.setParams({ bookId, href: undefined });
  }, [webViewReady, loading, cfi, initialHref, goToHrefSafely, navigation, bookId]);

  // Open the search panel when launched from Book Overview search.
  useEffect(() => {
    if (!shouldOpenSearch || !webViewReady || loading) return;
    setShowSearch(true);
    navigation.setParams({ bookId, openSearch: undefined });
  }, [shouldOpenSearch, webViewReady, loading, navigation, bookId]);

  // Open TTS lyrics page when navigating from notification
  useEffect(() => {
    if (!openTTS || !webViewReady || loading) return;

    let cancelled = false;
    const openLyricsPage = async () => {
      const targetCfi =
        tts.resolvedTTSSegmentCfi || tts.ttsDisplaySegments[0]?.cfi || currentCfi || null;
      if (targetCfi && targetCfi !== currentCfi) {
        goToCFISafely(targetCfi);
        await new Promise((resolve) => setTimeout(resolve, 320));
      }
      if (cancelled) return;
      setShowControls(false);
      setShowTTS(true);
      navigation.setParams({ bookId, openTTS: undefined });
    };

    void openLyricsPage();
    return () => {
      cancelled = true;
    };
  }, [bookId, currentCfi, goToCFISafely, loading, navigation, openTTS, webViewReady]);

  if (loading && !webViewReady && !readerHtmlUri) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>{t("reader.loading", "正在加载...")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
        <View style={s.loadingWrap}>
          <Text style={s.errorText}>{t("reader.loadFailed", "加载失败")}</Text>
          <Text style={[s.loadingText, { textAlign: "center", maxWidth: 320 }]}>{error}</Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
            <TouchableOpacity
              style={s.backButton}
              onPress={() => {
                if (book?.filePath) {
                  setLoading(true);
                  setError(null);
                  setLoadAttempt((value) => value + 1);
                  return;
                }
                navigation.reset({ routes: [{ name: "Tabs" }] });
              }}
            >
              <Text style={s.backButtonText}>
                {book?.filePath ? t("common.retry", "重试") : t("common.back", "返回")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                s.backButton,
                { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
              ]}
              onPress={() => void handleReimportMissingBook()}
              disabled={isReimporting}
            >
              <Text style={[s.backButtonText, { color: colors.foreground }]}>
                {isReimporting
                  ? t("reader.reimporting", "正在重新导入...")
                  : t("reader.reimport", "重新导入")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!readerHtmlUri) {
    return (
      <View style={s.container}>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>{t("reader.loading", "加载阅读器...")}</Text>
        </View>
      </View>
    );
  }

  const layoutTopInset = stableTopInset;
  const topToolbarRowHeight = isWideLayout ? 62 : 48;
  const bottomDockIconSize = isWideLayout ? 24 : 22;
  const topToolbarIconSize = isWideLayout ? 24 : 22;
  const percent = Math.round(progress * 100);
  const topControlsTranslate = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET],
    outputRange: [0, -10],
  });
  const topControlsOpacity = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET * 0.5, TOOLBAR_HIDE_OFFSET],
    outputRange: [1, 0.28, 0],
  });
  const bottomControlsTranslate = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET],
    outputRange: [0, 12],
  });
  const bottomControlsOpacity = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET * 0.5, TOOLBAR_HIDE_OFFSET],
    outputRange: [1, 0.28, 0],
  });
  const auxToolsTranslate = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET],
    outputRange: [0, 14],
  });
  const auxToolsOpacity = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET * 0.55, TOOLBAR_HIDE_OFFSET],
    outputRange: [1, 0.24, 0],
  });

  const isPanelOpen = showTOC || showSettings || showSearch || showNotebook || showTranslation;
  const existingSelectionHighlight = selection
    ? (highlights.find(
        (highlight) => highlight.bookId === bookId && highlight.cfi === selection.cfi,
      ) ?? null)
    : null;
  const readerTopMargin = !showSearch
    ? showTopTitleProgress
      ? layoutTopInset + 30
      : layoutTopInset
    : 0;
  const readerBottomInset =
    !showSearch && showBottomTimeBattery ? Math.max(insets.bottom, 8) + 14 : 0;
  const batteryLabel = batteryLevel == null ? "--%" : `${Math.round(batteryLevel * 100)}%`;
  const selectionPopoverSelection = selection
    ? {
        ...selection,
        position: {
          ...selection.position,
          y: selection.position.y + readerTopMargin,
          selectionTop: selection.position.selectionTop + readerTopMargin,
          selectionBottom: selection.position.selectionBottom + readerTopMargin,
        },
      }
    : null;
  const adjustedNoteTooltip = noteTooltip
    ? {
        ...noteTooltip,
        position: {
          ...noteTooltip.position,
          y: noteTooltip.position.y + readerTopMargin,
          selectionTop: noteTooltip.position.selectionTop + readerTopMargin,
          selectionBottom: noteTooltip.position.selectionBottom + readerTopMargin,
        },
      }
    : null;

  return (
    <View style={[s.container, { paddingBottom: insets.bottom }]}>
      <Animated.View
        style={[s.readerStage, { transform: [{ translateY: readerPullAnim }] }]}
        pointerEvents="box-none"
      >
        {/* WebView with foliate-js */}
        <View style={{ flex: 1 }}>
          <WebView
            ref={bridge.webViewRef}
            source={{ uri: readerHtmlUri }}
            style={[
              s.webview,
              {
                marginTop: readerTopMargin,
                marginBottom: readerBottomInset,
              },
            ]}
            pointerEvents={isPanelOpen ? "none" : "auto"}
            onMessage={bridge.handleMessage}
            onError={(e) => {
              console.error("[ReaderScreen] WebView error:", e.nativeEvent);
            }}
            onHttpError={(e) => {
              console.error("[ReaderScreen] WebView HTTP error:", e.nativeEvent);
            }}
            onContentProcessDidTerminate={() => {
              console.warn("[ReaderScreen] WebView content process terminated");
            }}
            javaScriptEnabled
            domStorageEnabled
            cacheEnabled={false}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            allowsInlineMediaPlayback
            scrollEnabled={false}
            showsVerticalScrollIndicator={false}
            originWhitelist={["*"]}
            mixedContentMode="always"
          />
        </View>

        {/* Loading overlay */}
        {loading && (
          <View style={s.loadingOverlay}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        )}

        {/* ─── Top Info Bar (always visible) ─── */}
        {!showSearch && !showControls && showTopTitleProgress && (
          <View style={[s.topInfoBar, { top: layoutTopInset }]}>
            <View style={s.topInfoRow}>
              <Text style={s.topInfoText} numberOfLines={1}>
                {currentChapter || bookTitle}
              </Text>
              <Text style={s.topInfoPageText}>
                {currentPage > 0 && totalPages > 0 ? `${currentPage}/${totalPages}` : `${percent}%`}
              </Text>
            </View>
          </View>
        )}
      </Animated.View>

      {/* ─── Bookmark Ribbon (top-right) ─── */}
      <BookmarkRibbon visible={isBookmarked} topOffset={0} />

      {!showSearch && (
        <Animated.View
          pointerEvents={showControls ? "auto" : "none"}
          style={[
            s.topToolbar,
            {
              top: 0,
              left: 0,
              right: 0,
              opacity: topControlsOpacity,
              transform: [{ translateY: topControlsTranslate }],
            },
          ]}
        >
          <View
            style={[
              s.topToolbarBar,
              {
                paddingTop: layoutTopInset,
                minHeight: layoutTopInset + topToolbarRowHeight,
              },
            ]}
          >
            <View
              style={[
                s.topToolbarRow,
                {
                  minHeight: topToolbarRowHeight,
                  paddingLeft: insets.left + 12,
                  paddingRight: insets.right + 16,
                },
              ]}
            >
              <View style={s.topToolbarSideSlot}>
                <TouchableOpacity
                  style={s.topToolbarBackBtn}
                  onPress={() => navigation.reset({ routes: [{ name: "Tabs" }] })}
                >
                  <ChevronLeftIcon size={topToolbarIconSize} color={colors.foreground} />
                </TouchableOpacity>
              </View>
              <View style={s.topToolbarTitleWrap}>
                <Text style={s.topToolbarTitleText} numberOfLines={1}>
                  {currentChapter || bookTitle}
                </Text>
              </View>
              <View
                style={[
                  s.topToolbarSideSlot,
                  s.topToolbarMetaWrap,
                  { flexDirection: "row", alignItems: "center", gap: 6 },
                ]}
              >
                <SyncButton size={16} color={colors.foreground} />
                <Text style={s.topToolbarMetaText}>
                  {currentPage > 0 && totalPages > 0
                    ? `${currentPage}/${totalPages}`
                    : `${percent}%`}
                </Text>
              </View>
            </View>
            <View style={s.topToolbarProgressTrack}>
              <View style={[s.topToolbarProgressFill, { width: `${percent}%` }]} />
            </View>
          </View>
        </Animated.View>
      )}

      {/* Selection Popover */}
      {selectionPopoverSelection && (
        <SelectionPopover
          selection={selectionPopoverSelection}
          onHighlight={handleHighlight}
          onDismiss={handleDismissSelection}
          onCopy={() => {
            setSelection(null);
          }}
          onSpeak={(text, cfi) => {
            tts.startSelectionTTS(text, cfi);
            setSelection(null);
          }}
          onAIChat={() => {
            const selectedText = selectionPopoverSelection.text;
            const chapter = currentChapter;
            setSelection(null);
            navigation.navigate("BookChat", {
              bookId,
              selectedText,
              chapterTitle: chapter,
            });
          }}
          onNote={(text, cfi) => {
            const mutation = createSelectionNoteMutation({
              bookId,
              cfi,
              text: selectionPopoverSelection.text,
              note: text,
              chapterTitle: currentChapter,
              existingHighlight: existingSelectionHighlight,
              defaultColor: readSettings.defaultHighlightColor ?? "yellow",
            });

            if (mutation.kind === "create") {
              addHighlight(mutation.highlight);
              bridge.addAnnotation({
                value: cfi,
                type: "highlight",
                color: mutation.highlight.color,
                note: mutation.highlight.note,
              });
              return;
            }

            updateHighlight(mutation.id, mutation.updates);
            bridge.addAnnotation({
              value: cfi,
              type: "highlight",
              color: existingSelectionHighlight?.color || "yellow",
              note: mutation.updates.note,
            });
          }}
          onTranslate={(text) => {
            setShowTranslation(true);
            setTranslationText(text);
          }}
          existingHighlight={
            existingSelectionHighlight
              ? {
                  id: existingSelectionHighlight.id,
                  color: existingSelectionHighlight.color,
                  note: existingSelectionHighlight.note,
                }
              : null
          }
          defaultColor={readSettings.defaultHighlightColor ?? "yellow"}
          onRemoveHighlight={() => {
            const existing = highlights.find(
              (h) => h.bookId === bookId && h.cfi === selectionPopoverSelection.cfi,
            );
            if (existing) {
              removeHighlight(existing.id);
              bridge.removeAnnotation({ value: existing.cfi });
            }
          }}
        />
      )}

      {/* Note Tooltip (long-press on wavy underline) */}
      {adjustedNoteTooltip && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              suppressReaderTapUntilRef.current = Date.now() + 350;
              if (noteTooltipTimer.current) {
                clearTimeout(noteTooltipTimer.current);
                noteTooltipTimer.current = null;
              }
              setNoteTooltip(null);
            }}
          />
          <Pressable
            style={[
              s.noteTooltip,
              {
                left: Math.max(
                  NOTE_TOOLTIP_SIDE_PADDING,
                  Math.min(
                    adjustedNoteTooltip.position.x - NOTE_TOOLTIP_WIDTH / 2,
                    SCREEN_WIDTH - NOTE_TOOLTIP_WIDTH - NOTE_TOOLTIP_SIDE_PADDING,
                  ),
                ),
                ...(adjustedNoteTooltip.position.selectionTop > NOTE_TOOLTIP_TOP_THRESHOLD
                  ? {
                      bottom:
                        SCREEN_HEIGHT -
                        adjustedNoteTooltip.position.selectionTop +
                        NOTE_TOOLTIP_ABOVE_OFFSET,
                    }
                  : {
                      top: adjustedNoteTooltip.position.selectionBottom + NOTE_TOOLTIP_BELOW_OFFSET,
                    }),
              },
            ]}
            onPress={(event) => {
              event.stopPropagation();
              suppressReaderTapUntilRef.current = Date.now() + 550;
            }}
            onPressIn={(event) => {
              event.stopPropagation();
              suppressReaderTapUntilRef.current = Date.now() + 550;
            }}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
          >
            <View style={s.noteTooltipContent}>
              <MarkdownRenderer
                content={adjustedNoteTooltip.note || ""}
                styleOverrides={noteTooltipMdStyles}
              />
            </View>
          </Pressable>
        </View>
      )}

      {!showSearch && (
        <Animated.View
          pointerEvents={showControls ? "auto" : "none"}
          style={[
            s.floatingTools,
            {
              right: insets.right + 16,
              bottom: insets.bottom + 110,
              opacity: auxToolsOpacity,
              transform: [{ translateY: auxToolsTranslate }],
            },
          ]}
        >
          <TouchableOpacity
            style={[
              s.floatingToolBtn,
              (showChapterTranslation || chapterTranslation.state.status !== "idle") &&
                s.floatingToolBtnActive,
            ]}
            onPress={() => setShowChapterTranslation(true)}
          >
            <LanguagesIcon size={18} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              s.floatingToolBtn,
              (showTTS || ttsPlayState !== "stopped") && s.floatingToolBtnActive,
            ]}
            onPress={tts.handleToggleTTS}
          >
            <HeadphonesIcon size={20} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.floatingToolBtn}
            onPress={() => navigation.navigate("BookChat", { bookId })}
          >
            <BotIcon size={20} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      )}

      {!showSearch && !showControls && showBottomTimeBattery && (
        <View
          pointerEvents="none"
          style={[
            s.bottomInfoBar,
            {
              left: insets.left + 18,
              right: insets.right + 18,
              bottom: Math.max(insets.bottom, 8) + 4,
            },
          ]}
        >
          <Text style={s.bottomInfoText}>{readerClock}</Text>
          <View style={s.bottomInfoSide}>
            <BatteryIcon
              width={22}
              height={11}
              color={colors.mutedForeground}
              level={batteryLevel}
              charging={isBatteryCharging}
            />
            <Text style={s.bottomInfoText}>{batteryLabel}</Text>
          </View>
        </View>
      )}

      {/* ─── Bottom Toolbar ─── */}
      {!showSearch && (
        <Animated.View
          pointerEvents={showControls ? "auto" : "none"}
          style={[
            s.bottomToolbar,
            {
              left: 0,
              right: 0,
              opacity: bottomControlsOpacity,
              transform: [{ translateY: bottomControlsTranslate }],
            },
          ]}
        >
          <View
            style={[
              s.bottomToolbarGlass,
              {
                paddingBottom: Math.max(insets.bottom, 8) + 6,
                paddingLeft: insets.left + 18,
                paddingRight: insets.right + 18,
              },
            ]}
          >
            <ReadingProgressSlider
              progress={progress}
              onDragStart={() => suppressProgressTracking(99999)}
              onDragEnd={() => suppressProgressTracking(2000)}
              onSeek={(fraction) => {
                bridgeRef.current?.goToFraction(fraction);
              }}
              accentColor={colors.primary}
              trackColor={withOpacity(colors.foreground, 0.12)}
              textColor={withOpacity(colors.foreground, 0.6)}
            />
            <View style={s.bottomDockRow}>
              <TouchableOpacity
                style={s.bottomDockBtn}
                onPress={() => {
                  setTocActiveTab("toc");
                  setShowTOC(true);
                }}
              >
                <ListIcon size={bottomDockIconSize} color={colors.foreground} />
                <Text style={s.bottomDockLabel}>{t("reader.toc", "目录")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.bottomDockBtn, isBookmarked && s.bottomDockBtnActive]}
                onPress={handleToggleBookmark}
              >
                {isBookmarked ? (
                  <BookmarkFilledIcon size={bottomDockIconSize} color={colors.primary} />
                ) : (
                  <BookmarkIcon size={bottomDockIconSize} color={colors.foreground} />
                )}
                <Text style={[s.bottomDockLabel, isBookmarked && s.bottomDockLabelActive]}>
                  {t("reader.bookmarks", "书签")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.bottomDockBtn}
                onPress={() => navigation.navigate("FullScreenNotes", { bookId })}
              >
                <NotebookPenIcon size={bottomDockIconSize} color={colors.foreground} />
                <Text style={s.bottomDockLabel}>{t("notes.title", "笔记")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.bottomDockBtn}
                onPress={() => {
                  setShowSearch(true);
                  setShowControls(false);
                  Animated.timing(toolbarAnim, {
                    toValue: TOOLBAR_HIDE_OFFSET,
                    duration: 180,
                    easing: Easing.out(Easing.cubic),
                    useNativeDriver: true,
                  }).start();
                }}
              >
                <SearchIcon size={bottomDockIconSize} color={colors.foreground} />
                <Text style={s.bottomDockLabel}>{t("reader.search", "搜索")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.bottomDockBtn, autoScrollActive && s.bottomDockBtnActive]}
                onPress={() => {
                  bridgeRef.current?.setAutoScroll(!autoScrollActiveRef.current, autoScrollSpeedRef.current);
                }}
              >
                {autoScrollActive ? (
                  <PauseIcon size={bottomDockIconSize} color={colors.primary} />
                ) : (
                  <PlayIcon size={bottomDockIconSize} color={colors.foreground} />
                )}
                <Text style={[s.bottomDockLabel, autoScrollActive && s.bottomDockLabelActive]}>
                  {t("reader.autoScroll", "自动滚动")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.bottomDockBtn, speedReadActive && s.bottomDockBtnActive]}
                onPress={() => {
                  if (speedReadActiveRef.current) {
                    bridgeRef.current?.setSpeedRead(false);
                  } else {
                    bridgeRef.current?.setSpeedRead(true, speedReadWpm, speedReadChunk);
                  }
                }}
              >
                {speedReadActive ? (
                  <PauseIcon size={bottomDockIconSize} color={colors.primary} />
                ) : (
                  <SparklesIcon size={bottomDockIconSize} color={colors.foreground} />
                )}
                <Text style={[s.bottomDockLabel, speedReadActive && s.bottomDockLabelActive]}>
                  {t("reader.speedRead", "速读")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.bottomDockBtn, showPhase2 && s.bottomDockBtnActive]}
                onPress={() => setShowPhase2((v) => !v)}
              >
                <PaletteIcon size={bottomDockIconSize} color={showPhase2 ? colors.primary : colors.foreground} />
                <Text style={[s.bottomDockLabel, showPhase2 && s.bottomDockLabelActive]}>
                  {t("reader.display", "显示")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.bottomDockBtn} onPress={() => setShowSettings(true)}>
                <SettingsIcon size={bottomDockIconSize} color={colors.foreground} />
                <Text style={s.bottomDockLabel}>{t("common.settings", "设置")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      )}

      {/* ─── Auto-scroll mini bar (visible whenever active) ─── */}
      {autoScrollActive && (
        <View
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            bottom: Math.max(insets.bottom, 8) + 76,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 20,
            backgroundColor: withOpacity(colors.background, 0.92),
            borderWidth: 1,
            borderColor: withOpacity(colors.foreground, 0.12),
            gap: 12,
          }}
        >
          <TouchableOpacity
            onPress={() => {
              const speeds = [25, 50, 100];
              const idx = speeds.indexOf(autoScrollSpeed);
              const next = speeds[(idx + 1) % speeds.length];
              setAutoScrollSpeed(next);
              bridgeRef.current?.setAutoScroll(true, next);
            }}
          >
            <Text style={{ color: colors.primary, fontSize: 13, fontWeight: "700" }}>
              {autoScrollSpeed === 25
                ? t("reader.autoScrollSlow", "慢速")
                : autoScrollSpeed === 100
                  ? t("reader.autoScrollFast", "快速")
                  : t("reader.autoScrollNormal", "中速")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              const next = Math.max(10, autoScrollSpeed - 10);
              setAutoScrollSpeed(next);
              bridgeRef.current?.setAutoScroll(true, next);
            }}
          >
            <MinusIcon size={16} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => bridgeRef.current?.setAutoScroll(false)}>
            <PauseIcon size={20} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              const next = Math.min(200, autoScrollSpeed + 10);
              setAutoScrollSpeed(next);
              bridgeRef.current?.setAutoScroll(true, next);
            }}
          >
            <PlusIcon size={16} color={colors.foreground} />
          </TouchableOpacity>
        </View>
      )}
      {/* ─── Speed-read mini bar (visible whenever active) ─── */}
      {speedReadActive && (
        <View
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            bottom: Math.max(insets.bottom, 8) + 112,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 20,
            backgroundColor: withOpacity(colors.background, 0.92),
            borderWidth: 1,
            borderColor: withOpacity(colors.foreground, 0.12),
            gap: 10,
          }}
        >
          <TouchableOpacity
            onPress={() => {
              const next = Math.max(100, speedReadWpm - 50);
              setSpeedReadWpm(next);
              bridgeRef.current?.setSpeedRead(true, next, speedReadChunk);
            }}
          >
            <MinusIcon size={16} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: "700" }}>
            {speedReadWpm} WPM · {speedReadChunk} {t("reader.speedReadWords", "词")}
            {speedReadProgress ? ` · ${speedReadProgress.index + 1}/${speedReadProgress.total}` : ""}
          </Text>
          <TouchableOpacity
            onPress={() => {
              const next = Math.min(800, speedReadWpm + 50);
              setSpeedReadWpm(next);
              bridgeRef.current?.setSpeedRead(true, next, speedReadChunk);
            }}
          >
            <PlusIcon size={16} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => bridgeRef.current?.setSpeedRead(false)}>
            <PauseIcon size={16} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              const next = speedReadChunk >= 10 ? 1 : speedReadChunk + 1;
              setSpeedReadChunk(next);
              bridgeRef.current?.setSpeedRead(true, speedReadWpm, next);
            }}
          >
            <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "700" }}>
              {speedReadChunk}×
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {/* ─── Phase 2 display panel ─── */}
      {showPhase2 && (
        <View
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            bottom: Math.max(insets.bottom, 8) + 148,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 16,
            backgroundColor: withOpacity(colors.background, 0.94),
            borderWidth: 1,
            borderColor: withOpacity(colors.foreground, 0.12),
            gap: 10,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
              {t("reader.brightness", "亮度")} {brightness}%
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                onPress={() => {
                  const v = Math.max(20, brightness - 10);
                  setBrightness(v);
                  bridgeRef.current?.setBrightness(v);
                }}
              >
                <MinusIcon size={16} color={colors.foreground} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  const v = Math.min(100, brightness + 10);
                  setBrightness(v);
                  bridgeRef.current?.setBrightness(v);
                }}
              >
                <PlusIcon size={16} color={colors.foreground} />
              </TouchableOpacity>
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <TouchableOpacity
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 12,
                backgroundColor: eyeCare ? withOpacity(colors.primary, 0.18) : withOpacity(colors.foreground, 0.08),
              }}
              onPress={() => {
                const v = !eyeCare;
                setEyeCare(v);
                bridgeRef.current?.setEyeCare(v);
              }}
            >
              <Text style={{ color: eyeCare ? colors.primary : colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {t("reader.eyeCare", "护眼")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 12,
                backgroundColor: rulerOn ? withOpacity(colors.primary, 0.18) : withOpacity(colors.foreground, 0.08),
              }}
              onPress={() => {
                const v = !rulerOn;
                setRulerOn(v);
                bridgeRef.current?.setReadingRuler(v);
              }}
            >
              <Text style={{ color: rulerOn ? colors.primary : colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {t("reader.ruler", "尺子")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 12,
                backgroundColor: withOpacity(colors.foreground, 0.08),
              }}
              onPress={() => {
                const order = ["default", "sepia", "paper", "night"] as const;
                const idx = order.indexOf(bgPreset as any);
                const next = order[(idx + 1) % order.length];
                setBgPreset(next);
                bridgeRef.current?.setBackgroundPreset(next);
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {bgPreset === "default"
                  ? t("reader.bgDefault", "默认")
                  : bgPreset === "sepia"
                    ? "Sepia"
                    : bgPreset === "paper"
                      ? t("reader.bgPaper", "纸张")
                      : t("reader.bgNight", "夜间")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ─── Search Bar ─── */}
      {showSearch && (
        <View style={[s.searchBarWrap, { paddingTop: layoutTopInset }]}>
          <View style={s.searchBarRow}>
            <View style={s.searchInputWrap}>
              <SearchIcon size={16} color={colors.mutedForeground} />
              <TextInput
                style={s.searchInput}
                placeholder={t("reader.searchInBook", "在书中搜索")}
                placeholderTextColor={colors.mutedForeground}
                value={search.searchQuery}
                onChangeText={search.handleSearchInput}
                autoFocus
                returnKeyType="search"
              />
            </View>
            <TouchableOpacity
              style={{
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: search.matchCase
                  ? withOpacity(colors.primary, 0.2)
                  : "transparent",
              }}
              onPress={search.toggleMatchCase}
            >
              <Text
                style={{
                  color: search.matchCase ? colors.primary : colors.mutedForeground,
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                Aa
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: search.wholeWord
                  ? withOpacity(colors.primary, 0.2)
                  : "transparent",
              }}
              onPress={search.toggleWholeWord}
            >
              <Text
                style={{
                  color: search.wholeWord ? colors.primary : colors.mutedForeground,
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                {"ab|"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor:
                  search.direction !== "all" ? withOpacity(colors.primary, 0.2) : "transparent",
              }}
              onPress={search.cycleDirection}
            >
              <Text
                style={{
                  color: search.direction !== "all" ? colors.primary : colors.mutedForeground,
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                {search.direction === "forward"
                  ? "→"
                  : search.direction === "backward"
                    ? "←"
                    : "↕"}
              </Text>
            </TouchableOpacity>
            <View style={s.searchMetaRow}>
              {search.isSearching ? (
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              ) : search.searchQuery && search.searchResultCount > 0 ? (
                <Text style={s.searchCount}>
                  {search.searchIndex + 1} / {search.searchResultCount}
                </Text>
              ) : search.searchQuery && !search.isSearching ? (
                <Text style={s.searchCount}>0</Text>
              ) : null}
            </View>
            <TouchableOpacity
              style={s.searchNavBtn}
              onPress={() => search.navigateSearch("prev")}
              disabled={search.searchResultCount === 0}
            >
              <ChevronLeftIcon
                size={16}
                color={search.searchResultCount > 0 ? colors.foreground : colors.mutedForeground}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={s.searchNavBtn}
              onPress={() => search.navigateSearch("next")}
              disabled={search.searchResultCount === 0}
            >
              <ChevronRightIcon
                size={16}
                color={search.searchResultCount > 0 ? colors.foreground : colors.mutedForeground}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={s.searchNavBtn}
              onPress={() => {
                if (search.searchStartCfi && search.searchResultCount > 0) {
                  Alert.alert(
                    t("reader.searchComplete", "搜索完成"),
                    t("reader.returnToOriginal", "是否返回搜索前的位置？"),
                    [
                      {
                        text: t("common.cancel", "取消"),
                        style: "cancel",
                        onPress: () => {
                          search.setSearchStartCfi(null);
                        },
                      },
                      {
                        text: t("common.confirm", "确定"),
                        onPress: () => {
                          goToCFISafely(search.searchStartCfi!);
                          search.setSearchStartCfi(null);
                        },
                      },
                    ],
                  );
                } else {
                  search.setSearchStartCfi(null);
                }
                setShowSearch(false);
                search.clearSearch();
                setShowControls(true);
                Animated.timing(toolbarAnim, {
                  toValue: 0,
                  duration: 180,
                  easing: Easing.out(Easing.cubic),
                  useNativeDriver: true,
                }).start();
              }}
            >
              <XIcon size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          {search.cacheProgress != null && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 6,
                gap: 8,
              }}
            >
              <ActivityIndicator size="small" color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                {t("reader.searchIndexing", "正在建立搜索索引…")} {Math.round(search.cacheProgress * 100)}%
              </Text>
            </View>
          )}
          {search.searchResults.length > 0 && (
            <View style={{ maxHeight: 320 }}>
              <FlatList
                data={search.searchResults}
                keyExtractor={(_, i) => String(i)}
                initialNumToRender={20}
                maxToRenderPerBatch={20}
                windowSize={7}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item, index }) => (
                  <TouchableOpacity
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                      backgroundColor:
                        index === search.searchIndex
                          ? withOpacity(colors.primary, 0.12)
                          : "transparent",
                    }}
                    onPress={() => search.goToMatch(index)}
                  >
                    <Text
                      style={{ color: colors.mutedForeground, fontSize: 11, marginBottom: 2 }}
                      numberOfLines={1}
                    >
                      {index + 1} · {t("reader.searchChapter", "章节")} {item.sectionIndex + 1}
                    </Text>
                    <Text style={{ color: colors.foreground, fontSize: 13 }} numberOfLines={2}>
                      {item.excerpt.pre}
                      <Text style={{ color: colors.primary, fontWeight: "600" }}>
                        {item.excerpt.match}
                      </Text>
                      {item.excerpt.post}
                    </Text>
                  </TouchableOpacity>
                )}
              />
              {search.searchTruncated && (
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontSize: 11,
                    paddingHorizontal: 16,
                    paddingVertical: 4,
                  }}
                >
                  {t("reader.searchTruncated", "仅显示前 {{count}} 条结果", {
                    count: search.searchResults.length,
                  })}
                </Text>
              )}
            </View>
          )}
        </View>
      )}

      {/* ─── TOC & Bookmarks & Images Panel ─── */}
      <ReaderTOCPanel
        visible={showTOC}
        activeTab={tocActiveTab}
        toc={toc}
        bookmarks={bookBookmarks}
        currentChapter={currentChapter}
        images={imageItems}
        imageProgress={imageProgress}
        imageDataMap={imageDataMap}
        onClose={() => setShowTOC(false)}
        onTabChange={setTocActiveTab}
        onSelectTocItem={goToTocItem}
        onGoToBookmark={(cfi) => {
          goToCFISafely(cfi);
          setShowTOC(false);
        }}
        onDeleteBookmark={(id) => removeBookmark(id)}
        onOpenImages={openGalleryTab}
        onRequestImageThumb={requestGalleryThumb}
        onPreviewImage={openImageViewer}
        onGoToImage={goToGalleryImage}
      />

      {/* ─── Phase 7: fullscreen image viewer ─── */}
      {viewerIndex != null && imageItems[viewerIndex] ? (
        <ImageFullscreenViewer
          visible
          images={imageItems}
          index={viewerIndex}
          dataUrl={
            imageDataMap[
              `${imageItems[viewerIndex].sectionIndex}:${imageItems[viewerIndex].imgIndex}`
            ]
          }
          onClose={closeImageViewer}
          onPrev={() =>
            setViewerIndex((v) =>
              v == null ? v : (v - 1 + imageItems.length) % imageItems.length,
            )
          }
          onNext={() =>
            setViewerIndex((v) => (v == null ? v : (v + 1) % imageItems.length))
          }
          onGoToLocation={() => {
            const item = viewerIndex != null ? imageItems[viewerIndex] : null;
            if (item) goToGalleryImage(item.sectionIndex, item.imgIndex);
          }}
          onRequestFull={() => {
            const item = viewerIndex != null ? imageItems[viewerIndex] : null;
            if (item) {
              const key = `${item.sectionIndex}:${item.imgIndex}`;
              if (imageDataMap[key] || imageDataPendingRef.current.has(key)) return;
              if (imageDataPendingRef.current.size >= MAX_IMAGE_IN_FLIGHT) {
                enqueueImageRequest({
                  key,
                  sectionIndex: item.sectionIndex,
                  imgIndex: item.imgIndex,
                  maxDim: 1600,
                });
                return;
              }
              imageDataPendingRef.current.add(key);
              bridgeRef.current?.requestImageData(item.sectionIndex, item.imgIndex, 1600);
            }
          }}
        />
      ) : null}

      {/* ─── Settings Panel ─── */}
      <ReaderSettingsPanel
        visible={showSettings}
        readSettings={readSettings}
        bookId={bookId}
        onClose={() => setShowSettings(false)}
        onUpdateSetting={updateSetting}
        onRubyModeChange={async (mode) => {
          if (mode) {
            // Load dicts into WebView if not already done
            try {
              const { readDictStrings } = await import("@/lib/ruby/dict-service-mobile");
              const { wordDict, charDict } = await readDictStrings();
              if (wordDict || charDict) {
                bridge.setRubyDicts(wordDict, charDict);
                // Small delay to let WebView process the dict
                setTimeout(() => bridge.injectRuby(mode), 100);
              }
            } catch (err) {
              console.error("[ReaderScreen] Ruby dict load failed:", err);
            }
          } else {
            bridge.removeRuby();
          }
        }}
      />

      {/* ─── Notebook Panel ─── */}
      <Modal
        visible={showNotebook}
        transparent
        animationType="slide"
        onRequestClose={() => setShowNotebook(false)}
      >
        <Pressable style={s.modalBackdrop} onPress={() => setShowNotebook(false)} />
        <View
          style={[
            s.bottomSheet,
            { maxHeight: SCREEN_HEIGHT * 0.7, paddingBottom: insets.bottom || 16 },
          ]}
        >
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>{t("reader.notebook", "笔记本")}</Text>
            <TouchableOpacity onPress={() => setShowNotebook(false)}>
              <XIcon size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          {highlights.length > 0 ? (
            <ScrollView showsVerticalScrollIndicator={false} style={s.sheetScroll}>
              {highlights.map((h) => (
                <TouchableOpacity
                  key={h.id}
                  style={s.highlightItem}
                  activeOpacity={0.7}
                  onPress={() => {
                    // Tap note/highlight → jump straight to its CFI location.
                    setShowNotebook(false);
                    if (h.cfi) goToCFISafely(h.cfi);
                  }}
                >
                  <View
                    style={[
                      s.highlightColorDot,
                      {
                        backgroundColor:
                          h.color === "yellow"
                            ? "#facc15"
                            : h.color === "green"
                              ? "#4ade80"
                              : h.color === "blue"
                                ? "#60a5fa"
                                : h.color === "pink"
                                  ? "#ec4899"
                                  : h.color === "red"
                                    ? "#f87171"
                                    : "#a78bfa",
                      },
                    ]}
                  />
                  <View style={s.highlightContent}>
                    <Text style={s.highlightText} numberOfLines={3}>
                      {h.text}
                    </Text>
                    {h.note && <Text style={s.highlightNote}>{h.note}</Text>}
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            <View style={s.notebookPlaceholder}>
              <NotebookPenIcon size={40} color={colors.mutedForeground} />
              <Text style={s.notebookPlaceholderText}>
                {t("reader.notebookHint", "在阅读时选中文字来创建笔记和高亮")}
              </Text>
            </View>
          )}
        </View>
      </Modal>

      {/* ─── Note View Modal ─── */}
      <ReaderNoteViewModal
        highlight={noteViewHighlight}
        editing={noteViewEditing}
        editContent={noteViewContent}
        bookId={bookId}
        onClose={() => {
          setNoteViewHighlight(null);
          setNoteViewEditing(false);
        }}
        onStartEdit={() => {
          setNoteViewContent(noteViewHighlight?.note || "");
          setNoteViewEditing(true);
        }}
        onCancelEdit={() => {
          setNoteViewEditing(false);
          setNoteViewContent(noteViewHighlight?.note || "");
        }}
        onContentChange={setNoteViewContent}
        onSave={(highlight, newNote) => {
          bridge.removeAnnotation({ value: highlight.cfi });
          bridge.addAnnotation({
            value: highlight.cfi,
            type: "highlight",
            color: highlight.color,
            note: newNote,
          });
          setNoteViewHighlight({ ...highlight, note: newNote });
          setNoteViewEditing(false);
        }}
      />

      {/* ─── Translation Panel ─── */}
      {showTranslation && translationText && (
        <TranslationPanel
          text={translationText}
          onClose={() => {
            setShowTranslation(false);
            setTranslationText("");
          }}
        />
      )}

      {/* ─── Chapter Translation Sheet ─── */}
      <ChapterTranslationSheet
        visible={showChapterTranslation}
        onClose={() => setShowChapterTranslation(false)}
        state={chapterTranslation.state}
        onStart={chapterTranslation.startTranslation}
        onCancel={chapterTranslation.cancelTranslation}
        onToggleOriginalVisible={chapterTranslation.toggleOriginalVisible}
        onToggleTranslationVisible={chapterTranslation.toggleTranslationVisible}
        onReset={chapterTranslation.reset}
      />

      <TTSPage
        visible={showTTS}
        bookTitle={bookTitle || book?.meta.title || ""}
        chapterTitle={currentChapter}
        coverUri={tts.ttsCoverUri}
        playState={ttsPlayState}
        currentText={tts.currentTTSSegment?.text || tts.ttsLastText}
        config={ttsConfig}
        readingProgress={progress}
        currentPage={currentPage}
        totalPages={totalPages}
        sourceLabel={tts.ttsSourceLabel}
        continuousEnabled={tts.ttsContinuousEnabled}
        narrationSegments={tts.ttsDisplaySegments}
        prevNarrationSegments={tts.ttsPrevPageSegments}
        currentSegmentCfi={tts.resolvedTTSSegmentCfi}
        currentSegmentText={tts.currentTTSSegment?.text || null}
        currentChunkIndex={tts.localTTSChunkIndex}
        totalChunks={tts.ttsDisplaySegments.length}
        onClose={() => setShowTTS(false)}
        onReturnToReading={tts.handleTTSReturnToReading}
        onReplay={tts.handleTTSReplay}
        onPlayPause={tts.handleTTSPlayPause}
        onJumpToSegment={tts.handleJumpToTTSSegment}
        onJumpToLyricSegment={tts.handleJumpToTTSLyricSegment}
        onLoadMoreAbove={tts.handleLoadMoreAboveTTSLyrics}
        onLoadMoreBelow={tts.handleLoadMoreBelowTTSLyrics}
        onStop={tts.handleTTSStop}
        onAdjustRate={tts.handleAdjustTTSRate}
        onAdjustPitch={tts.handleAdjustTTSPitch}
        onToggleContinuous={tts.handleToggleTTSContinuous}
        onUpdateConfig={tts.handleUpdateTTSConfig}
        onPrevChapter={toc.length > 0 ? tts.handleTTSPrevChapter : undefined}
        onNextChapter={toc.length > 0 ? tts.handleTTSNextChapter : undefined}
      />
    </View>
  );
}
