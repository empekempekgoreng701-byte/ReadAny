import { useResolvedCoverUrl } from "@/hooks/use-resolved-cover-url";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import { SettingsHeader } from "@/screens/settings/SettingsHeader";
import { useLibraryStore } from "@/stores/library-store";
import { useSettingsStore } from "@/stores/settings-store";
import { fontSize, fontWeight, radius, spacing, useColors } from "@/styles/theme";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getBook } from "@readany/core/db/database";
import type { EpubPackageHandle } from "@readany/core/epub/book-package";
import { openEpubPackage } from "@readany/core/epub/book-package";
import { getPlatformService } from "@readany/core/services";
import {
  type BookQueueEvent,
  type BookTranslationTaskRecord,
  type ChapterSortOrder,
  type ChapterStatusFilter,
  type ChapterTranslationStatus,
  type OverviewChapterRef,
  buildReaderParamsForChapter,
  buildReaderParamsForContinue,
  buildReaderParamsForSearch,
  computeResumePending,
  createBookTranslationTask,
  deriveChapterStatuses,
  filterOverviewChapters,
  getTranslatedChapterTitles,
  listChapterFlagKeysForBook,
  loadBookTranslationTask,
  planBookTranslationScope,
  resolveEffectiveTranslationConfig,
  runBookTranslationQueue,
  saveBookTranslationTask,
  sectionIndexFromCfi,
  sortOverviewChapters,
  splitPlainTextToParagraphs,
} from "@readany/core/translation";
import type { Book } from "@readany/core/types";
import { decodeXmlEntitiesOnce, getBookProgressPercent } from "@readany/core/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Props = NativeStackScreenProps<RootStackParamList, "BookOverview">;

