### Added
- One shared task runner (`runTask`/`streamTask`) every AI surface flows through.
- Deep, code-grounded test-case generation: the analyzer now reads your source
  (read-only Read/Glob/Grep) to ground cases and bug suggestions in real code.
- Schema-validated, temperature-0 output on Generator and Confidence (with
  partial-batch salvage so one malformed item never zeroes a generation).
- Global **"Allow AI to read source code"** setting gating every surface.
- Patch / edit blocks are schema-validated before rendering — a malformed block
  shows a plain warning instead of a broken Apply card.
- A high-confidence verdict that leans on an ungrounded step now flags
  "manual test recommended".

### Changed
- **Single BYOK engine.** Every model (OpenAI, Anthropic, Google, xAI, Cerebras,
  Groq, DeepSeek, Mistral, OpenRouter, OpenAI-compatible, local) runs through the
  Vercel AI SDK. Per-surface agentic step caps centralized in `SURFACE_STEP_CAPS`.
- Read window raised to 1500 lines / 24 KB so the model pulls whole modules.

### Removed
- The Claude Code CLI engine: the Rust `claude` subprocess driver + its commands,
  the frontend Claude clients, the per-engine settings, and the `aiEngine` /
  `claudeAuthMode` preferences (older settings files migrate silently).
- A large dead general-coding-agent stack (plan/todo/subagent/transport modules)
  and all write/edit/bash/delegation tools — the app is read-only against your
  source: it suggests artifacts you apply, never autonomously edits or runs shell.
- The per-run "allow code search" toggle (replaced by the global setting).
