/**
 * Phase 10.4 + 10.5 — App Lock screen.
 *
 * Shown when App Lock is enabled and the session is not unlocked.
 * Methods, in order: Biometric (if allowed + available) → PIN pad.
 * expo-local-authentication is dynamically imported so the app still
 * typechecks/builds without the native module until it is installed.
 */
import { useSecurityStore } from "@/stores/security-store";
import { fontSize, fontWeight, radius, useColors } from "@/styles/theme";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type LocalAuthModule = {
  hasHardwareAsync: () => Promise<boolean>;
  isEnrolledAsync: () => Promise<boolean>;
  authenticateAsync: (options?: {
    promptMessage?: string;
    cancelLabel?: string;
    disableDeviceFallback?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
};

let localAuthModule: LocalAuthModule | null | undefined;
async function getLocalAuth(): Promise<LocalAuthModule | null> {
  if (localAuthModule !== undefined) return localAuthModule;
  try {
    const mod = await import("expo-local-authentication");
    localAuthModule =
      mod && typeof mod.authenticateAsync === "function"
        ? (mod as unknown as LocalAuthModule)
        : null;
  } catch {
    // Native module missing (old dev client): biometric gracefully unavailable
    localAuthModule = null;
  }
  return localAuthModule;
}

const PIN_LENGTH = 6;

export function useBiometricAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getLocalAuth().then(async (mod) => {
      if (cancelled || !mod) return;
      try {
        const [hw, enrolled] = await Promise.all([
          mod.hasHardwareAsync(),
          mod.isEnrolledAsync(),
        ]);
        if (!cancelled) setAvailable(hw && enrolled);
      } catch {
        // leave unavailable
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

export function AppLockScreen({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const colors = useColors();
  const verifyPin = useSecurityStore((s) => s.verifyPin);
  const markUnlocked = useSecurityStore((s) => s.markUnlocked);
  const biometricAllowed = useSecurityStore((s) => s.biometricAllowed);
  const biometricAvailable = useBiometricAvailable();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoTriedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setPin("");
      setError(null);
      setBusy(false);
      autoTriedRef.current = false;
    }
  }, [visible]);

  const tryBiometric = useCallback(async () => {
    const mod = await getLocalAuth();
    if (!mod) return false;
    setBusy(true);
    try {
      const res = await mod.authenticateAsync({
        promptMessage: t("applock.biometricPrompt", "Unlock ReadAny"),
        cancelLabel: t("common.cancel", "Cancel"),
        disableDeviceFallback: true,
      });
      if (res.success) {
        markUnlocked();
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, [markUnlocked, t]);

  // Auto-prompt biometric once when the lock appears (Phase 10.5 behavior)
  useEffect(() => {
    if (visible && biometricAllowed && biometricAvailable && !autoTriedRef.current) {
      autoTriedRef.current = true;
      void tryBiometric();
    }
  }, [visible, biometricAllowed, biometricAvailable, tryBiometric]);

  const submitPin = useCallback(
    async (value: string) => {
      if (value.length < 4) return;
      setBusy(true);
      setError(null);
      try {
        const ok = await verifyPin(value);
        if (ok) {
          markUnlocked();
        } else {
          setError(t("applock.wrongPin", "Wrong PIN, try again"));
          setPin("");
        }
      } finally {
        setBusy(false);
      }
    },
    [verifyPin, markUnlocked, t],
  );

  const pressDigit = (d: string) => {
    if (busy) return;
    const next = (pin + d).slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length >= 4) {
      // Accept 4-8 digits; submit on 6th digit or when user pauses —
      // simplest predictable rule: submit at 6, or at 4-5 via OK button.
      if (next.length === PIN_LENGTH) void submitPin(next);
    }
  };

  const s = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center", padding: 24 },
    title: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.foreground, marginBottom: 8 },
    hint: { fontSize: fontSize.sm, color: colors.mutedForeground, marginBottom: 24, textAlign: "center" },
    dots: { flexDirection: "row", gap: 12, marginBottom: 8 },
    dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: colors.mutedForeground },
    dotFilled: { backgroundColor: colors.primary, borderColor: colors.primary },
    error: { fontSize: fontSize.sm, color: colors.destructive, minHeight: 20, marginBottom: 8 },
    pad: { flexDirection: "row", flexWrap: "wrap", width: 240, justifyContent: "center", gap: 12, marginTop: 8 },
    key: { width: 68, height: 68, borderRadius: 34, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
    keyText: { fontSize: 24, fontWeight: fontWeight.semibold, color: colors.foreground },
    bioBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.lg, backgroundColor: colors.primary },
    bioText: { color: colors.primaryForeground, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
    okBtn: { marginTop: 12, paddingHorizontal: 20, paddingVertical: 12 },
    okText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  });

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={() => {}}>
      <View style={s.overlay}>
        <Text style={s.title}>{t("applock.title", "ReadAny is locked")}</Text>
        <Text style={s.hint}>
          {biometricAllowed && biometricAvailable
            ? t("applock.hintBioOrPin", "Use biometrics or enter your PIN")
            : t("applock.hintPin", "Enter your PIN to continue reading")}
        </Text>
        <View style={s.dots}>
          {["p0", "p1", "p2", "p3", "p4", "p5"].map((id, i) => (
            <View key={id} style={[s.dot, i < pin.length && s.dotFilled]} />
          ))}
        </View>
        <Text style={s.error}>{error || " "}</Text>
        {busy ? (
          <ActivityIndicator size="large" color={colors.primary} />
        ) : (
          <View style={s.pad}>
            {[
              { k: "1", id: "k1" },
              { k: "2", id: "k2" },
              { k: "3", id: "k3" },
              { k: "4", id: "k4" },
              { k: "5", id: "k5" },
              { k: "6", id: "k6" },
              { k: "7", id: "k7" },
              { k: "8", id: "k8" },
              { k: "9", id: "k9" },
              { k: "", id: "sp" },
              { k: "0", id: "k0" },
              { k: "⌫", id: "bk" },
            ].map(({ k, id }) =>
              k === "" ? (
                <View key={id} style={{ width: 68, height: 68 }} />
              ) : (
                <TouchableOpacity
                  key={id}
                  style={s.key}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (k === "⌫") setPin((p) => p.slice(0, -1));
                    else pressDigit(k);
                  }}
                >
                  <Text style={s.keyText}>{k}</Text>
                </TouchableOpacity>
              ),
            )}
          </View>
        )}
        {pin.length >= 4 && pin.length < PIN_LENGTH && !busy ? (
          <TouchableOpacity style={s.okBtn} onPress={() => void submitPin(pin)}>
            <Text style={s.okText}>{t("common.confirm", "OK")}</Text>
          </TouchableOpacity>
        ) : null}
        {biometricAllowed && biometricAvailable && !busy ? (
          <TouchableOpacity style={s.bioBtn} onPress={() => void tryBiometric()}>
            <Text style={s.bioText}>{t("applock.useBiometric", "Use biometrics")}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </Modal>
  );
}
