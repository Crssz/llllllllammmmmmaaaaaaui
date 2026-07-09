// Platform-aware keyboard-shortcut labels. The app is Windows-first, but its
// key handlers already accept both Ctrl and Meta; this centralises the modifier
// glyph so labels match the host OS instead of always showing the Mac ⌘.

function detectMac(): boolean {
  // Guard for the node test environment, where `navigator` may be undefined.
  if (typeof navigator === "undefined") return false;
  // navigator.platform is deprecated but remains the most reliable Mac signal
  // inside a WebView; fall back to userAgent for engines that empty it.
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /mac/i.test(platform) || /mac/i.test(ua);
}

/** True when running on macOS (best-effort from `navigator`). */
export const isMac: boolean = detectMac();

/** The primary modifier glyph: "⌘" on Mac, "Ctrl" everywhere else. */
export const MOD: string = isMac ? "⌘" : "Ctrl";

/**
 * Build a keyboard-shortcut label for `key`.
 *   shortcut("K") → "Ctrl+K"  (Windows/Linux)  |  "⌘K"  (Mac)
 *   shortcut("↵") → "Ctrl+↵"                    |  "⌘↵"
 * On Mac the modifier glyph sits flush against the key (native convention);
 * elsewhere it's joined with a "+".
 */
export function shortcut(key: string): string {
  return isMac ? `${MOD}${key}` : `${MOD}+${key}`;
}