function formatBytes(size?: number): string {
  if (size == null || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
  const mb = kb / 1024;
  return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

function isLikelyRelativeAppPath(path: string): boolean {
  if (!path) return false;
  return !/^(\/|file:\/\/|content:\/\/|ph:\/\/|asset:\/\/|https?:\/\/)/i.test(path);
}

type ChapterLoadState =
  | { kind: "loading" }
  | { kind: "ready"; chapters: OverviewChapterRef[]; format: Book["format"] }
  | { kind: "error"; message: string; detail?: string };

const STATUS_META: Record<
  ChapterTranslationStatus,
  {
    key: string;
    fallback: string;
    colorKey: "primary" | "mutedForeground" | "destructive" | "amber" | "emerald";
  }
> = {
  TRANSLATED: { key: "overview.translated", fallback: "Translated", colorKey: "emerald" },
  NOT_TRANSLATED: {
    key: "overview.notTranslated",
    fallback: "Not translated",
    colorKey: "mutedForeground",
  },
  TRANSLATING: { key: "overview.translating", fallback: "Translating…", colorKey: "primary" },
  PARTIAL: { key: "overview.partial", fallback: "Partial", colorKey: "amber" },
  ERROR: { key: "overview.translationError", fallback: "Error", colorKey: "destructive" },
};

export function BookOverviewScreen({ route, navigation }: Props) {
  const { bookId } = route.params;
  const { t } = useTranslation();
  const colors = useColors();
  const layout = useResponsiveLayout();
  const isFocused = useIsFocused();

  const liveBook = useLibraryStore((s) => s.books.find((b) => b.id === bookId));
  const [dbBook, setDbBook] = useState<Book | null>(null);
  const book = liveBook ?? dbBook;

  const translationConfig = useSettingsStore((s) => s.translationConfig);
  const aiConfig = useSettingsStore((s) => s.aiConfig);

  const [chaptersState, setChaptersState] = useState<ChapterLoadState>({ kind: "loading" });
  const [statuses, setStatuses] = useState<Map<number, ChapterTranslationStatus>>(new Map());
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [task, setTask] = useState<BookTranslationTaskRecord | null>(null);
  const [activeSections, setActiveSections] = useState<Set<number>>(new Set());
  const [chapterProgress, setChapterProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [queueRunning, setQueueRunning] = useState(false);
  const [sortOrder, setSortOrder] = useState<ChapterSortOrder>("asc");
  const [statusFilter, setStatusFilter] = useState<ChapterStatusFilter>("all");

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (liveBook) {
      setDbBook(null);
      return;
    }
    let cancelled = false;
    getBook(bookId)
      .then((found) => {
        if (!cancelled && found) setDbBook(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookId, liveBook]);

  const coverUrl = useResolvedCoverUrl(book?.meta.coverUrl);

  const resolveAbsolutePath = useCallback(async (): Promise<string | null> => {
    if (!book?.filePath) return null;
    try {
      const platform = getPlatformService();
      if (isLikelyRelativeAppPath(book.filePath)) {
        const appData = await platform.getAppDataDir();
        return platform.joinPath(appData, book.filePath);
      }
      return book.filePath;
    } catch {
      return null;
    }
  }, [book?.filePath]);

  const loadChapters = useCallback(async () => {
    if (!book) return;
    setChaptersState({ kind: "loading" });
    try {
      // Single-entry fallback for formats without lightweight chapter
      // enumeration (no fake chapters, no full-book parse here).
      if (book.format !== "epub" && book.format !== "txt" && book.format !== "md") {
        setChaptersState({
          kind: "ready",
          chapters: [
            {
              sectionIndex: 0,
              href: "",
              title: decodeXmlEntitiesOnce(book.meta.title) || "Full book",
            },
          ],
          format: book.format,
        });
        return;
      }
      if (book.format === "txt" || book.format === "md") {
        setChaptersState({
          kind: "ready",
          chapters: [
            {
              sectionIndex: 0,
              href: "",
              title: decodeXmlEntitiesOnce(book.meta.title) || "Full text",
            },
          ],
          format: book.format,
        });
        return;
      }
      const absPath = await resolveAbsolutePath();
      if (!absPath) throw new Error("missing-file");
      const platform = getPlatformService();
      const bytes = await platform.readFile(absPath);
      const handle = await openEpubPackage(bytes);
      try {
        setChaptersState({
          kind: "ready",
          chapters: handle.chapters.map((c) => ({
            sectionIndex: c.sectionIndex,
            href: c.href,
            title: c.title,
            sizeBytes: c.sizeBytes,
          })),
          format: book.format,
        });
      } finally {
        await handle.close();
      }
    } catch (err) {
      // Never swallow the root cause: log technical diagnostics (no book
      // content, no personal data) so Android failures are actionable.
      const name = err instanceof Error ? err.name : typeof err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[BookOverview] chapter load failed: ${name}: ${message} ` +
          `(format=${book?.format ?? "unknown"})`,
      );
      if (mountedRef.current) {
        setChaptersState({ kind: "error", message: "load-failed", detail: message });
      }
    }
  }, [book, resolveAbsolutePath]);

  useEffect(() => {
    void loadChapters();
  }, [loadChapters]);

  const refreshStatuses = useCallback(async () => {
    if (!book || chaptersState.kind !== "ready") return;
    try {
      const platform = getPlatformService();
      const allKeys = await platform.kvGetAllKeys();
      // Read values only for this book's chapter flags (bounded by chapter
      // count, not library size).
      const flagValues = new Map<string, string>();
      for (const key of listChapterFlagKeysForBook(allKeys, book.id)) {
        const value = await platform.kvGetItem(key);
        if (value != null) flagValues.set(key, value);
      }
      const providerId = translationConfig.provider.id;
      const targetLang = translationConfig.targetLang;
      const derived = deriveChapterStatuses({
        chapters: chaptersState.chapters,
        bookId: book.id,
        targetLang,
        providerId,
        allKeys,
        flagValues,
        activeSections,
        failedSections: new Set(Object.keys(task?.failedSections ?? {}).map((s) => Number(s))),
      });
      if (mountedRef.current) setStatuses(derived);
      const [loadedTitles, loadedTask] = await Promise.all([
        getTranslatedChapterTitles(book.id, targetLang, providerId),
        loadBookTranslationTask(book.id),
      ]);
      if (mountedRef.current) {
        setTitles(loadedTitles);
        setTask(loadedTask);
        if (loadedTask && loadedTask.status === "running") {
          // A previous run died mid-flight (crash/kill): surface as paused so
          // resume recomputes from persisted done sections.
          const paused = { ...loadedTask, status: "paused" as const };
          setTask(paused);
          await saveBookTranslationTask(paused);
        }
      }
    } catch {
      // Status load is best-effort; the list stays usable without badges.
    }
  }, [
    book,
    chaptersState,
    translationConfig.provider.id,
    translationConfig.targetLang,
    activeSections,
    task?.failedSections,
  ]);

  useEffect(() => {
    if (isFocused) {
      void refreshStatuses();
    }
  }, [isFocused, refreshStatuses]);

  const lastReadSection = useMemo(() => sectionIndexFromCfi(book?.currentCfi), [book?.currentCfi]);

  const visibleChapters = useMemo(() => {
    if (chaptersState.kind !== "ready") return [];
    return filterOverviewChapters(
      sortOverviewChapters(chaptersState.chapters, sortOrder),
      statuses,
      statusFilter,
    );
  }, [chaptersState, sortOrder, statuses, statusFilter]);

  const translatedCount = useMemo(() => {
    if (chaptersState.kind !== "ready") return 0;
    return chaptersState.chapters.filter((c) => statuses.get(c.sectionIndex) === "TRANSLATED")
      .length;
  }, [chaptersState, statuses]);

  const openChapter = useCallback(
    (chapter: OverviewChapterRef) => {
      if (chapter.href) {
        navigation.navigate("Reader", buildReaderParamsForChapter(bookId, chapter));
      } else {
        navigation.navigate("Reader", buildReaderParamsForContinue(bookId, undefined));
      }
    },
    [bookId, navigation],
  );

  const openContinue = useCallback(() => {
    navigation.navigate("Reader", buildReaderParamsForContinue(bookId, book?.currentCfi));
  }, [bookId, book?.currentCfi, navigation]);

  const openSearch = useCallback(() => {
    navigation.navigate("Reader", buildReaderParamsForSearch(bookId));
  }, [bookId, navigation]);

  const handleQueueEvent = useCallback((event: BookQueueEvent) => {
    if (!mountedRef.current) return;
    switch (event.type) {
      case "chapter-start":
        setActiveSections((prev) => new Set(prev).add(event.sectionIndex));
        break;
      case "chapter-done":
      case "chapter-failed":
        setActiveSections((prev) => {
          const next = new Set(prev);
          next.delete(event.sectionIndex);
          return next;
        });
        break;
      case "task-progress":
        setChapterProgress({ done: event.done, total: event.total });
        break;
      case "task-done":
      case "task-aborted":
        setActiveSections(new Set());
        setChapterProgress(null);
        break;
      default:
        break;
    }
  }, []);

  const startTranslation = useCallback(async () => {
    if (!book || chaptersState.kind !== "ready" || queueRunning) return;
    const effective = resolveEffectiveTranslationConfig(translationConfig, aiConfig);
    // Fail fast with guidance instead of marking every chapter as failed when
    // the AI provider has no configured endpoint with an API key.
    if (effective.provider.id === "ai") {
      const endpointId = effective.provider.endpointId || aiConfig.activeEndpointId;
      const hasEndpoint = aiConfig.endpoints.some((e) => e.id === endpointId && e.apiKey);
      if (!hasEndpoint) {
        Alert.alert(
          t("overview.noAiEndpointTitle", "AI endpoint not configured"),
          t(
            "overview.noAiEndpointDesc",
            "Add an AI endpoint with an API key in Settings before translating.",
          ),
          [
            { text: t("common.cancel", "Cancel"), style: "cancel" },
            {
              text: t("overview.openSettings", "Open Settings"),
              onPress: () => navigation.navigate("AISettings"),
            },
          ],
        );
        return;
      }
    }
    const targetLang = effective.targetLang;
    const providerId = effective.provider.id;
    const chapters = planBookTranslationScope(chaptersState.chapters, { mode: "all" });
    const controller = new AbortController();
    abortRef.current = controller;
    setQueueRunning(true);
    setChapterProgress({ done: 0, total: chapters.length });
    let pkg: EpubPackageHandle | null = null;
    let fileBytes: Uint8Array | null = null;
    try {
      const isEpub = book.format === "epub";
      const isText = book.format === "txt" || book.format === "md";
      if (isEpub) {
        const absPath = await resolveAbsolutePath();
        if (!absPath) throw new Error("missing-file");
        fileBytes = await getPlatformService().readFile(absPath);
        pkg = await openEpubPackage(fileBytes);
      }
      const extractChapterParagraphs = async (chapter: OverviewChapterRef) => {
        if (isEpub) {
          if (!pkg) throw new Error("package-closed");
          const xhtml = await pkg.readSectionXhtml(chapter.href);
          if (!xhtml) throw new Error("empty-chapter");
          const { extractParagraphsFromXhtml } = await import("@readany/core/epub/book-package");
          return extractParagraphsFromXhtml(xhtml);
        }
        if (isText) {
          if (!fileBytes) {
            const absPath = await resolveAbsolutePath();
            if (!absPath) throw new Error("missing-file");
            fileBytes = await getPlatformService().readFile(absPath);
          }
          return splitPlainTextToParagraphs(new TextDecoder().decode(fileBytes));
        }
        throw new Error("unsupported-format");
      };
      const finished = await runBookTranslationQueue({
        bookId: book.id,
        chapters,
        targetLang,
        providerId,
        config: effective,
        resumeTask: task,
        signal: controller.signal,
        deps: {
          extractChapterParagraphs,
          translateTitle: async (title: string) => {
            const { translate } = await import("@readany/core/translation");
            const result = await translate(title, {
              provider: {
                id: effective.provider.id,
                apiKey: effective.provider.apiKey,
                baseUrl: effective.provider.baseUrl,
              },
              targetLang,
              model: effective.provider.model,
            });
            return result.translatedText;
          },
          onEvent: handleQueueEvent,
        },
      });
      if (mountedRef.current) {
        setTask(finished);
        // Titles may have been stored during the run — reload them.
        const reloaded = await getTranslatedChapterTitles(book.id, targetLang, providerId);
        if (mountedRef.current) setTitles(reloaded);
      }
    } catch (err) {
      if (mountedRef.current && (err as Error)?.name !== "AbortError") {
        const failed = createBookTranslationTask({
          bookId: book.id,
          targetLang,
          providerId,
          sourceLang: "AUTO",
          totalChapters: chapters.length,
        });
        failed.status = "error";
        setTask(failed);
        await saveBookTranslationTask(failed);
      }
    } finally {
      if (pkg) {
        await pkg.close().catch(() => {});
        pkg = null;
      }
      fileBytes = null;
      abortRef.current = null;
      if (mountedRef.current) {
        setQueueRunning(false);
        setActiveSections(new Set());
        setChapterProgress(null);
        await refreshStatuses();
      }
    }
  }, [
    book,
    chaptersState,
    queueRunning,
    translationConfig,
    aiConfig,
    task,
    resolveAbsolutePath,
    handleQueueEvent,
    refreshStatuses,
    navigation,
    t,
  ]);

  const pauseTranslation = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  if (!book) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <SettingsHeader title={t("overview.title", "Book Overview")} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const title = decodeXmlEntitiesOnce(book.meta.title);
  const author = book.meta.author ? decodeXmlEntitiesOnce(book.meta.author) : "";
  const progressPct = Math.round(getBookProgressPercent(book.progress));
  const totalChapters = chaptersState.kind === "ready" ? chaptersState.chapters.length : 0;
  const runningTask = task?.status === "running" || queueRunning;
  const pendingCount =
    chaptersState.kind === "ready"
      ? computeResumePendingCount(chaptersState.chapters, task, statuses)
      : 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <SettingsHeader title={title} subtitle={author || undefined} />
      <FlatList
        data={visibleChapters}
        keyExtractor={(item) => `${item.sectionIndex}:${item.href}`}
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={7}
        removeClippedSubviews
        contentContainerStyle={{
          maxWidth: layout.centeredContentWidth,
          width: "100%",
          alignSelf: "center",
        }}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: spacing.lg }}>
            <View style={{ flexDirection: "row", marginTop: spacing.md }}>
              {coverUrl ? (
                <Image
                  source={{ uri: coverUrl }}
                  style={{
                    width: 96,
                    height: 144,
                    borderRadius: radius.md,
                    backgroundColor: colors.muted,
                  }}
                  resizeMode="cover"
                />
              ) : (
                <View
                  style={{
                    width: 96,
                    height: 144,
                    borderRadius: radius.md,
                    backgroundColor: colors.muted,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: colors.mutedForeground, fontSize: fontSize.xs }}>
                    {t("overview.noCover", "No cover")}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1, marginLeft: spacing.md, justifyContent: "center" }}>
                <Text style={{ color: colors.mutedForeground, fontSize: fontSize.sm }}>
                  {t("overview.readProgress", "{{pct}}% read", { pct: progressPct })}
                </Text>
                <Text
                  style={{ color: colors.mutedForeground, fontSize: fontSize.sm, marginTop: 4 }}
                >
                  {t("overview.chapterCount", "{{translated}} / {{total}} chapters translated", {
                    translated: translatedCount,
                    total: totalChapters,
                  })}
                </Text>
                {chapterProgress ? (
                  <Text style={{ color: colors.primary, fontSize: fontSize.sm, marginTop: 4 }}>
                    {t("overview.translationProgress", "{{done}} / {{total}}", {
                      done: chapterProgress.done,
                      total: chapterProgress.total,
                    })}
                  </Text>
                ) : null}
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: 8, marginTop: spacing.md }}>
              <TouchableOpacity
                onPress={openContinue}
                activeOpacity={0.8}
                style={{
                  flex: 1,
                  backgroundColor: colors.primary,
                  borderRadius: radius.md,
                  paddingVertical: 12,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: colors.primaryForeground, fontWeight: fontWeight.semibold }}>
                  {book.progress > 0
                    ? t("overview.continueReading", "Continue Reading")
                    : t("overview.startReading", "Start Reading")}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <TouchableOpacity
                onPress={runningTask ? pauseTranslation : startTranslation}
                disabled={
                  chaptersState.kind !== "ready" ||
                  (!runningTask &&
                    pendingCount === 0 &&
                    (task?.status === "complete" || task?.status === "error"))
                }
                activeOpacity={0.8}
                style={{
                  flex: 1,
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: radius.md,
                  paddingVertical: 10,
                  alignItems: "center",
                  opacity: chaptersState.kind !== "ready" ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.foreground, fontWeight: fontWeight.medium }}>
                  {runningTask
                    ? t("overview.pauseTranslation", "Pause")
                    : task &&
                        (task.status === "paused" || task.status === "error") &&
                        pendingCount > 0
                      ? t("overview.resumeTranslation", "Resume")
                      : t("overview.translateBook", "Translate")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={openSearch}
                activeOpacity={0.8}
                style={{
                  flex: 1,
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: radius.md,
                  paddingVertical: 10,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: colors.foreground, fontWeight: fontWeight.medium }}>
                  {t("overview.searchBook", "Search")}
                </Text>
              </TouchableOpacity>
            </View>

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: spacing.lg,
                marginBottom: 8,
              }}
            >
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: fontSize.md,
                  fontWeight: fontWeight.semibold,
                }}
              >
                {t("overview.chapters", "Chapters")}
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <TouchableOpacity
                  onPress={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
                  hitSlop={8}
                >
                  <Text style={{ color: colors.primary, fontSize: fontSize.sm }}>
                    {sortOrder === "asc"
                      ? t("overview.sortAsc", "1 → 9")
                      : t("overview.sortDesc", "9 → 1")}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    setStatusFilter((f) =>
                      f === "all" ? "translated" : f === "translated" ? "not_translated" : "all",
                    )
                  }
                  hitSlop={8}
                >
                  <Text style={{ color: colors.primary, fontSize: fontSize.sm }}>
                    {statusFilter === "all"
                      ? t("overview.filterAll", "All")
                      : statusFilter === "translated"
                        ? t("overview.filterTranslated", "Translated")
                        : t("overview.filterUntranslated", "Untranslated")}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        }
        renderItem={({ item }) => {
          const status = statuses.get(item.sectionIndex) ?? "NOT_TRANSLATED";
          const meta = STATUS_META[status];
          const badgeColor = colors[meta.colorKey];
          const displayTitle = titles[item.sectionIndex] ?? item.title;
          return (
            <TouchableOpacity
              onPress={() => openChapter(item)}
              activeOpacity={0.7}
              style={{
                paddingHorizontal: spacing.lg,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontSize: fontSize.sm,
                    width: 40,
                  }}
                >
                  {String(item.sectionIndex + 1).padStart(2, "0")}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text
                    style={{ color: colors.foreground, fontSize: fontSize.sm }}
                    numberOfLines={2}
                  >
                    {displayTitle}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2 }}>
                    <Text style={{ color: badgeColor, fontSize: fontSize.xs }}>
                      {status === "TRANSLATED" ? "✓ " : ""}
                      {t(meta.key, meta.fallback)}
                    </Text>
                    {item.sizeBytes != null ? (
                      <Text style={{ color: colors.mutedForeground, fontSize: fontSize.xs }}>
                        {"  ·  "}
                        {formatBytes(item.sizeBytes)}
                      </Text>
                    ) : null}
                    {lastReadSection === item.sectionIndex ? (
                      <Text style={{ color: colors.primary, fontSize: fontSize.xs }}>
                        {"  ·  "}
                        {t("overview.lastRead", "Last Read")}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          chaptersState.kind === "loading" ? (
            <View style={{ padding: 32, alignItems: "center" }}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : chaptersState.kind === "error" ? (
            <View style={{ padding: 32, alignItems: "center" }}>
              <Text style={{ color: colors.mutedForeground, marginBottom: 12 }}>
                {t("overview.loadFailed", "Failed to load chapters")}
              </Text>
              {typeof __DEV__ !== "undefined" && __DEV__ && chaptersState.detail ? (
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontSize: fontSize.xs,
                    marginBottom: 12,
                    opacity: 0.7,
                  }}
                >
                  {chaptersState.detail}
                </Text>
              ) : null}
              <TouchableOpacity onPress={() => void loadChapters()} hitSlop={8}>
                <Text style={{ color: colors.primary }}>{t("overview.retry", "Retry")}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ padding: 32, alignItems: "center" }}>
              <Text style={{ color: colors.mutedForeground }}>
                {t("overview.noChapters", "No chapters found")}
              </Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

function computeResumePendingCount(
  chapters: OverviewChapterRef[],
  task: BookTranslationTaskRecord | null,
  statuses: Map<number, ChapterTranslationStatus>,
): number {
  return computeResumePending(chapters, task, (section) => statuses.get(section) === "TRANSLATED")
    .length;
}

// Re-exported for tests that assert overview behavior contracts.
export { computeResumePendingCount };
