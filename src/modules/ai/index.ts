// Public surface of the AI module: provider keyring + the model/key store the
// four read-only BYOK surfaces (Generator, Suite Chat, Code Review, Confidence)
// share.
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
  hasKeyForModel,
  useChatStore,
} from "./store/chatStore";
