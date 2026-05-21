<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="DevOps Studio" />
  <h1>DevOps Studio</h1>

  <p><strong>AI-native desktop assistant for Azure DevOps Test Plans</strong></p>
</div>

---

DevOps Studio is a desktop app for QA engineers who live in Azure DevOps Test Plans. Paste a feature spec, optionally point it at your source code, and it drafts test cases — with bug suggestions, code-linked steps, and duplicate detection — then publishes them straight into your chosen plan and suite.

It's an editor-shaped tool: tabbed workspace, command palette, keyboard-driven, dense without being noisy. Read-only on your code, opinionated about what to publish, and stays out of your way while a model is thinking.

## What you can do

### Generate test cases from a spec
- Paste a ticket, wiki dump, or PR description into the **Generator**. Drag in source files (or let the agent grep your repo). The analyzer drafts a batch — cases with step-by-step actions and expected results, plus bug suggestions when something in the spec doesn't line up with the code.
- Review every case before anything touches ADO. Keep / skip with `space`, navigate with `j` / `k`, publish with `p`. Click any field to edit in place.
- Re-target the run mid-session — switch plan/suite from the form without losing what you've drafted.
- **Multi-tab** — every `+Generate` click opens a fresh tab with its own isolated session. Two parallel drafts won't trample each other.

### Refine the draft (without re-running)
- Bottom of the review pane is a **follow-up composer** — type "step 3 doesn't match `auth.ts`, fix it" or "add an edge case for empty input" and the analyst re-emits the batch in place, keeping your skip decisions intact. Undo a refine in one click.
- The full **thinking history** for every refine round (instruction + the model's tool calls + the activity log) is captured on the draft. Open the *thinking* dialog to re-read why the draft looks the way it does.

### Source-linked tests
- Every generated case carries `repoName + filePath + symbol` — clickable in-app (opens the file in the embedded code viewer, scrolls to the line, briefly **pulses the range** so you can find it) and on ADO Repos when published.
- Bug suggestions emit **structured repro bodies** with bold-labeled sections: `PRECONDITION`, `STEPS TO REPRODUCE`, `EXPECTED RESULT`, `ACTUAL RESULT`, `ENVIRONMENT`. Renders cleanly in the ADO web UI.

### Browse code, edit elsewhere
- The in-app **code viewer** is a read-only CodeMirror 6 pane with 8 paired light/dark theme families (DevOps Studio, GitHub, Xcode, Atom One, Aura, Copilot, Nord, Tokyo Night). Picking one covers both modes — flip the app theme and the editor flips with you.
- **Open externally** dropdown on every code-viewer tab: jump to the file in VS Code, Cursor, Visual Studio, Sublime, Zed, Vim/Neovim, Emacs, IntelliJ — or any custom command. Placeholders `{file}`, `{line}`, `{endLine}` work in the template, so the editor lands on the exact code section.
- Reveal in the OS file manager when you want context, not the line.

### Stay on top of stale tests
- When linked source code changes upstream, **stale-detection** surfaces affected test cases in a dedicated queue. Acknowledge, mark-for-review, or re-publish a fresh draft against the current code.
- The bottom status bar shows your source directory + the live git branch, so you always know what the staleness baseline is tracking.

### Bring your own AI
Two engines, swappable per generation:
- **Vercel AI SDK** (BYOK) — OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter, any OpenAI-compatible endpoint, plus local LM Studio / MLX / Ollama.
- **Claude Code CLI** (subprocess) — drives `claude` with OAuth or API-key auth, giving the analyst full agent-loop access to read/grep/glob your repo while it thinks.

API keys live in the OS keychain (Windows Credential Manager / macOS Keychain / libsecret). Per-run model override available from the generator; default model lives in the status bar.

### Editor-density UX
- **Command palette** (`Ctrl/Cmd+K`) — jump to plans, cases, bugs, history, or start a generation
- **Customizable shortcuts** for palette, settings, sidebar toggle, theme cycle, new generate tab, tab navigation, stale scan, zoom
- **Persistent drafts** — every edit autosaves to history. Close the tab, close the window, reopen — your draft (including refine thinking) lands back exactly as you left it.
- **Generation history pane** with status filters (draft / published), search by plan/suite/title, and "Open in review" to resume any draft.

## Build

```sh
pnpm install
pnpm tauri dev      # dev (with HMR)
pnpm tauri build    # release bundle
```

Requires Node 20+ and Rust stable. The Tauri 2 toolchain handles the rest.

## Setup

1. Open **Settings → Azure DevOps**
2. Paste your org URL, project name, and a Personal Access Token. Scopes:
   - Test Management R/W
   - Work Items R/W
   - Code Read
   - Identity Read
3. Click **Test connection** — status should go green.
4. Pick a **source directory** (status bar bottom-left) so the agent and code-link rows can resolve relative paths.
5. *(Optional)* **Settings → Models** — add API keys for whichever provider you want to drive generation, or enable Claude Code CLI.

Then open the **Test Plans** sidebar, expand a plan, click `+Generate` on any suite, paste your spec, and go.

## Tech stack

- **Desktop shell:** Tauri 2 (Rust backend + system webview)
- **Frontend:** React 19 + Vite 7 + TypeScript 5.8
- **UI:** shadcn (radix-luma variant) + Tailwind v4 + `oklch` color tokens
- **Fonts:** Geist Variable + JetBrains Mono Variable
- **State:** Zustand
- **AI:** Vercel AI SDK + Claude Code CLI (`@anthropic-ai/claude-agent-sdk`)
- **ADO client:** Native Rust `reqwest`, PAT in OS keychain
- **Code viewer:** CodeMirror 6 with hand-tuned syntax themes
- **Storage:** Tauri Store (settings) + SQLite (generation history)

## History

Originally forked from the open-source [Terax](https://github.com/crynta/terax-ai) AI terminal. The terminal / shell / agents UI was removed during the QA pivot; what remains is a purpose-built ADO Test Plans tool.

## License

Apache 2.0 — inherits Terax's upstream license.
