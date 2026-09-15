const { getAppVariantConfig } = require("./scripts/app-variant");

const variant = getAppVariantConfig();

module.exports = {
  expo: {
    name: variant.name,
    slug: "readany",
    version: "1.3.6",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#05042B",
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: variant.bundleIdentifier,
      buildNumber: "2",
      infoPlist: {
        UIBackgroundModes: ["audio"],
        NSCameraUsageDescription:
          "ReadAny uses the camera to scan sync and configuration QR codes.",
        NSLocalNetworkUsageDescription:
          "ReadAny uses the local network to connect to sync devices and the development server while debugging.",
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#05042B",
      },
      softwareKeyboardLayoutMode: "resize",
      package: variant.androidPackage,
      permissions: [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
        "android.permission.MODIFY_AUDIO_SETTINGS",
      ],
      // Phase 10.1 + 10.2: open ebook files from File Manager / other apps.
      // Only formats the reader provably opens (verified in foliate view.js
      // makeBook + Phase 9 converters): EPUB, PDF, MOBI/AZW, CBZ, FB2/FBZ,
      // TXT, DOCX, HTML, MD. CBR/DJVU/CHM are NOT registered.
      intentFilters: [
        {
          action: "VIEW",
          category: ["DEFAULT"],
          data: [
            { scheme: "content", mimeType: "application/epub+zip" },
            { scheme: "content", mimeType: "application/pdf" },
            { scheme: "content", mimeType: "application/x-mobipocket-ebook" },
            { scheme: "content", mimeType: "application/vnd.amazon.ebook" },
            { scheme: "content", mimeType: "application/vnd.comicbook+zip" },
            { scheme: "content", mimeType: "application/x-fictionbook+xml" },
            { scheme: "content", mimeType: "application/x-zip-compressed-fb2" },
            { scheme: "content", mimeType: "text/plain" },
            { scheme: "content", mimeType: "text/html" },
            { scheme: "content", mimeType: "text/markdown" },
            {
              scheme: "content",
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
            { scheme: "file", mimeType: "application/epub+zip" },
            { scheme: "file", mimeType: "application/pdf" },
            { scheme: "file", mimeType: "application/x-mobipocket-ebook" },
            { scheme: "file", mimeType: "application/vnd.amazon.ebook" },
            { scheme: "file", mimeType: "application/vnd.comicbook+zip" },
            { scheme: "file", mimeType: "application/x-fictionbook+xml" },
            { scheme: "file", mimeType: "application/x-zip-compressed-fb2" },
            { scheme: "file", mimeType: "text/plain" },
            { scheme: "file", mimeType: "text/html" },
            { scheme: "file", mimeType: "text/markdown" },
            {
              scheme: "file",
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
          ],
        },
        {
          action: "SEND",
          category: ["DEFAULT"],
          data: [{ scheme: "content", mimeType: "application/epub+zip" }],
        },
      ],
    },
    plugins: [
      [
        "expo-dev-client",
        {
          launchMode: "launcher",
        },
      ],
      [
        "expo-local-authentication",
        {
          faceIDPermission: "Allow ReadAny to use Face ID to unlock the app.",
        },
      ],
      [
        "expo-av",
        {
          microphonePermission: false,
        },
      ],
      [
        "expo-build-properties",
        {
          android: {
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            enableMinifyInReleaseBuilds: true,
            usesCleartextTraffic: true,
          },
        },
      ],
      "./plugins/withGradleMemory",
      ["./plugins/withAndroidShortcuts", { scheme: variant.scheme }],
      "expo-font",
      [
        "expo-image-picker",
        {
          photosPermission: "ReadAny uses your photo library to choose custom book covers.",
        },
      ],
      "expo-secure-store",
      "expo-sqlite",
      "expo-asset",
      "./plugins/withOnnxruntimePackage",
      "onnxruntime-react-native",
      "./plugins/withVolumeKeyPaging",
      [
        "expo-camera",
        {
          cameraPermission: "Allow ReadAny to use your camera to scan sync QR codes.",
        },
      ],
    ],
    scheme: variant.scheme,
    extra: {
      appVariant: variant.key,
    },
  },
};
