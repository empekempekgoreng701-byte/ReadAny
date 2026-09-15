/**
 * Phase 10.3 — Android launcher shortcuts (config plugin, no native code).
 *
 * Generates res/xml/shortcuts.xml + manifest reference at prebuild time:
 *   - Library        → readany://library
 *   - Favorites      → readany://library?filter=favorites
 *   - ContinueReading→ readany://continue-reading (resolved at open time)
 *
 * NOTE: scheme is variant-dependent; app.config.js passes it via plugin props.
 * Deep links must use the SAME scheme as `scheme` in app config
 * (readany-dev / readany-preview / readany). Static shortcuts cannot carry
 * dynamic data (bookId) — Continue Reading resolves the latest book at
 * open time in JS (see useAppShortcuts).
 */
const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

function buildShortcutsXml(scheme) {
  const s = scheme || "readany";
  return `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <shortcut
        android:shortcutId="readany-library"
        android:enabled="true"
        android:icon="@mipmap/ic_launcher"
        android:shortcutShortLabel="@string/app_name">
        <intent
            android:action="android.intent.action.VIEW"
            android:targetPackage="@string/app_package"
            android:targetClass="com.readany.app.MainActivityPlaceholder"
            android:data="${s}://library" />
    </shortcut>
    <shortcut
        android:shortcutId="readany-favorites"
        android:enabled="true"
        android:icon="@mipmap/ic_launcher"
        android:shortcutShortLabel="@string/app_name">
        <intent
            android:action="android.intent.action.VIEW"
            android:targetPackage="@string/app_package"
            android:targetClass="com.readany.app.MainActivityPlaceholder"
            android:data="${s}://library?filter=favorites" />
    </shortcut>
    <shortcut
        android:shortcutId="readany-continue"
        android:enabled="true"
        android:icon="@mipmap/ic_launcher"
        android:shortcutShortLabel="@string/app_name">
        <intent
            android:action="android.intent.action.VIEW"
            android:targetPackage="@string/app_package"
            android:targetClass="com.readany.app.MainActivityPlaceholder"
            android:data="${s}://continue-reading" />
    </shortcut>
</shortcuts>
`;
}

module.exports = function withAndroidShortcuts(config, props) {
  const scheme = (props && props.scheme) || "readany";
  const pkg =
    (config.android && config.android.package) || "com.readany.app.dev";

  // 1. Write res/xml/shortcuts.xml at prebuild time.
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const resDir = path.join(
        cfg.modRequest.projectRoot,
        "android",
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(path.join(resDir, "shortcuts.xml"), buildShortcutsXml(scheme));
      return cfg;
    },
  ]);

  // 2. Reference it from the MAIN/LAUNCHER <activity> via a
  //    <meta-data android:name="android.app.shortcuts"
  //               android:resource="@xml/shortcuts" /> child element.
  //    (There is NO android:shortcuts manifest attribute — writing one
  //    on <application> or <activity> fails AAPT linking with
  //    "error: attribute android:shortcuts not found".)
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const app = manifest.application && manifest.application[0];
    const activities = (app && app.activity) || [];
    const launcher = activities.find((a) => {
      const filters = a["intent-filter"] || [];
      return filters.some((f) => {
        const actions = (f.action || []).map((x) => x.$ && x.$["android:name"]);
        const cats = (f.category || []).map((x) => x.$ && x.$["android:name"]);
        return (
          actions.includes("android.intent.action.MAIN") &&
          cats.includes("android.intent.category.LAUNCHER")
        );
      });
    });
    const target = launcher || activities[0];
    if (!target) return cfg;
    target["meta-data"] = target["meta-data"] || [];
    const exists = target["meta-data"].some(
      (m) => m.$ && m.$["android:name"] === "android.app.shortcuts",
    );
    if (!exists) {
      target["meta-data"].push({
        $: {
          "android:name": "android.app.shortcuts",
          "android:resource": "@xml/shortcuts",
        },
      });
    }
    return cfg;
  });

  // NOTE: targetClass/targetPackage placeholders are resolved by a second
  // pass below because the real activity class name depends on the variant
  // package (com.readany.app[.dev|.preview].MainActivity).
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const xmlPath = path.join(
        cfg.modRequest.projectRoot,
        "android",
        "app",
        "src",
        "main",
        "res",
        "xml",
        "shortcuts.xml",
      );
      try {
        let xml = fs.readFileSync(xmlPath, "utf8");
        const activityClass = `${pkg}.MainActivity`;
        xml = xml.split("com.readany.app.MainActivityPlaceholder").join(activityClass);
        xml = xml.split("@string/app_package").join(pkg);
        fs.writeFileSync(xmlPath, xml);
      } catch {
        // best-effort; prebuild will surface real errors
      }
      return cfg;
    },
  ]);

  return config;
};
