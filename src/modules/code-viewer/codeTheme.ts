// Shared CodeMirror theme resolution. Lives here (not in CodeViewerPane) so the
// code viewer AND chat markdown code blocks resolve to the SAME theme object
// for the user's Settings → General "code editor theme" — one source of truth.

import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { atomone } from "@uiw/codemirror-theme-atomone";
import { aura } from "@uiw/codemirror-theme-aura";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { nord } from "@uiw/codemirror-theme-nord";
import { xcodeDark, xcodeLight } from "@uiw/codemirror-theme-xcode";
import { devopsStudioDark } from "./themes/devopsStudioDark";
import { devopsStudioLight } from "./themes/devopsStudioLight";
import type { EditorThemeId } from "@/modules/settings/store";

/** Resolve the user's editor-theme preference to a CodeMirror Extension.
 *  Each theme family carries an analogous light/dark pair, so picking
 *  "DevOps Studio" or "Xcode" in dark mode and flipping the app to light
 *  swaps the editor to the *same family's* light variant — not a generic
 *  GitHub Light fallback. Dark-only upstream themes still degrade to a
 *  paired light theme so the editor never lands on white-on-white.
 */
export function resolveTheme(editorThemeId: EditorThemeId, themePref: string) {
  const dark = isDark(themePref);
  const map: Record<EditorThemeId, { light: unknown; dark: unknown }> = {
    // Hand-tuned pair: matches the app's OLED chrome (dark) / paper (light).
    "devops-studio": { light: devopsStudioLight, dark: devopsStudioDark },
    // Both variants ship with the upstream theme — natural pairings.
    github: { light: githubLight, dark: githubDark },
    xcode: { light: xcodeLight, dark: xcodeDark },
    // Dark-only upstreams. Fall back to githubLight for a clean, neutral
    // light counterpart — the only goal is "stays readable when the app
    // flips to light", not perfect aesthetic mirroring (those themes are
    // canonically dark and the user is explicitly picking a dark theme).
    "atom-one": { light: githubLight, dark: atomone },
    aura: { light: githubLight, dark: aura },
    copilot: { light: githubLight, dark: copilot },
    nord: { light: githubLight, dark: nord },
    "tokyo-night": { light: githubLight, dark: tokyoNight },
  };
  const entry = map[editorThemeId] ?? map["devops-studio"];
  return (dark ? entry.dark : entry.light) as never;
}

export function isDark(pref: string): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  // "system" — fall back to media query
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return true;
}
