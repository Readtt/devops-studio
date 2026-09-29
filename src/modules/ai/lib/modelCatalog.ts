// Keeps the persisted model catalogue (preference `modelCatalog`) current: when
// to ask each provider for its model list again, and what to keep when one
// doesn't answer.
//
// The rules, each of which is a failure someone else's picker has had:
//
//   • A list is re-read after 12 h, when its key changes, or when the user asks
//     (Settings → Models → Check now). Not on every launch: nine providers ×
//     every app start is traffic for a list that changes a few times a month.
//   • A failed or EMPTY answer never replaces a good list. A 500, a timeout or
//     a provider having a bad minute would otherwise delete every model the
//     user can pick from that provider until the next check.
//   • A provider whose key was removed is dropped from the catalogue.
//
// Only the main window runs the automatic checks; Settings runs "Check now".
// Either window's write reaches the other through the preferences bridge.

import {
  DISCOVERABLE_PROVIDERS,
  type DiscoverableProvider,
  type ModelCatalog,
  type ProviderId,
} from "../config";
import { listProviderModels } from "./modelDiscovery";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setModelCatalog } from "@/modules/settings/store";

export const CATALOG_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export type Keys = Partial<Record<ProviderId, string | null>>;

export type RefreshOptions = {
  keys: Keys;
  /** Re-read these providers even if their list is fresh; `true` = all. */
  force?: boolean | readonly DiscoverableProvider[];
  now?: number;
  /** The network call, injectable for tests. */
  list?: (provider: DiscoverableProvider, key: string) => Promise<
    Awaited<ReturnType<typeof listProviderModels>>
  >;
};

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

/** The catalogue after one refresh pass. Returns `current` itself when nothing
 *  was due and nothing was dropped, so the caller can skip the write. */
export async function nextModelCatalog(
  current: ModelCatalog,
  opts: RefreshOptions,
): Promise<ModelCatalog> {
  const now = opts.now ?? Date.now();
  const list = opts.list ?? ((p, k) => listProviderModels(p, k));
  const next: ModelCatalog = { ...current };
  let changed = false;
  const due: { provider: DiscoverableProvider; key: string }[] = [];

  for (const provider of DISCOVERABLE_PROVIDERS) {
    const key = opts.keys[provider]?.trim();
    if (!key) {
      if (next[provider]) {
        delete next[provider];
        changed = true;
      }
      continue;
    }
    const forced =
      opts.force === true ||
      (Array.isArray(opts.force) && opts.force.includes(provider));
    const entry = current[provider];
    if (!forced && entry && now - entry.checkedAt < CATALOG_STALE_AFTER_MS) {
      continue;
    }
    due.push({ provider, key });
  }

  const results = await Promise.allSettled(
    due.map(({ provider, key }) => list(provider, key)),
  );
  due.forEach(({ provider }, i) => {
    const result = results[i];
    const prev = current[provider];
    changed = true;
    if (result.status === "fulfilled" && result.value.length > 0) {
      next[provider] = { checkedAt: now, fetchedAt: now, models: result.value };
      return;
    }
    next[provider] = {
      checkedAt: now,
      ...(prev?.fetchedAt ? { fetchedAt: prev.fetchedAt } : {}),
      models: prev?.models ?? [],
      error:
        result.status === "rejected"
          ? errorText(result.reason)
          : "The provider listed no models.",
    };
  });

  return changed ? next : current;
}

// One refresh at a time: two overlapping passes would each start from the same
// catalogue, and the later write would erase the earlier one's results.
let queue: Promise<unknown> = Promise.resolve();

/** Run a refresh pass and persist the result. */
export function refreshModelCatalog(
  opts: Omit<RefreshOptions, "now">,
): Promise<ModelCatalog> {
  const run = queue.then(async () => {
    const current = usePreferencesStore.getState().modelCatalog;
    const next = await nextModelCatalog(current, opts);
    if (next !== current) {
      // Local state first: the persisted write only echoes back through the
      // prefs event, and the next queued pass must start from this result.
      usePreferencesStore.setState({ modelCatalog: next });
      await setModelCatalog(next);
    }
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}
