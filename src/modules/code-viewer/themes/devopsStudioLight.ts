import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";

/**
 * DevOps Studio Light — the analogous counterpart to DevOps Studio Dark.
 *
 * The dark variant pairs an OLED black background with a mint primary so the
 * editor blends into the app chrome. The light variant flips that to a
 * paper-white background with the SAME accent family (mint, lavender, rose,
 * amber) tuned for AAA contrast on white. Use this any time the user picks
 * "DevOps Studio" as their editor theme family and the app is in light mode.
 */
export const devopsStudioLight = createTheme({
  theme: "light",
  settings: {
    background: "#ffffff",
    foreground: "#1a1d24",
    caret: "#0e9f7a",
    selection: "rgba(14, 159, 122, 0.16)",
    selectionMatch: "rgba(14, 159, 122, 0.08)",
    lineHighlight: "rgba(0, 0, 0, 0.025)",
    gutterBackground: "#ffffff",
    gutterForeground: "#9ca3af",
    gutterActiveForeground: "#4b5563",
    gutterBorder: "transparent",
    fontFamily:
      'JetBrains Mono Variable, JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
  styles: [
    { tag: t.comment, color: "#6b7280", fontStyle: "italic" },
    { tag: [t.lineComment, t.blockComment, t.docComment], color: "#6b7280", fontStyle: "italic" },
    { tag: [t.string, t.special(t.string)], color: "#8a4d00" },
    { tag: t.regexp, color: "#8a4d00" },
    { tag: t.number, color: "#5b21b6" },
    { tag: t.bool, color: "#5b21b6" },
    { tag: t.null, color: "#5b21b6" },
    { tag: t.keyword, color: "#b91c5c", fontWeight: "500" },
    { tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#b91c5c" },
    { tag: t.definitionKeyword, color: "#b91c5c", fontWeight: "500" },
    { tag: t.modifier, color: "#5b21b6" },
    { tag: [t.typeName, t.className], color: "#0e7a5e" },
    { tag: [t.atom, t.self, t.namespace], color: "#0e7a5e" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#1a66a8" },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#1a1d24" },
    { tag: t.variableName, color: "#1a1d24" },
    { tag: t.propertyName, color: "#4b5563" },
    { tag: t.attributeName, color: "#1a66a8" },
    { tag: t.tagName, color: "#0e7a5e" },
    { tag: [t.operator, t.derefOperator, t.logicOperator, t.arithmeticOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator], color: "#5b21b6" },
    { tag: t.punctuation, color: "#6b7280" },
    { tag: [t.bracket, t.squareBracket, t.paren, t.brace, t.angleBracket], color: "#4b5563" },
    { tag: t.escape, color: "#9a3412" },
    { tag: t.invalid, color: "#b91c1c", textDecoration: "underline" },
    // Markdown / prose
    { tag: t.heading, color: "#0e7a5e", fontWeight: "600" },
    { tag: t.heading1, color: "#0e7a5e", fontWeight: "700" },
    { tag: t.heading2, color: "#0e7a5e", fontWeight: "600" },
    { tag: t.strong, fontWeight: "700", color: "#1a1d24" },
    { tag: t.emphasis, fontStyle: "italic", color: "#4b5563" },
    { tag: t.link, color: "#1a66a8", textDecoration: "underline" },
    { tag: t.url, color: "#1a66a8" },
    { tag: t.quote, color: "#5b21b6", fontStyle: "italic" },
    // Diff / patch
    { tag: t.inserted, color: "#0e7a5e" },
    { tag: t.deleted, color: "#b91c5c" },
    { tag: t.changed, color: "#8a4d00" },
  ],
});
