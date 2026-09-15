/**
 * Phase 10.4 + 10.5 — Settings > Security (App Lock + Biometric).
 *
 * - Toggle App Lock (requires a PIN to be set first).
 * - Set/change PIN (4-8 digits, hash in SecureStore — never the PIN itself).
 * - Toggle biometric unlock (only if device supports it; graceful fallback).
 * - Toggle lock-on-background.
 * All strings use t() with fallbacks so no locale files must change.
 */
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { isValidPinFormat, useSecurityStore } from "@/stores/security-store";
import { useBiometricAvailable } from "@/components/security/AppLockScreen";
import { fontSize, fontWeight, radius, useColors } from "@/styles/theme";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsHeader } from "./SettingsHeader";

export default function SecuritySettingsScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const layout = useResponsiveLayout();
  const appLockEnabled = useSecurityStore((s) => s.appLockEnabled);
  const hasPin = useSecurityStore((s) => s.hasPin);
  const biometricAllowed = useSecurityStore((s) => s.biometricAllowed);
  const lockOnBackground = useSecurityStore((s) => s.lockOnBackground);
  const setAppLockEnabled = useSecurityStore((s) => s.setAppLockEnabled);
  const setBiometricAllowed = useSecurityStore((s) => s.setBiometricAllowed);
  const setLockOnBackground = useSecurityStore((s) => s.setLockOnBackground);
  const setPin = useSecurityStore((s) => s.setPin);
  const clearPin = useSecurityStore((s) => s.clearPin);
  const biometricAvailable = useBiometricAvailable();

  const [pinInput, setPinInput] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [settingPin, setSettingPin] = useState(false);
  const [busy, setBusy] = useState(false);

  const s = StyleSheet.create({
    container: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { paddingHorizontal: 16, paddingBottom: 32 },
    section: { marginTop: 20, gap: 12 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 12,
    },
    rowText: { flex: 1 },
    rowTitle: { fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: colors.foreground },
    rowHint: { fontSize: fontSize.xs, color: colors.mutedForeground, marginTop: 2 },
    input: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
      height: 48,
      fontSize: fontSize.base,
      color: colors.foreground,
      letterSpacing: 4,
    },
    primaryBtn: {
      backgroundColor: colors.primary,
      borderRadius: radius.lg,
      alignItems: "center",
      justifyContent: "center",
      height: 48,
    },
    primaryText: { color: colors.primaryForeground, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
    dangerBtn: {
      borderRadius: radius.lg,
      alignItems: "center",
      justifyContent: "center",
      height: 48,
      borderWidth: 1,
      borderColor: colors.destructive,
    },
    dangerText: { color: colors.destructive, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  });

  const handleToggleLock = (value: boolean) => {
    if (value && !hasPin) {
      setSettingPin(true);
      return;
    }
    setAppLockEnabled(value);
  };

  const handleSavePin = async () => {
    if (!isValidPinFormat(pinInput)) {
      Alert.alert(t("applock.pinInvalidTitle", "Invalid PIN"), t("applock.pinInvalid", "Use 4-8 digits."));
      return;
    }
    if (settingPin && pinInput !== pinConfirm) {
      Alert.alert(t("applock.pinMismatchTitle", "PINs do not match"), t("applock.pinMismatch", "Type the same PIN twice."));
      return;
    }
    setBusy(true);
    try {
      const ok = await setPin(pinInput);
      if (ok) {
        setPinInput("");
        setPinConfirm("");
        setSettingPin(false);
        setAppLockEnabled(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <SettingsHeader title={t("settings.security", "安全")} />
      <ScrollView style={s.scroll} contentContainerStyle={[s.scrollContent, { alignItems: "center" }]}>
        <View style={{ width: "100%", maxWidth: layout.centeredContentWidth }}>
          <View style={s.section}>
            <View style={s.row}>
              <View style={s.rowText}>
                <Text style={s.rowTitle}>{t("applock.enable", "App Lock")}</Text>
                <Text style={s.rowHint}>
                  {t("applock.enableHint", "Require authentication when opening ReadAny")}
                </Text>
              </View>
              <Switch value={appLockEnabled} onValueChange={handleToggleLock} />
            </View>
            <View style={s.row}>
              <View style={s.rowText}>
                <Text style={s.rowTitle}>{t("applock.lockOnBackground", "Lock when backgrounded")}</Text>
                <Text style={s.rowHint}>
                  {t("applock.lockOnBackgroundHint", "Lock again when returning from background")}
                </Text>
              </View>
              <Switch value={lockOnBackground} onValueChange={setLockOnBackground} />
            </View>
            <View style={s.row}>
              <View style={s.rowText}>
                <Text style={s.rowTitle}>{t("applock.biometric", "Biometric unlock")}</Text>
                <Text style={s.rowHint}>
                  {biometricAvailable
                    ? t("applock.biometricHint", "Fingerprint / face, falls back to PIN")
                    : t("applock.biometricUnavailable", "Not available on this device — PIN will be used")}
                </Text>
              </View>
              <Switch
                value={biometricAllowed && biometricAvailable}
                disabled={!biometricAvailable}
                onValueChange={setBiometricAllowed}
              />
            </View>
          </View>

          <View style={s.section}>
            <Text style={[s.rowTitle, { marginBottom: 4 }]}>
              {hasPin || settingPin
                ? t("applock.changePin", "Set / change PIN")
                : t("applock.setPin", "Set PIN")}
            </Text>
            <TextInput
              style={s.input}
              value={pinInput}
              onChangeText={(v) => setPinInput(v.replace(/\D/g, "").slice(0, 8))}
              keyboardType="number-pad"
              secureTextEntry
              placeholder={t("applock.pinPlaceholder", "4-8 digits")}
              placeholderTextColor={colors.mutedForeground}
              maxLength={8}
            />
            {(settingPin || !hasPin) && (
              <TextInput
                style={s.input}
                value={pinConfirm}
                onChangeText={(v) => setPinConfirm(v.replace(/\D/g, "").slice(0, 8))}
                keyboardType="number-pad"
                secureTextEntry
                placeholder={t("applock.pinConfirmPlaceholder", "Repeat PIN")}
                placeholderTextColor={colors.mutedForeground}
                maxLength={8}
              />
            )}
            <TouchableOpacity style={s.primaryBtn} onPress={handleSavePin} disabled={busy}>
              <Text style={s.primaryText}>{t("common.save", "Save")}</Text>
            </TouchableOpacity>
            {hasPin && (
              <TouchableOpacity
                style={s.dangerBtn}
                onPress={() => {
                  Alert.alert(
                    t("applock.clearTitle", "Remove App Lock?"),
                    t("applock.clearBody", "This removes your PIN and disables App Lock."),
                    [
                      { text: t("common.cancel", "Cancel"), style: "cancel" },
                      {
                        text: t("common.remove", "Remove"),
                        style: "destructive",
                        onPress: () => {
                          void clearPin();
                          setPinInput("");
                          setPinConfirm("");
                        },
                      },
                    ],
                  );
                }}
              >
                <Text style={s.dangerText}>{t("applock.clearPin", "Remove PIN & disable lock")}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
