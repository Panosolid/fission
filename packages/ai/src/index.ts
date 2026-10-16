// @fission/ai: the optional AI assistant. Architecture and placeholders;
// see docs/ai.md. Nothing here talks to a model yet, and nothing is sent anywhere.
export { createProvider, dataLeavesMachine, detectProviders, PROVIDERS, type AIProvider, type AIProviderKind, type AIRequest, type ApiVendor, type ProviderInfo, type ProviderSettings } from "./providers.ts";
export { browserKeyStore, type ApiKeyStore } from "./keys.ts";
export { askForCommands, type AskResult } from "./commands.ts";
export { proposeAction, type AIAction, type ParameterChange, type Preview } from "./actions.ts";
export { buildContext, type AIContext, type ContextOptions } from "./context.ts";
export { loadSpecialist, SPECIALISTS, type SpecialistInfo, type SpecialistModel, type SpecialistTask } from "./specialists.ts";
export { AI_FEATURES } from "./features.ts";
