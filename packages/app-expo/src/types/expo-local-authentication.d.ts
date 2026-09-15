/**
 * Phase 10.5 — Type declarations for the optional expo-local-authentication.
 *
 * The package is declared in package.json but NOT installed yet (no native
 * build in this phase). All runtime access goes through dynamic import with
 * try/catch in AppLockScreen, so a missing native module degrades gracefully
 * to PIN-only. This declaration keeps tsc green in the meantime.
 */
declare module "expo-local-authentication" {
  export function hasHardwareAsync(): Promise<boolean>;
  export function isEnrolledAsync(): Promise<boolean>;
  export function authenticateAsync(options?: {
    promptMessage?: string;
    cancelLabel?: string;
    disableDeviceFallback?: boolean;
  }): Promise<{ success: boolean; error?: string }>;
}
