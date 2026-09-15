/**
 * Phase 10.4 + 10.5 — App Lock + Biometric state.
 *
 * Security model (minimal storage):
 * - PIN never stored. Only SHA-256(PIN + deviceSalt) hash in SecureStore.
 *   deviceSalt generated once via expo-crypto, also in SecureStore.
 * - Preferences (enabled, biometric allowed, lock-on-background) in
 *   persisted zustand state (non-secret).
 * - unlockedThisSession is RAM-only: cleared on JS reload / process death,
 *   so a killed app always asks again.
 * - Biometric itself handled by the OS (expo-local-authentication,
 *   optional dynamic import). No biometric data ever stored.
 */
import * as Crypto from "expo-crypto";
import { create } from "zustand";
import { deleteSecure, loadSecure, saveSecure, withPersist } from "./persist";

const PIN_HASH_KEY = "applock-pin-hash";
const PIN_SALT_KEY = "applock-pin-salt";

async function getOrCreateSalt(): Promise<string> {
  const existing = await loadSecure(PIN_SALT_KEY);
  if (existing) return existing;
  const salt = Crypto.randomUUID();
  await saveSecure(PIN_SALT_KEY, salt);
  return salt;
}

async function hashPin(pin: string): Promise<string> {
  const salt = await getOrCreateSalt();
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}

export function isValidPinFormat(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

interface SecurityState {
  appLockEnabled: boolean;
  biometricAllowed: boolean;
  lockOnBackground: boolean;
  hasPin: boolean;
  unlockedThisSession: boolean;
  _hasHydrated: boolean;

  refreshHasPin: () => Promise<void>;
  setAppLockEnabled: (enabled: boolean) => void;
  setBiometricAllowed: (allowed: boolean) => void;
  setLockOnBackground: (enabled: boolean) => void;
  setPin: (pin: string) => Promise<boolean>;
  verifyPin: (pin: string) => Promise<boolean>;
  clearPin: () => Promise<void>;
  markUnlocked: () => void;
  markLocked: () => void;
}

export const useSecurityStore = create<SecurityState>()(
  withPersist<SecurityState>(
    "security",
    (set) => ({
      appLockEnabled: false,
      biometricAllowed: true,
      lockOnBackground: true,
      hasPin: false,
      unlockedThisSession: false,
      _hasHydrated: false,

      refreshHasPin: async () => {
        const hash = await loadSecure(PIN_HASH_KEY);
        set({ hasPin: !!hash });
      },

      setAppLockEnabled: (enabled) => set({ appLockEnabled: enabled }),

      setBiometricAllowed: (allowed) => set({ biometricAllowed: allowed }),

      setLockOnBackground: (enabled) => set({ lockOnBackground: enabled }),

      setPin: async (pin) => {
        if (!isValidPinFormat(pin)) return false;
        const hash = await hashPin(pin);
        await saveSecure(PIN_HASH_KEY, hash);
        set({ hasPin: true });
        return true;
      },

      verifyPin: async (pin) => {
        const stored = await loadSecure(PIN_HASH_KEY);
        if (!stored) return false;
        const hash = await hashPin(pin);
        return hash === stored;
      },

      clearPin: async () => {
        await deleteSecure(PIN_HASH_KEY);
        await deleteSecure(PIN_SALT_KEY);
        set({ hasPin: false, appLockEnabled: false, unlockedThisSession: false });
      },

      markUnlocked: () => set({ unlockedThisSession: true }),

      markLocked: () => set({ unlockedThisSession: false }),
    }),
    {
      // Transient session state must never survive a restart
      unlockedThisSession: false,
      _hasHydrated: false,
    } as Partial<SecurityState>,
  ),
);
