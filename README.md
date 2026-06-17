<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="DevOps Studio" />
  <h1>DevOps Studio</h1>

  <p><strong>AI-native desktop assistant for Azure DevOps Test Plans</strong></p>
</div>

---

DevOps Studio is a desktop app for QA engineers who live in Azure DevOps Test
Plans. Paste a feature spec, point it at your source code, and it drafts
publishable test cases — grounded in real code, with bug suggestions, confidence
scores, and duplicate detection — then publishes them straight into your chosen
plan and suite.

It's editor-shaped: a tabbed workspace, a command palette, keyboard-driven and
dense but quiet. **Read-only on your code** — every AI surface only ever
*suggests* artifacts you choose to apply; nothing writes to your repo or your
test plans on its own.

## What you can do

### Generate test cases from a spec
Paste a ticket or PR description into the **Generator**, drag in source files
(or let the agent grep your repo), and it drafts cases with step-by-step
actions, expected results, and bug suggestions — grounded in the actual code,
not guessed from the spec. Review each case (keep / skip / edit in place) before
anything reaches ADO, then refine the batch with plain-English follow-ups
("add an edge case for empty input") without re-running from scratch.

### Score pass-readiness
**Confidence** scoring traces every step of a case through your source and
predicts whether it will pass (0–100%). Score one case or a whole suite in a
single pass. High-confidence passes can auto-set their run outcome, and any step
the model can't ground in code raises a *manual test recommended* flag so you
never rubber-stamp unverified behaviour.

### Chat with a published suite
Right-click any suite → **Open chat** and ask questions grounded in the cases
ADO actually has ("which of these cover the empty-tenant path?"). When the model
proposes a concrete change — rewrite a step, create a sibling case, delete a
duplicate, set an outcome — it renders as an **Apply to ADO** card you click to
apply, with one-click undo. Threads are multi-per-suite and persist across
sessions.

### Review commits with AI
Pick one or more commits and the **Commit Review** runs a two-stage pass —
*investigate* (hunt for issues with read-only code analysis) then *verify*
(skeptically refute false positives) — and returns severity-ranked findings with
evidence. Suggested fixes render as click-to-apply patch cards. Every run
persists and reopens from History exactly as you left it.

### Source-linked, branch-aware
Every generated case carries `repo + file + symbol` — clickable in the embedded
code viewer (scrolls to the line and pulses the range) and on ADO Repos once
published. Code links pin to your tracking branch, or the live source-dir branch
when you set it to `$current`, so they always point at the code the case was
generated from. The status bar shows your source directory and its current git
branch.

### An editor, not a form
Tabbed panes you can split and drag, a `Ctrl/Cmd+K` command palette, fully
customizable keyboard shortcuts, a read-only **CodeMirror** viewer with 8
light/dark theme families and *open-in-your-editor* (VS Code, Cursor, Vim, Zed,
IntelliJ, …), and an optional **xterm.js terminal** that survives pane splits.
UI scale is independent of OS zoom.

### Bring your own AI
One BYOK engine, every provider via API key — OpenAI, Anthropic, Google, xAI,
Cerebras, Groq, DeepSeek, Mistral, OpenRouter, any OpenAI-compatible endpoint,
plus local **LM Studio / MLX / Ollama**. Keys live in the OS keychain. All four
AI surfaces (Generator, Confidence, Suite Chat, Commit Review) route through one
shared task runner and stay read-only against your source.

## Install

Grab the latest installer for your platform from the
[releases page](https://github.com/Readtt/devops-studio/releases/latest):

| OS | Asset |
|----|-------|
| Windows | `DevOps Studio_x.y.z_x64-setup.exe` or `_x64_en-US.msi` |
| Linux (Debian/Ubuntu) | `DevOps Studio_x.y.z_amd64.deb` |
| Linux (Fedora/RHEL) | `DevOps Studio-x.y.z-1.x86_64.rpm` |
| Linux (anywhere else) | `DevOps Studio_x.y.z_amd64.AppImage` |
| macOS (Apple Silicon) | `DevOps Studio_x.y.z_aarch64.dmg` |
| macOS (Intel) | `DevOps Studio_x.y.z_x64.dmg` |

**macOS users:** the bundles are unsigned for now (no Apple Developer account).
See [docs/install-macos.md](docs/install-macos.md) for the Gatekeeper bypass on
first launch.

Auto-update is built in — future versions download and install in place after
you click the prompt.

## Setup

1. **Settings → Azure DevOps** — paste your org URL, project name, and a Personal
   Access Token (scopes: Test Management R/W, Work Items R/W, Code Read, Identity
   Read). Click **Test connection**.
2. Pick a **source directory** (status bar, bottom-left) so code-link rows and the
   agent can resolve relative paths.
3. *(Optional)* **Settings → Models** — add an API key for whichever provider you
   want to drive generation.

Then open the **Test Plans** sidebar, expand a plan, click `+Generate` on a
suite, paste your spec, and go.

## Build from source

```sh
pnpm install
pnpm tauri dev      # dev (with HMR)
pnpm tauri build    # release bundle
```

Requires Node 20+ and Rust stable; the Tauri 2 toolchain handles the rest.

## Tech stack

- **Shell:** Tauri 2 (Rust backend + system webview)
- **Frontend:** React 19 + Vite 7 + TypeScript 5.8
- **UI:** shadcn (radix-luma) + Tailwind v4 + `oklch` tokens, Geist + JetBrains Mono
- **State:** Zustand
- **AI:** Vercel AI SDK (multi-provider, BYOK)
- **ADO client:** native Rust `reqwest`, PAT in the OS keychain
- **Code viewer:** CodeMirror 6
- **Storage:** Tauri Store (settings) + SQLite (history, chats, reviews, confidence)

## Releases

Release process and changelog format are documented in
[CLAUDE.md → Release process](CLAUDE.md#release-process); every release is
recorded in [CHANGELOG.md](CHANGELOG.md).

## History

Originally forked from the open-source [Terax](https://github.com/crynta/terax-ai)
AI terminal. The shell/agents UI was stripped down during the QA pivot to make
room for a purpose-built ADO Test Plans tool; an opt-in xterm.js terminal pane
has since returned as a developer-mode surface.

## License

Apache 2.0 — inherits Terax's upstream license.
