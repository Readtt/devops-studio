// Keeps the live model catalogue current: when to ask each provider for its
// model list again, and what to keep when one doesn't answer.
//
// The rules, each of which is a failure someone else's picker has had:
//
//   • A list is re-read 12 h after it last came back, when its key changes, or
//     when the user asks (Settings → Models → Check now). Not on every launch:
//     nine providers × every app start is traffic for a list that changes a
//     few times a month.
//   • A failed or EMPTY answer never replaces a good list. A 500, a timeout or
//     a provider having a bad minute would otherwise delete every model the
//     user can pick from that provider until the next check. A failure is
//     retried an hour later rather than twelve — a laptop that started before
//     its network did shouldn't wait half a day for its lists.
//   • A provider leaves the catalogue only when its key is removed. A key that
//     merely didn't load (a locked keychain reads as "no keys") must not wipe
//     every list.
//
// Only the main window runs checks and writes (see modelCatalogStore.ts).

import {
  DISCOVERABLE_PROVIDERS,
  type DiscoverableProvider,
  type ModelCatalog,
  type ProviderId,
} from "../config";
import { listProviderModels } from "./modelDiscovery";
import {
  saveModelCatalog,
  useModelCatalogStore,
} from "../store/modelCatalogStore";

export const CATALOG_STALE_AFTER_MS = 12 * 60 * 60 * 1000;
export const CATALOG_RETRY_FAILED_AFTER_MS = 60 * 60 * 1000;

export type Keys = Partial<Record<ProviderId, string | null>>;

export type RefreshOptions = {
  keys: Keys;
  /** Re-read these providers even if their list is fresh; `true` = all. */
  force?: boolean | readonly DiscoverableProvider[];
  /** Providers whose key was removed: their lists leave the catalogue. */
  drop?: readonly DiscoverableProvider[];
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

function isDue(
  entry: ModelCatalog[DiscoverableProvider],
  forced: boolean,
  now: number,
): boolean {
  if (forced || !entry) return true;
  if (entry.error && now - entry.checkedAt < CATALOG_RETRY_FAILED_AFTER_MS) {
    return false;
  }
  return !entry.fetchedAt || now - entry.fetchedAt >= CATALOG_STALE_AFTER_MS;
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
    if (opts.drop?.includes(provider)) {
      if (next[provider]) {
        delete next[provider];
        changed = true;
      }
      continue;
    }
    const key = opts.keys[provider]?.trim();
    if (!key) continue;
    const forced =
      opts.force === true ||
      (Array.isArray(opts.force) && opts.force.includes(provider));
    if (isDue(current[provider], forced, now)) due.push({ provider, key });
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

// One pass at a time: two overlapping passes would each start from the same
// catalogue, and the later write would erase the earlier one's results.
let queue: Promise<unknown> = Promise.resolve();

/** Run a refresh pass and persist the result. Main window only. */
export function refreshModelCatalog(
  opts: Omit<RefreshOptions, "now">,
): Promise<ModelCatalog> {
  const run = queue.then(async () => {
    const current = useModelCatalogStore.getState().catalog;
    const next = await nextModelCatalog(current, opts);
    if (next !== current) await saveModelCatalog(next);
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** A failed check's reason in plain words, for Settings. */
export function describeListError(error: string): string {
  if (/HTTP 40[13]/.test(error)) return "it refused the key";
  if (/HTTP 429/.test(error)) return "it was rate-limiting requests";
  if (/HTTP 5\d\d/.test(error)) return "it had a server error";
  if (/HTTP \d{3}/.test(error)) return "it answered with an error";
  if (/Timed out/.test(error)) return "it didn't answer in time";
  if (/listed no models|wasn't a model list/.test(error)) {
    return "its answer had no models in it";
  }
  return "it couldn't be reached";
}
