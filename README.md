<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="DevOps Studio" />
  <h1>DevOps Studio</h1>

  <p><strong>AI-native desktop assistant for Azure DevOps Test Plans</strong></p>
</div>

---

DevOps Studio is a Tauri 2 + React desktop app built for QA testers who live in Azure DevOps Test Plans. Paste a feature spec, optionally drag in source files, and it drafts test cases (with bugs, source-code links, and duplicate detection) ready to publish into your chosen Test Plan / Suite.

## Highlights

- **Test Case Generator** — requirements + source code → draft batch → review → publish to ADO
- **Native ADO REST** — typed Rust client. PAT stored in OS keychain. No MCP layer in the hot path.
- **Read-only by design** — testers browse code in-app, edit in Visual Studio. Zero accidental writes.
- **Source-linked tests** — every case carries repo + file + symbol; clickable in-app and on ADO Repos
- **Staleness detection** — when linked code changes upstream, affected test cases surface in a queue
- **Embedded terminal** — run `claude` or any CLI alongside, multi-pane xterm with WebGL
- **Bring-your-own AI** — Anthropic, OpenAI, Google, Groq, xAI, local models via LM Studio / Ollama

## Status

v0.1 — initial fork from the open-source [Terax](https://github.com/crynta/terax-ai) AI terminal. Active development.

## Build

```sh
pnpm install
pnpm tauri dev      # dev
pnpm tauri build    # release
```

## Setup

1. Open Settings → Azure DevOps
2. Paste your org URL, project, and Personal Access Token (scopes: Test Management R/W, Work Items R/W, Code Read, Identity Read)
3. Click Test connection — status should go green

Then open the Test Plans sidebar, pick a plan/suite, and start generating.

## License

Apache 2.0 — inherits Terax's license.
