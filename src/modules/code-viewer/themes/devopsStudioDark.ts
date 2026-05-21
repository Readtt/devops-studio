import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";

/**
 * DevOps Studio Dark — a hand-tuned CodeMirror theme that matches the app's
 * OLED chrome.
 *
 * Why a bespoke theme: the off-the-shelf dark themes (tokyo-night, github-dark,
 * etc.) all use desaturated #11141a-ish backgrounds, which leaves a visible
 * "card" rectangle floating inside our pitch-black panels. This theme drops the
 * background to oklch(0 0 0) and re-tints accent colours to match the mint
 * primary we use elsewhere, so code viewer panes blend into the surrounding
 * chrome instead of looking like an embed.
 */
export const devopsStudioDark = createTheme({
  theme: "dark",
  settings: {
    background: "#000000",
    foreground: "#e6e6e6",
    caret: "#7ee2c5",
    selection: "rgba(126, 226, 197, 0.18)",
    selectionMatch: "rgba(126, 226, 197, 0.10)",
    lineHighlight: "rgba(255, 255, 255, 0.04)",
    gutterBackground: "#000000",
    gutterForeground: "#3f3f46",
    gutterActiveForeground: "#a1a1aa",
    gutterBorder: "transparent",
    fontFamily:
      'JetBrains Mono Variable, JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
  styles: [
    { tag: t.comment, color: "#5a6b6e", fontStyle: "italic" },
    { tag: [t.lineComment, t.blockComment, t.docComment], color: "#5a6b6e", fontStyle: "italic" },
    { tag: [t.string, t.special(t.string)], color: "#e8c891" },
    { tag: t.regexp, color: "#e8c891" },
    { tag: t.number, color: "#c5a8ff" },
    { tag: t.bool, color: "#c5a8ff" },
    { tag: t.null, color: "#c5a8ff" },
    { tag: t.keyword, color: "#ff7eb6", fontWeight: "500" },
    { tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#ff7eb6" },
    { tag: t.definitionKeyword, color: "#ff7eb6", fontWeight: "500" },
    { tag: t.modifier, color: "#9b8cff" },
    { tag: [t.typeName, t.className], color: "#7ee2c5" },
    { tag: [t.atom, t.self, t.namespace], color: "#7ee2c5" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#82d4ff" },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e6e6e6" },
    { tag: t.variableName, color: "#e6e6e6" },
    { tag: t.propertyName, color: "#cbd5e1" },
    { tag: t.attributeName, color: "#82d4ff" },
    { tag: t.tagName, color: "#7ee2c5" },
    { tag: [t.operator, t.derefOperator, t.logicOperator, t.arithmeticOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator], color: "#9b8cff" },
    { tag: t.punctuation, color: "#71717a" },
    { tag: [t.bracket, t.squareBracket, t.paren, t.brace, t.angleBracket], color: "#a1a1aa" },
    { tag: t.escape, color: "#ffb86c" },
    { tag: t.invalid, color: "#ff5555", textDecoration: "underline" },
    // Markdown / prose
    { tag: t.heading, color: "#7ee2c5", fontWeight: "600" },
    { tag: t.heading1, color: "#7ee2c5", fontWeight: "700" },
    { tag: t.heading2, color: "#7ee2c5", fontWeight: "600" },
    { tag: t.strong, fontWeight: "700", color: "#e6e6e6" },
    { tag: t.emphasis, fontStyle: "italic", color: "#cbd5e1" },
    { tag: t.link, color: "#82d4ff", textDecoration: "underline" },
    { tag: t.url, color: "#82d4ff" },
    { tag: t.quote, color: "#9b8cff", fontStyle: "italic" },
    // Diff / patch
    { tag: t.inserted, color: "#7ee2c5" },
    { tag: t.deleted, color: "#ff7eb6" },
    { tag: t.changed, color: "#e8c891" },
  ],
});
