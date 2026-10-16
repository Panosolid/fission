# The AI assistant

Fission's assistant is optional and costs the project nothing to run. Each user chooses where the model runs: in their browser, on their own computer with Ollama, through their own API key, or with their browser's built-in model if it has one. Every feature in Fission works without it, and it is off until the user picks a provider.

The assistant never creates geometry or data itself. It sends the same commands a user could, through the public command API, so every result is:

- built and validated by the kernel;
- previewed before anything changes;
- undoable as one step.

This page explains the architecture for contributors. The code is in `packages/ai`, plus `commands.ts` in core and `ai-eval.ts` in testing.

## Rules

- **Optional.** No feature may depend on the assistant.
- **Commands, not geometry.** The model's only output is a list of commands that must match JSON schemas generated from the real command API. References to geometry are stable ids, never coordinates the model guessed.
- **Preview, then one undo step.** Every action is shown first: ghosted geometry, highlighted changes, or a diff of parameters. The user accepts or rejects it. An accepted action becomes one labelled step in the normal history ("AI: added 5 mm hole"). A rejected one leaves the project exactly as it was.
- **Never a machine.** The assistant can prepare a print, laser or CNC job. It can never start a machine, send a job to one or control one. Sending needs a `HumanConfirmation` (`packages/core/src/model/machines.ts`), which only the confirmation screen creates when a person clicks Send.
- **Private by default.** With a local provider, nothing leaves the user's machine. Before the first request to a remote provider, the user is shown exactly what will be sent. The "AI" button in the top bar always shows which provider is active, or that the assistant is off.
- **Keys stay with the user.** API keys live only in the user's own browser storage (`keys.ts`). They are never put in the project file, never logged, and only sent to the provider they belong to. Consumer chat subscriptions can't be used, because providers only let programs connect with an API key.

## Providers (`providers.ts`)

`AIProvider` is the only interface the rest of the app sees:

- `check()` says whether the provider can run here. If it can't, it says what to try instead.
- `complete(request)` sends the request. The request can carry a JSON schema.
- `structuredOutput` says whether the provider can be held to that schema.

`PROVIDERS` describes the four options for the settings page:

| Provider | Where it runs | Notes |
|---|---|---|
| In your browser | the user's GPU through WebGPU | The default local option. The model is downloaded once, after its size is shown. Weak GPUs get a suggestion to use another provider, not a failure. |
| Ollama | the user's own computer | Ollama must allow the page: set `OLLAMA_ORIGINS` to Fission's address. |
| Your own API key | the provider (Anthropic, OpenAI or others) | The user pays for their own usage, and is shown what will be sent first. |
| Browser built-in | the browser | Offered only when the browser has a built-in model. |

`createProvider`, `detectProviders` and the key store are placeholders for now.

## How a workspace exposes its commands

A workspace lists its commands on its plugin (`WorkspacePlugin.commands`). Each command is a `CommandSpec`: an `op`, a one-line summary, and typed parameters:

- `length`: millimetres, finite and greater than 0. The kernel then checks the modelling range.
- `number`, with optional limits.
- `choice`, from a list of values.
- `text`, with a maximum length.
- `reference`, to a body, face, edge or feature, by stable id.

Core turns these specs into the JSON schemas the model is held to (`commandSchema`, `commandListSchema`). Every answer then goes through `parseCommand` or `parseCommandList`, which never throw. A bad answer is a clear error message.

```ts
// workspaces/design/src/commands.ts
export const DESIGN_COMMANDS: readonly CommandSpec[] = [
  { op: "set_part", summary: "Make the part a shape of these sizes …",
    params: { shape: { type: "choice", values: SHAPES, description: "which shape" },
              width: { type: "length", description: "width, or diameter …" }, … } },
];
```

The panel and the assistant reach the same result through these commands (`documentFor`). When the timeline arrives (step 32), Design adds a command per feature type, such as `hole` or `extrude`, using references to faces by stable id.

## One request, start to finish

1. **Context** (`context.ts`). `buildContext` summarises the project for the model, never as raw geometry:
   - the active workspace and the units;
   - the selection, by stable id with its intent;
   - every timeline feature, with its intent and parameters;
   - the materials;
   - recent errors;
   - the relevant part of the dependency graph: what is out of date, and what depends on the selection.

   The `"small"` level fits small local models. `"large"` gives more.
2. **Ask** (`commands.ts`). `askForCommands` uses the schema as constrained output where the provider supports it, and otherwise puts the schema in the instructions. It checks the answer. If the answer is bad, it retries once and tells the model what was wrong. After a second bad answer it fails clearly with "… Nothing was changed."
3. **Preview and decide** (`actions.ts`, draft). `proposeAction(commands)` builds the result off to the side, shows it, and then either accepts it as one undo step or rejects it, leaving the project unchanged. This needs undo (step 20) and the timeline (step 32).

## Specialist models (`specialists.ts`)

These are small single-purpose models that run locally with ONNX Runtime Web on WebGPU. They are separate from the language model:

- background removal, segmentation, upscaling and inpainting (Image);
- tracing images to paths (Vector, Laser);
- print-failure classification from photos (Slice, later).

Each one is downloaded on first use, after its size is shown. They are placeholders for now.

## What the assistant will do in each workspace (`features.ts`)

`AI_FEATURES` lists the plans for each workspace, plus suite-wide ones such as "what breaks if I change this?", which uses the dependency graph. The assistant panel shows the list for the active workspace. A workspace's AI features come after that workspace is real. Design comes first, after step 32.

## Testing

- **Command fuzzing.** `packages/testing/test/command-fuzz.test.ts` and `journeys/command-fuzz.journey.ts` check that random and malformed commands and answer texts always give a clean error or a valid command. Valid ones are built on the real kernel, which must return a valid body or a clean error.
- **Evaluation** (`packages/testing/src/ai-eval.ts`). `EVAL_CASES` holds fixed prompts, each with a project state and the expected commands. `runEval` scores any provider, and `successRates` gives the rate for each task type, which is tracked over time like the fuzzer's metrics. Cases that need commands not built yet name what they wait for.
- **Still to come** (with steps 20 and 32): tests that an accepted action is exactly one undo step, and that a rejected preview leaves the project unchanged.
