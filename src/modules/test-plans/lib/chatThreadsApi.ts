// TS wrappers around the Rust SQLite-backed chat thread store.
// One auto-saved thread per (planId, suiteId) — the messages array is
// passed through as an opaque JSON blob so schema drift on the TS message
// shape doesn't force a Rust-side migration.

import { invoke } from "@tauri-apps/api/core";
import type { ModelId } from "@/modules/ai/config";
import type { SuiteChatMessage } from "./runSuiteChat";

export type StoredChatThread = {
  planId: number;
  suiteId: number;
  modelId: ModelId | null;
  messages: SuiteChatMessage[];
  updatedAt: string;
};

type RawThread = {
  planId: number;
  suiteId: number;
  modelId: string | null;
  messages: string;
  updatedAt: string;
};

export async function saveChatThread(input: {
  planId: number;
  suiteId: number;
  modelId: ModelId | null;
  messages: SuiteChatMessage[];
}): Promise<void> {
  await invoke("chat_threads_save", {
    input: {
      planId: input.planId,
      suiteId: input.suiteId,
      modelId: input.modelId ?? null,
      messages: JSON.stringify(input.messages),
      updatedAt: new Date().toISOString(),
    },
  });
}

export async function getChatThread(input: {
  planId: number;
  suiteId: number;
}): Promise<StoredChatThread | null> {
  const raw = await invoke<RawThread | null>("chat_threads_get", { input });
  if (!raw) return null;
  return parseRaw(raw);
}

export async function deleteChatThread(input: {
  planId: number;
  suiteId: number;
}): Promise<void> {
  await invoke("chat_threads_delete", { input });
}

export async function listChatThreads(): Promise<StoredChatThread[]> {
  const raw = await invoke<RawThread[]>("chat_threads_list");
  return raw.map(parseRaw);
}

function parseRaw(raw: RawThread): StoredChatThread {
  let messages: SuiteChatMessage[] = [];
  try {
    const parsed = JSON.parse(raw.messages);
    if (Array.isArray(parsed)) messages = parsed as SuiteChatMessage[];
  } catch {
    // Corrupt or older shape — start with an empty thread rather than
    // crashing the pane. The user can re-send and overwrite cleanly.
  }
  return {
    planId: raw.planId,
    suiteId: raw.suiteId,
    modelId: (raw.modelId as ModelId | null) ?? null,
    messages,
    updatedAt: raw.updatedAt,
  };
}
