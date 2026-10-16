# AI assistant: progress

The AI workstream: `packages/ai`, the assistant panel (`apps/fission/src/assistant.ts`) and the AI items (A…) in `docs/roadmap.md`. Rules: `docs/ai.md`. Ben chose to build the first working assistant now (2026-10-16), ahead of step 32, with Design's one command `set_part`.

## AI1. Real providers (one PR)
- [x] AI1. Ollama, own API key (Anthropic, OpenAI, any OpenAI-compatible https address), in-browser (WebLLM on WebGPU, graphics-card check, download size) and the browser's built-in model behind `createProvider`; `detectProviders`; the key store filed by origin. Verified: `packages/ai` tests against a fake server (hand-worked request bodies, 0.9x/1.1x boundaries for the answer time limit and the graphics-card buffer, seeded random checks that keys only ever go to their own origin and never into a URL, body or error), and eight deliberate breaks, each caught.

## AI2. The panel drives Design (next)
- [ ] AI2. The assistant panel: choose a provider (with the key entry for API keys and what will be sent shown first), ask, see a preview of the change (a parameter diff of `set_part`: shape and sizes before and after), Accept as one "AI: …" undo step through `acceptCommands`, Reject leaves the project unchanged. Starting point: `apps/fission/src/assistant.ts` (placeholder today), Design's `run(command)` in `workspaces/design/src/workspace.ts` (not reachable from the shell yet: `MountedWorkspace` needs a `run?(command)`), `ctx.history.step`. Browser test with a fake provider (no network in CI).

## AI3. The A10 check, early
- [ ] AI3. Score two or three free models through Ollama on `EVAL_CASES` (`runEval`, `successRates`) in a GitHub Actions job (the cloud containers can't download models), and record the rates. Starting point: `packages/testing/src/ai-eval.ts`.
