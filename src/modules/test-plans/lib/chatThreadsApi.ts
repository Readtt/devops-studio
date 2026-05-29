// TS wrappers around the Rust SQLite-backed chat thread store.
//
// Each thread is identified by `(planId, suiteId, threadId)`. v1 of the store
// only allowed one thread per suite — that thread is migrated forward with
// the literal id `"default"`. New threads get UUID-derived ids minted on the
// TS side; the Rust layer doesn't care about the id format, it just keys on
// the string.

import { invoke } from "@tauri-apps/api/core";
import type { ModelId } from "@/modules/ai/config";
import type { SuiteChatMessage } from "./runSuiteChat";

/** Thread id assigned by the v1→v2 migration to threads that had no id.
 *  Components MAY use this when no other thread id is known yet. */
export const DEFAULT_THREAD_ID = "default";

export type StoredChatThread = {
  planId: number;
  suiteId: number;
  threadId: string;
  title: string | null;
  modelId: ModelId | null;
  messages: SuiteChatMessage[];
  updatedAt: string;
};

type RawThread = {
  planId: number;
  suiteId: number;
  threadId: string;
  title: string | null;
  modelId: string | null;
  messages: string;
  updatedAt: string;
};

export async function saveChatThread(input: {
  planId: number;
  suiteId: number;
  threadId: string;
  title: string | null;
  modelId: ModelId | null;
  messages: SuiteChatMessage[];
}): Promise<void> {
  await invoke("chat_threads_save", {
    input: {
      planId: input.planId,
      suiteId: input.suiteId,
      threadId: input.threadId,
      title: input.title,
      modelId: input.modelId ?? null,
      messages: JSON.stringify(input.messages),
      updatedAt: new Date().toISOString(),
    },
  });
}

export async function getChatThread(input: {
  planId: number;
  suiteId: number;
  threadId: string;
}): Promise<StoredChatThread | null> {
  const raw = await invoke<RawThread | null>("chat_threads_get", { input });
  if (!raw) return null;
  return parseRaw(raw);
}

export async function deleteChatThread(input: {
  planId: number;
  suiteId: number;
  threadId: string;
}): Promise<void> {
  await invoke("chat_threads_delete", { input });
}

/** Drop every thread under a (planId, suiteId). */
export async function deleteChatThreadsForSuite(input: {
  planId: number;
  suiteId: number;
}): Promise<void> {
  await invoke("chat_threads_delete_suite", { input });
}

export async function listChatThreads(): Promise<StoredChatThread[]> {
  const raw = await invoke<RawThread[]>("chat_threads_list");
  return raw.map(parseRaw);
}

/** Threads under a specific (planId, suiteId), newest-updated first. Used
 *  by the suite-chat header's thread switcher. */
export async function listChatThreadsForSuite(input: {
  planId: number;
  suiteId: number;
}): Promise<StoredChatThread[]> {
  const raw = await invoke<RawThread[]>("chat_threads_list_for_suite", {
    input,
  });
  return raw.map(parseRaw);
}

function parseRaw(raw: RawThread): StoredChatThread {
  let messages: SuiteChatMessage[] = [];
  try {
    const parsed = JSON.parse(raw.messages);
    if (Array.isArray(parsed)) messages = parsed as SuiteChatMessage[];
  } catch (e) {
    // Corrupt or older shape — start with an empty thread rather than
    // crashing the pane. The user can re-send and overwrite cleanly. Log it so
    // a corrupted row is diagnosable instead of silently looking empty.
    console.warn(
      `[suite-chat] could not parse stored messages for thread ${raw.threadId}:`,
      e,
    );
  }
  return {
    planId: raw.planId,
    suiteId: raw.suiteId,
    threadId: raw.threadId,
    title: raw.title,
    modelId: (raw.modelId as ModelId | null) ?? null,
    messages,
    updatedAt: raw.updatedAt,
  };
}

/** Generate a fresh thread id. URL-safe and easy to debug in SQLite. */
export function newThreadId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `t-${stamp}-${rand}`;
}
