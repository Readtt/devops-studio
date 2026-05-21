// Pared down to what the Generator (and future Claude Agent SDK engine in
// Phase 5) actually needs. The chat UI surface (AiInputBar, AiMiniWindow,
// AgentRunBridge, SelectionAskAi, etc.) was deleted in Phase 1B.
export {
  EMPTY_PROVIDER_KEYS,
  getAllKeys,
  getKey,
  setKey,
  clearKey,
  hasAnyKey,
  type ProviderKeys,
} from "./lib/keyring";
export {
  getActiveProviderKey,
  getOrCreateChat,
  hasKeyForModel,
  sendMessage,
  stop,
  useChatStore,
  type AgentMeta,
  type AgentRunStatus,
} from "./store/chatStore";
