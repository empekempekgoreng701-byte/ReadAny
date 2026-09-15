/**
 * useReaderSearch — handles in-book search state, debouncing, and navigation.
 */
import { useCallback, useRef, useState } from "react";

export interface SearchMatch {
  sectionIndex: number;
  blockIndex: number;
  blockOffset: number;
  excerpt: { pre: string; match: string; post: string };
}

export type SearchDirection = "all" | "forward" | "backward";

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  direction: SearchDirection;
}

export interface ReaderSearchBridge {
  search?: (query: string, opts?: SearchOptions) => void;
  clearSearch?: () => void;
  navigateSearch?: (index: number) => void;
  goToSearchMatch?: (sectionIndex: number, blockIndex: number, blockOffset: number) => void;
  ensureBookTextCache?: () => void;
  goToCFI?: (cfi: string) => void;
}

export interface UseReaderSearchOptions {
  currentCfi: string;
  bridge: ReaderSearchBridge;
}

export interface UseReaderSearchResult {
  searchQuery: string;
  searchResultCount: number;
  searchIndex: number;
  isSearching: boolean;
  searchResults: SearchMatch[];
  searchTruncated: boolean;
  cacheProgress: number | null;
  matchCase: boolean;
  wholeWord: boolean;
  direction: SearchDirection;
  toggleMatchCase: () => void;
  toggleWholeWord: () => void;
  cycleDirection: () => void;
  searchStartCfi: string | null;
  setSearchStartCfi: (cfi: string | null) => void;
  handleSearchInput: (query: string) => void;
  navigateSearch: (direction: "prev" | "next") => void;
  goToMatch: (matchIndex: number) => void;
  ensureCache: () => void;
  clearSearch: () => void;
  onSearchResult: (index: number, count: number) => void;
  onSearchComplete: (count: number) => void;
  onSearchResultsList: (detail: {
    results: SearchMatch[];
    totalCount: number;
    truncated: boolean;
  }) => void;
  onSearchCacheProgress: (progress: number) => void;
}

export function useReaderSearch({
  currentCfi,
  bridge,
}: UseReaderSearchOptions): UseReaderSearchResult {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResultCount, setSearchResultCount] = useState(0);
  const [searchIndex, setSearchIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [cacheProgress, setCacheProgress] = useState<number | null>(null);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [direction, setDirection] = useState<SearchDirection>("all");
  const [searchStartCfi, setSearchStartCfi] = useState<string | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchOptsRef = useRef<SearchOptions>({ matchCase: false, wholeWord: false, direction: "all" });
  searchOptsRef.current = { matchCase, wholeWord, direction };
  const searchQueryRef = useRef("");
  searchQueryRef.current = searchQuery;

  const runSearch = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (trimmed) {
        setIsSearching(true);
        bridge.search?.(trimmed, { ...searchOptsRef.current });
      } else {
        setSearchResultCount(0);
        setSearchIndex(0);
        setSearchResults([]);
        bridge.clearSearch?.();
      }
    },
    [bridge],
  );

  const handleSearchInput = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => {
        if (query.trim()) {
          if (!searchStartCfi && currentCfi) {
            setSearchStartCfi(currentCfi);
          }
        }
        runSearch(query);
      }, 300);
    },
    [searchStartCfi, currentCfi, runSearch],
  );

  const toggleMatchCase = useCallback(() => {
    setMatchCase((v) => {
      const next = !v;
      searchOptsRef.current = { ...searchOptsRef.current, matchCase: next };
      return next;
    });
    // Re-run current query with new options after state commits
    setTimeout(() => runSearch(searchQueryRef.current), 0);
  }, [runSearch]);

  const toggleWholeWord = useCallback(() => {
    setWholeWord((v) => {
      const next = !v;
      searchOptsRef.current = { ...searchOptsRef.current, wholeWord: next };
      return next;
    });
    setTimeout(() => runSearch(searchQueryRef.current), 0);
  }, [runSearch]);

  const cycleDirection = useCallback(() => {
    setDirection((v) => {
      const next: SearchDirection = v === "all" ? "forward" : v === "forward" ? "backward" : "all";
      searchOptsRef.current = { ...searchOptsRef.current, direction: next };
      return next;
    });
    setTimeout(() => runSearch(searchQueryRef.current), 0);
  }, [runSearch]);

  const navigateSearch = useCallback(
    (direction: "prev" | "next") => {
      if (searchResults.length === 0) return;
      const newIdx =
        direction === "next"
          ? (searchIndex + 1) % searchResults.length
          : (searchIndex - 1 + searchResults.length) % searchResults.length;
      setSearchIndex(newIdx);
      const m = searchResults[newIdx];
      if (m) bridge.goToSearchMatch?.(m.sectionIndex, m.blockIndex, m.blockOffset);
    },
    [searchIndex, searchResults, bridge],
  );

  // Jump directly to one match from the results list
  const goToMatch = useCallback(
    (matchIndex: number) => {
      const m = searchResults[matchIndex];
      if (!m) return;
      setSearchIndex(matchIndex);
      bridge.goToSearchMatch?.(m.sectionIndex, m.blockIndex, m.blockOffset);
    },
    [searchResults, bridge],
  );

  const ensureCache = useCallback(() => {
    bridge.ensureBookTextCache?.();
  }, [bridge]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResultCount(0);
    setSearchIndex(0);
    setIsSearching(false);
    setSearchResults([]);
    setSearchTruncated(false);
    setCacheProgress(null);
    bridge.clearSearch?.();
  }, [bridge]);

  // Bridge callbacks for onSearchResult / onSearchComplete
  const onSearchResult = useCallback((index: number, count: number) => {
    setSearchIndex(index);
    setSearchResultCount(count);
  }, []);

  const onSearchComplete = useCallback((count: number) => {
    setSearchResultCount(count);
    setIsSearching(false);
  }, []);

  const onSearchResultsList = useCallback(
    (detail: { results: SearchMatch[]; totalCount: number; truncated: boolean }) => {
      setSearchResults(detail.results);
      setSearchResultCount(detail.totalCount);
      setSearchTruncated(detail.truncated);
      setSearchIndex(0);
      setCacheProgress(null);
    },
    [],
  );

  const onSearchCacheProgress = useCallback((progress: number) => {
    setCacheProgress(progress >= 1 ? null : progress);
  }, []);

  return {
    searchQuery,
    searchResultCount,
    searchIndex,
    isSearching,
    searchResults,
    searchTruncated,
    cacheProgress,
    matchCase,
    wholeWord,
    direction,
    toggleMatchCase,
    toggleWholeWord,
    cycleDirection,
    searchStartCfi,
    setSearchStartCfi,
    handleSearchInput,
    navigateSearch,
    goToMatch,
    ensureCache,
    clearSearch,
    onSearchResult,
    onSearchComplete,
    onSearchResultsList,
    onSearchCacheProgress,
  };
}
