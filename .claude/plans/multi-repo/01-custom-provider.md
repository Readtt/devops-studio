# Phase 1 — Custom provider: model dropdown + real Test

> Read `00-INDEX.md` first for ground rules. This phase is **independent** of the multi-repo work and
> of every other phase — it can be reordered or skipped without consequence.

## Problem

`src/settings/sections/ModelsSection.tsx:640-652` is a free-text Model ID input. The Test button
(`:560-568`) calls `lm_ping` (`src-tauri/src/modules/net.rs:194-220`), which GETs `{base}/models`,
**throws the body away**, and returns `status > 0` — so 401 / 404 / 500 all render "Reachable —
server responded" (`:774`). No `Authorization` header is sent and the model id is never exercised.

The model list you want is already being fetched and discarded at `net.rs:218`
(`.map(|r| r.status().as_u16())`).

There is one hard-coded `openai-compatible` slot (`src/modules/ai/config.ts:92-99`), **not** a list
of custom providers — "Add provider" (`ModelsSection.tsx:224-226`) just reveals a card for a fixed
`ProviderId`, tracked in an ephemeral `adding: Set<ProviderId>` (`:111`). This phase does **not**
change that.

## 1. Rust — replace `lm_ping` with `lm_list_models`

`src-tauri/src/modules/net.rs`. New signature:

```rust
pub async fn lm_list_models(base_url: String, api_key: Option<String>)
    -> Result<LmModelsResult, String>
```

returning `{ status: u16, models: Vec<String>, error: Option<String> }`.

It is `lm_ping`'s body plus exactly two additions:
- an `Authorization: Bearer {key}` header when `api_key` is `Some` and non-empty;
- reading and parsing the body instead of discarding it.

**Keep every existing guard unchanged:**
- `validate_url(&probe, true)` (`:201`)
- `classify_and_collect_safe_ips(&host, true)` (`:206`) — both already pass `allow_private = true`,
  which is why localhost model servers work
- 5 s timeout and `redirect::Policy::none()` (`:208-213`)
- trailing-slash trim and empty-URL rejection (`:196-199`)

Tolerant body parse, in order: OpenAI `{ "data": [{ "id": … }] }`, Ollama-ish
`{ "models": [{ "name"|"id": … }] }`, or a bare array of strings/objects. Anything else → empty
`models` with `error` set, not a hard failure.

Swap the registration at `src-tauri/src/lib.rs:549`. net.rs registers exactly three commands at
`:549-551` (`lm_ping`, `ai_http_stream`, `ai_http_stream_cancel`); `lm_ping`'s only caller is the
Test button, which this phase rewrites, so remove it rather than keeping both.

## 2. `ComboboxCreatable` — a new shared component

No creatable combobox exists. `BranchPicker`, `DeveloperPicker` and `ModelPicker` are all
select-only, and `BranchPicker`'s `CommandInput` (`:157`) is **uncontrolled** (filter-only).

Add `src/components/ComboboxCreatable.tsx`, shaped like `BranchPicker.tsx:111-199`:
Popover → PopoverTrigger asChild + button → PopoverContent `className="p-0"` → `Command` →
`CommandInput` → `CommandList className="max-h-[280px]"` → `CommandEmpty` → `CommandGroup`.

Differences from `BranchPicker`:
- **Controlled `CommandInput`.** `src/components/ui/command.tsx:80` spreads `...props` into
  `CommandPrimitive.Input`, so `value` / `onValueChange` pass through cleanly. Only `className` is
  intercepted. (You cannot style the outer wrapper from props — it's a fixed
  `div[data-slot=command-input-wrapper]` + `InputGroup` at `:72-73`.)
- A `Use "<typed>"` row when the typed text is non-empty and not an exact match in the list.
- Port `BranchPicker`'s not-in-list fallback (`:91-94`) so a saved-but-unlisted value still
  displays — **but fix bug #11 while porting.** The original is:

  ```ts
  if (value && !seen.has(value) && !sentinel?.value.includes(value)) {
  ```

  `.includes()` is a substring test where equality is meant, so a saved value that happens to be a
  substring of the sentinel is silently dropped. Use `sentinel?.value !== value`.

Do **not** modify `BranchPicker` itself in this phase — it's out of scope and its sentinel is
`"$current"`, which makes the bug unreachable in practice there.

## 3. Wire the dropdown into the Models section

Replace the Model ID `<Input>` (`ModelsSection.tsx:640-652`) with `ComboboxCreatable`.

