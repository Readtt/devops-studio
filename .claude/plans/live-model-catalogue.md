# Live model catalogue

Goal: new models show up by themselves, without an app release, and a model we
have never seen still gets a request it can't refuse. Also: add the models that
shipped since the last catalogue update, and retire the ones providers shut down.

## Why this and not something simpler

| Option | Why not |
|---|---|
| Keep hand-editing `MODELS` | This is what rotted: 7 of ~40 entries point at shut-down models today (Groq R1 distill died 2025-10-02), prices are wrong (gpt-5.5 out is $30, we say $15), and GPT-6.1 Sol shipped the day this was written. |
| Free-text "model id" per provider | Testers don't know ids. Still needs the same capability defaults. |
| Remote JSON we host | Moves the edit off the release train but it is still an edit per launch. |
| models.dev as the catalogue | Rich metadata, but a third-party dependency on the request-shaping path, lags launches by days, and isn't scoped to the user's key (lists models their account can't call). |
| **Each provider's own `/models` endpoint, with the user's key** | Authoritative, current the day a model ships, scoped to what the key can use, no new network dependency. Metadata is thin for some providers — covered by conservative defaults (below). |

## Design

- `MODELS` stays the **curated** list: explicit, tested decisions for the models
  we recommend. Discovered models are **added** next to them, never replace them.
- Discovered id = `<provider>:<apiId>` (e.g. `openai:gpt-6.1-sol`). Curated ids
  never contain `:`, so no collisions, and a persisted discovered id resolves
  even before discovery has run (synthesised from the id itself).
- `ModelId` widens to `string`. `getModel` resolves curated → discovered →
  synthesised; it only throws for an id that is none of those.
- Request shaping for a discovered model is decided in `config.ts`
  (`modelInfoFromListing`), per the sampling-params doctrine:
  - **temperature: never sent.** Every API accepts its absence; frontier tiers
    400 on its presence. (Provider metadata can't be trusted for this —
    OpenRouter lists `temperature` for Claude 5.5 because Azure accepts it.)
  - **output cap:** Claude-family only (native or `anthropic/*` routes), from the
    listing's max output: `ceiling = max`, `cap = min(64k, max/2)`; family
    fallback when the listing has none. Everyone else: send nothing (unchanged).
  - **context / vision / pricing:** from listing metadata when present, else the
    existing conservative defaults (128k, no vision, no price).
  - **preserved thinking:** Claude generation ≥ 5 → `drop_block` (see below).
- Preserved thinking (Opus 5.5, Sonnet 5.5, Fable 5.1): these reject a replayed
  thinking block whose conversation prefix changed (400 for accounts created on
  or after 2026-08-31). Our tool-result eviction and summary install edit
  history mid-run by design. Fix: every request to such a model sends
  `thinking: {type: "adaptive", blockBinding: {prefixMismatchBehavior: "drop_block"}}`
  (@ai-sdk/anthropic ≥ 3.0.125 adds the beta header). Adaptive is these
  models' default, so the mode is unchanged; invalidated blocks are dropped
  (unbilled) instead of failing the run.
- Discovery runs in the main window: at boot for providers whose list is older
  than 12 h, and on any key change. Settings → Models has "Check now". Results
  persist under one preferences key (`modelCatalog`) so both windows share it
  through the existing `PREFS_CHANGED_EVENT` bridge. A failed refresh keeps the
  last good list.
- Picker: curated first, then discovered newest-first; without a search query
  each provider shows its 5 newest discovered models plus "N more — type to
  search".
- The summarizer and the key-test probe keep iterating curated `MODELS` only
  (a random cheap OpenRouter model must never become the summarizer).

## Placement

| Concern | Lives in |
|---|---|
| Decisions (temperature, caps, context, preserved thinking) | `src/modules/ai/config.ts` |
| Fetch + parse + filter per provider (pure parsers) | `src/modules/ai/lib/modelDiscovery.ts` |
| Persisted catalogue, refresh policy, registry sync | `src/modules/ai/lib/modelCatalog.ts` + `modelCatalog` pref in `settings/store.ts` |
| Translation to provider options | `taskRunner.ts` |
| Picker / Settings UI | `ModelPicker.tsx`, `ModelsSection.tsx` |

## Phases (one commit each)

1. Catalogue refresh: bump the v6-line provider SDKs, add/retire curated
   models, fix prices, preserved-thinking `drop_block`, tests.
2. Discovery engine: registry + `<provider>:<apiId>` ids + inference, per-
   provider fetch/parse, persisted catalogue, refresh triggers, tests.
3. UI: picker + Settings, driven with drive-ui.
4. Independent review, fix round, CLAUDE.md, delete this plan.

Default model stays `claude-sonnet-5` this release: Sonnet 5.5 shipped
2026-09-28 and can't be smoke-tested here without a key. Flip it next release.
