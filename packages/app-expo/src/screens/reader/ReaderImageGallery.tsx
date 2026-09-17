/**
 * ReaderImageGallery — Phase 7: grid thumbnail + fullscreen viewer.
 *
 * Data gambar datang dari WebView sebagai dataURL (blob URL tidak bisa
 * dibaca RN Image). Thumbnail di-load malas per item; fullscreen me-request
 * resolusi penuh. Tap thumbnail = preview; tombol lokasi = lompat ke CFI.
 */
import { ChevronLeftIcon, ChevronRightIcon, XIcon, ZoomIn } from "@/components/ui/Icon";
import { fontSize, useColors } from "@/styles/theme";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type ViewToken,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GalleryImage } from "./ReaderTOCPanel";
import { makeStyles } from "./reader-styles";

/** Stable image key: prefers CFI locator, falls back to section/index/alt. */
export function imageStableKey(item: {
  sectionIndex: number;
  imgIndex: number;
  cfi?: string | null;
  alt?: string;
}): string {
  if (item.cfi) return `cfi:${item.cfi}`;
  const alt = (item.alt || "").trim().slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `sec:${item.sectionIndex}:idx:${item.imgIndex}${alt ? `:alt:${alt}` : ""}`;
}

function GalleryThumb({
  item,
  index,
  dataUrl,
  onPreview,
  onGoToImage,
}: {
  item: GalleryImage;
  index: number;
  dataUrl?: string;
  onPreview: (index: number) => void;
  onGoToImage: (sectionIndex: number, imgIndex: number) => void;
}) {
  const colors = useColors();
  const { t } = useTranslation();

  return (
    <View style={{ width: "32%", aspectRatio: 0.72, marginBottom: 8 }}>
      <TouchableOpacity
        style={{
          flex: 1,
          borderRadius: 8,
          overflow: "hidden",
          backgroundColor: colors.muted,
        }}
        activeOpacity={0.75}
        onPress={() => onGoToImage(item.sectionIndex, item.imgIndex)}
        onLongPress={() => onPreview(index)}
        delayLongPress={400}
      >
        {dataUrl ? (
          <Image source={{ uri: dataUrl }} style={{ flex: 1 }} resizeMode="cover" />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          </View>
        )}
      </TouchableOpacity>
      <Text
        style={{ fontSize: fontSize.xs, color: colors.mutedForeground, marginTop: 2 }}
        numberOfLines={1}
      >
        {item.alt || t("reader.imageNo", { n: index + 1, defaultValue: `Image ${index + 1}` })}
      </Text>
    </View>
  );
}

export function ImageGalleryGrid({
  images,
  imageProgress,
  imageDataMap,
  onRequestThumb,
  onPreview,
  onGoToImage,
}: {
  images: GalleryImage[];
  imageProgress: number | null;
  imageDataMap: Record<string, string>;
  onRequestThumb: (sectionIndex: number, imgIndex: number) => void;
  onPreview: (index: number) => void;
  onGoToImage: (sectionIndex: number, imgIndex: number) => void;
}) {
  const colors = useColors();
  const s = makeStyles(colors);
  const { t } = useTranslation();

  if (imageProgress != null) {
    return (
      <View style={s.notebookPlaceholder}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={s.notebookPlaceholderText}>
          {t("reader.imagesIndexing", {
            pct: Math.round(imageProgress * 100),
            defaultValue: `Collecting images... ${Math.round(imageProgress * 100)}%`,
          })}
        </Text>
      </View>
    );
  }

  if (images.length === 0) {
    return (
      <View style={s.notebookPlaceholder}>
        <Text style={s.notebookPlaceholderText}>{t("reader.noImages", "No images in this book")}</Text>
        <Text style={[s.notebookPlaceholderText, { fontSize: fontSize.xs, opacity: 0.6 }]}>
          {t("reader.noImagesHint", "Tap an image in the text to view fullscreen")}
        </Text>
      </View>
    );
  }

  // Phase 11 §4: virtualized grid — only visible/near-visible thumbs load.
  // NOTE: must NOT be frozen via useRef().current — that pins the first-render
  // `images`/`onRequestThumb` closure forever, so thumbs skipped (or requested
  // with stale data) never recover when the gallery finishes loading.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      for (const v of viewableItems) {
        const idx = v.index;
        if (idx == null || idx < 0 || idx >= images.length) continue;
        const item = images[idx];
        if (!item) continue;
        onRequestThumb(item.sectionIndex, item.imgIndex);
      }
    },
    [images, onRequestThumb],
  );
  const renderThumb = useCallback(
    ({ item, index }: { item: GalleryImage; index: number }) => (
      <GalleryThumb
        item={item}
        index={index}
        dataUrl={imageDataMap[imageStableKey(item)] ?? imageDataMap[`${item.sectionIndex}:${item.imgIndex}`]}
        onPreview={onPreview}
        onGoToImage={onGoToImage}
      />
    ),
    [imageDataMap, onPreview, onGoToImage],
  );

  return (
    <View style={s.sheetScroll}>
      <Text
        style={{
          fontSize: fontSize.xs,
          color: colors.mutedForeground,
          marginBottom: 8,
          opacity: 0.75,
        }}
      >
        {t("reader.imagesHint", {
          count: images.length,
          defaultValue: `${images.length} images · Tap to go to location, long-press to preview`,
        })}
      </Text>
      <FlatList
        data={images}
        renderItem={renderThumb}
        keyExtractor={(item) => imageStableKey(item)}
        numColumns={3}
        columnWrapperStyle={{ justifyContent: "space-between" }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        updateCellsBatchingPeriod={80}
        removeClippedSubviews
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
      />
    </View>
  );
}

export function ImageFullscreenViewer({
  visible,
  images,
  index,
  dataUrl,
  onClose,
  onPrev,
  onNext,
  onGoToLocation,
  onRequestFull,
}: {
  visible: boolean;
  images: GalleryImage[];
  index: number;
  dataUrl?: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onGoToLocation: () => void;
  onRequestFull: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const item = index >= 0 && index < images.length ? images[index] : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: request sekali per buka viewer
  useEffect(() => {
    if (visible && item && !dataUrl) {
      onRequestFull();
    }
  }, [visible, index]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.95)" }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 12,
            paddingTop: Math.max(insets.top, 8) + 4,
            paddingBottom: 8,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 13 }}>
            {item ? `${index + 1} / ${images.length}${item.alt ? ` · ${item.alt}` : ""}` : ""}
          </Text>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <XIcon size={22} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          {dataUrl ? (
            <ScrollView
              style={{ flex: 1, width: "100%" }}
              contentContainerStyle={{
                flexGrow: 1,
                alignItems: "center",
                justifyContent: "center",
              }}
              maximumZoomScale={4}
              minimumZoomScale={1}
              pinchGestureEnabled
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
            >
              <Image
                source={{ uri: dataUrl }}
                style={{ width: "100%", aspectRatio: 0.72 }}
                resizeMode="contain"
              />
            </ScrollView>
          ) : (
            <ActivityIndicator size="large" color="#fff" />
          )}
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 20,
            paddingBottom: Math.max(insets.bottom, 12) + 8,
          }}
        >
          <TouchableOpacity onPress={onPrev} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <ChevronLeftIcon size={26} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={{
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 20,
              backgroundColor: "rgba(255,255,255,0.16)",
            }}
            onPress={onGoToLocation}
          >
            <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
              {t("reader.goToImageLocation", "Go to location")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onNext} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <ChevronRightIcon size={26} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={{ position: "absolute", right: 16, top: "45%" }}>
          <TouchableOpacity onPress={onRequestFull}>
            <ZoomIn size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