- Fetch on popover open and on base-URL blur; cancel in flight on URL change.
- Three states: **loading** (skeleton rows, not a spinner) / **list** / **empty-or-failed → free
  text only, with an inline hint** ("this endpoint doesn't list models — type the id").
- Applies to all four local providers, which share `LocalProviderCard` (`:525-740`).

**Gate the fetch on a non-empty base URL.** Only three local defaults end in `/v1` —
`LMSTUDIO`/`MLX`/`OLLAMA` (`config.ts:830-832`). `OPENAI_COMPATIBLE_DEFAULT_BASE_URL` is `""`
(`:833`), and `agent.ts:58` reads `options.openaiCompatibleBaseURL ?? ""` then throws at `:151-155`
when empty. There is nothing to append `/models` to until the user types one.

**Commit on select, not on blur.** Model ID and Base URL are currently **blur-save only**
(`:644-647`, `:620-623`) — no Enter handler, no Save button, no dirty indicator. A popover selection
must call the setter directly.

## 4. Test button → a real model call

Replace the `invoke("lm_ping", …)` call (`:563`) with the existing
`testProviderKey(provider, key, local)` (`src/modules/ai/lib/testKey.ts:29-88`). It already runs
`generateText({ prompt: "ping", maxOutputTokens: 1 })` (`:50`) through
`buildConfiguredLanguageModel` and maps 401 / 402 / 429 to verdicts (`:55-79`).

Pass the **drafts**, not saved values — `{ ...EMPTY_PROVIDER_KEYS, [provider]: key }` (`testKey.ts:45`)
is exactly how `ProviderKeyCard` tests an unsaved key (`:201`).

`probeModelId` (`testKey.ts:22-27`) picks the first non-reasoning model for the provider. Each local
provider has exactly one entry — its sentinel (`config.ts:544-581`, no `tags`, no
`rejectsSamplingParams`) — so it resolves correctly, and `buildConfiguredLanguageModel`
(`agent.ts:216-258`) turns the sentinel into the drafted model id via `LocalProviderConfig`
(`agent.ts:205-214`).

**Do NOT try to reuse `localConfig()` (`ModelsSection.tsx:142-177`).** It is an unexported closure
inside the component body over nine `usePreferencesStore` subscriptions (`:114-124`), and its
`LocalConfig` type (`:295-302`) is unexported too. Use the **exported** `localProviderConfig` from
`@/modules/settings/preferences` (already used non-reactively at `useGenerationSession.ts:69`) and
overlay the drafts onto it.

Only `openai-compatible` has a key field — `const supportsKey = provider.id === "openai-compatible"`
(`:558`), `keyDraft` at `:549`, saved at `:714-719`. The other three pass `""`, which
`buildLanguageModel` turns into `apiKey: undefined` (`agent.ts:161`).

**Verdict rendering.** Extend `StatusLine` (`:759-783`) to the five `KeyTestResult` kinds, or
**export** `KeyStatusLine` (`ProviderKeyCard.tsx:308-352` — currently not exported) and reuse it.
Match its precedence exactly: `error` → `testResult` → `prefixWarn`; emerald when `ok`, muted when
`kind === "inconclusive"`, destructive otherwise; glyph chosen by `ok` alone.

Disable Test until base URL **and** model id are non-empty.

**`maxOutputTokens: 1` can be rejected by strict local servers.** The existing `inconclusive` branch
(`testKey.ts:82-87`) absorbs that and **must not** be "fixed" into a hard failure — that's the whole
reason the branch exists.

## No `ModelId` type surgery

`ModelId` is a closed union off `MODELS` (`config.ts:582-584`). A fetched id is only ever the string
stored in `openaiCompatibleModelId` — it never becomes a `ModelId`. Don't try to widen the union.

## Verify

1. Point the openai-compatible card at a real endpoint with a valid key → the Model ID dropdown lists
   models; pick one; Test reports success.
2. Same endpoint, **wrong** key → Test reports an auth failure. (Today this says "Reachable".)
3. Endpoint with no `/models` route → the field falls back to free text with the hint, and Test still
   exercises the typed model id.
4. All four local cards (lmstudio / mlx / ollama / openai-compatible) still render and their Test
   buttons work; the three keyless ones send no key.
5. A model id typed and committed via the combobox persists across a settings-window reopen.
6. `pnpm test` green.

## Commit

`feat(settings): list custom-provider models and make Test a real model call`
