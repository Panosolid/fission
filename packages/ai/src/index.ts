// @fission/ai: the optional AI assistant; see docs/ai.md. Nothing is sent
// anywhere until the user picks a provider.
export { createProvider, dataLeavesMachine, detectProviders, inBrowserDownloadSize, PROVIDERS, type AIProvider, type AIProviderKind, type AIRequest, type ApiVendor, type ProviderDeps, type ProviderInfo, type ProviderSettings } from "./providers.ts";
export { browserKeyStore, checkApiKey, memoryKeyStore, MAX_KEY_LENGTH, type ApiKeyStore, type KeyValueStorage } from "./keys.ts";
export { ANSWER_TIMEOUT_MS, CHECK_TIMEOUT_MS, type Fetch } from "./http.ts";
export { apiOrigin, DEFAULT_MODELS, otherEndpoint, VENDOR_ORIGINS } from "./hosted.ts";
export { OLLAMA_ENDPOINT } from "./ollama.ts";
export { gpuCanRun, IN_BROWSER_MODEL, inBrowserDownloadBytes, type BuiltInModelLike, type GpuLike, type WebLLMLike, type WebLLMModel } from "./local.ts";
export { askForCommands, type AskResult } from "./commands.ts";
export { acceptCommands, AI_LABEL, proposeAction, type AIAction, type ParameterChange, type Preview, type ProposeOptions } from "./actions.ts";
export { systemPrompt } from "./prompt.ts";
export { buildContext, type AIContext, type ContextOptions } from "./context.ts";
export { loadSpecialist, SPECIALISTS, type SpecialistInfo, type SpecialistModel, type SpecialistTask } from "./specialists.ts";
export { AI_FEATURES } from "./features.ts";
