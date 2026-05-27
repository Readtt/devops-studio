import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { StreamLanguage } from "@codemirror/language";
import { csharp, c } from "@codemirror/legacy-modes/mode/clike";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveTheme } from "./codeTheme";

/**
 * Read-only, body-only CodeMirror for a chat markdown code block. Renders with
 * the same theme as the in-app code viewer (Settings → General → code editor
 * theme) so a fenced block in a chat reply looks like the editor, not a flat
 * monospace dump. No gutters / active-line / fold chrome — it's a snippet, not
 * an editor. ChatMarkdown wraps this with the lang label + Copy header.
 */
export function ChatCodeMirror({
  lang,
  body,
}: {
  lang: string | null;
  body: string;
}) {
  const themePref = usePreferencesStore((s) => s.theme);
  const editorThemeId = usePreferencesStore((s) => s.editorTheme);
  const theme = useMemo(
    () => resolveTheme(editorThemeId, themePref),
    [editorThemeId, themePref],
  );
  const ext = useMemo(() => {
    const langExt = languageForFence(lang);
    return [langExt, EditorView.lineWrapping].filter(Boolean) as Extension[];
  }, [lang]);

  return (
    <CodeMirror
      value={body}
      theme={theme}
      extensions={ext}
      editable={false}
      readOnly
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        searchKeymap: false,
        highlightSelectionMatches: false,
        drawSelection: false,
      }}
      maxHeight="360px"
      style={{ fontSize: "11px" }}
    />
  );
}

/** Map a markdown fence token (or a bare extension) to a CodeMirror language.
 *  Covers the common cases QA replies emit; unknown tokens fall through to
 *  plain text so the chosen theme's base colours still apply. */
function languageForFence(token: string | null): Extension | null {
  if (!token) return null;
  switch (token.toLowerCase()) {
    case "ts":
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "javascript":
    case "node":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "py":
    case "python":
      return python();
    case "rs":
    case "rust":
      return rust();
    case "go":
    case "golang":
      return go();
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
    case "xml":
    case "vue":
    case "svelte":
    case "razor":
    case "cshtml":
    case "aspx":
      return html();
    case "css":
    case "scss":
    case "less":
    case "sass":
      return css();
    case "cs":
    case "csharp":
    case "c#":
      return StreamLanguage.define(csharp);
    case "c":
    case "cpp":
    case "c++":
    case "h":
    case "hpp":
    case "java":
      return StreamLanguage.define(c);
    case "sh":
    case "bash":
    case "shell":
    case "zsh":
    case "ps1":
    case "powershell":
      return StreamLanguage.define(shell);
    default:
      return null;
  }
}
