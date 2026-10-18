# The AI assistant

Panoshape's assistant is optional and costs the project nothing to run. Each user chooses where the model runs: in their browser, on their own computer with Ollama, through their own API key, or with their browser's built-in model if it has one. Every feature in Panoshape works without it, and nothing is looked for or sent until the user opens the assistant panel. The first time it is opened, with no choice ever made, it picks an AI that runs on the user's own computer if one is found (the browser's built-in model, then Ollama if the user looked for it and it answered, then the in-browser model, whose download is still confirmed with its size first); it never picks an API key, which costs the user money. Choosing Off is remembered.

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
| Ollama | the user's own computer | Ollama must allow the page: set `OLLAMA_ORIGINS` to Panoshape's address. |
| Your own API key | the provider (Anthropic, OpenAI or others) | The user pays for their own usage, and is shown what will be sent first. |
| Browser built-in | the browser | Offered only when the browser has a built-in model. |

`createProvider(settings)` makes one; `detectProviders()` says which can run in this browser and why the others can't (the panel greys those out with the reason; Ollama is asked only when the user presses Look for Ollama or already uses it, because a web page asking an address on the user's computer logs an error when nothing listens and can make the browser ask for local network access, and it is listed only once it answers); `pickLocal` chooses among them. `listModels` gives the models to choose from (what Ollama has pulled, what an API key's provider lists for it); a typed name is always the fallback. `vendorFromKey` names a pasted key's provider only from a prefix that one company uses (a bare `sk-` is never guessed, so a key can't be sent to the wrong company); listing models sends only the key, to its own provider, and the key box says so before it is saved. How each one talks to its model:

- **Ollama** (`ollama.ts`): `POST /api/chat` with the schema as `format` and temperature 0. If Ollama can't be reached, the check names `OLLAMA_ORIGINS`.
- **Your own API key** (`hosted.ts`): Anthropic's Messages API, with the schema enforced as the one tool the model must use; OpenAI's Chat Completions with `response_format`; or any OpenAI-compatible address the user gives (https only, or http to their own computer), whose answers are validated and retried instead.
- **In your browser** (`local.ts`): WebLLM on WebGPU. The graphics-card check (WebGPU, an adapter, 16-bit shaders for f16 models, buffers of 128 MiB for small models and 1 GiB for others) runs before anything downloads; the download size is read from the model's file list first. The default model is `IN_BROWSER_MODEL` until the A10 check picks one.
- **Browser built-in** (`local.ts`): the browser's `LanguageModel`, with the schema as its response constraint.

Keys (`keys.ts`) are filed under the origin they are sent to, so a key can only be read for that one host; changing a custom address finds no key. Every request goes through `http.ts`: a time limit, no cookies, no referrer, and error messages with the key blanked out.

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

The panel and the assistant reach the same result through these commands (`documentFor`). When the timeline arrives (step 24), Design adds a command per feature type, such as `hole` or `extrude`, using references to faces by stable id.

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
3. **Preview and decide** (`actions.ts`). `proposeAction(commands, …)` shows what would change (until the timeline, step 24, a diff of parameters before and after; ghosted geometry and highlights come with stable ids), and then either accepts it as one undo step (`acceptCommands`, through the workspace's own `run`) or rejects it, leaving the project unchanged. An accept after the project changed since the preview is refused. The panel (`apps/fission/src/assistant.ts`) does this for Design's `set_part`; `systemPrompt` (`prompt.ts`) is the one instruction text, shared with the evaluation.

## Specialist models (`specialists.ts`)

These are small single-purpose models that run locally with ONNX Runtime Web on WebGPU. They are separate from the language model:

- background removal, segmentation, upscaling and inpainting (Image);
- tracing images to paths (Vector, Laser);
- print-failure classification from photos (Slice, later).

Each one is downloaded on first use, after its size is shown. They are placeholders for now.

## What the assistant will do in each workspace (`features.ts`)

`AI_FEATURES` lists the plans for each workspace, plus suite-wide ones such as "what breaks if I change this?", which uses the dependency graph. The assistant panel shows the list for the active workspace. A workspace's AI features come after that workspace is real. Design comes first, after step 24.

## Testing

- **Command fuzzing.** `packages/testing/test/command-fuzz.test.ts` and `journeys/command-fuzz.journey.ts` check that random and malformed commands and answer texts always give a clean error or a valid command. Valid ones are built on the real kernel, which must return a valid body or a clean error.
- **Evaluation** (`packages/testing/src/ai-eval.ts`). `EVAL_CASES` holds fixed prompts, each with a project state and the expected commands. `runEval` scores any provider, and `successRates` gives the rate for each task type, which is tracked over time like the fuzzer's metrics. Cases that need commands not built yet name what they wait for.
- **Preview and undo.** `packages/ai/test/propose.test.ts` checks that an accepted action is exactly one undo step and a rejected or stale one leaves the project unchanged; `apps/fission/e2e/assistant.mjs` checks the same in the browser, with the model's answers stood in by the test.

## Panoshape's own model (planned, starts after step 24)

Users can bring any provider in the table above. Panoshape will also ship a model of its own: a small one that runs on the user's device and is held to the rules below. It is one more entry in `PROVIDERS`, so nothing else in the app changes when it arrives.

### Why it exists

The point is to let anyone drive Panoshape in plain English, for free, without their designs leaving their computer. A general model has to know everything. This one only has to know Panoshape's commands, which is why it can be small: 0.5 to 1.5 billion parameters, about 300 MB to 1 GB to download after quantising it to 4 bits.

If an existing open model already passes the evaluation gate (phase 1 below) without training, Panoshape ships that model instead and trains nothing. Having a model of our own is a fallback for quality, not a goal in itself.

### Rules for Panoshape's model

These rules are in addition to the ones at the top of this page.

1. **Training is the user's choice.** A switch decides whether a user's data may help train the model. It is off by default, and turning it off also deletes anything already shared. Only command examples are ever sent: the request text, the proposed commands, and whether they were accepted. Geometry and files are never sent. Training is an automatic pipeline with no human review step. Sending something for a person to look at, such as a bug report, is a separate button the user clicks.
2. **Free with no limits.** It runs on the user's own hardware, so it costs the project nothing to run.
3. **It never changes behind the user's back.** It is a file on the user's machine and works offline. It updates only when the user chooses, and old versions stay downloadable. Each model is labelled with the command API version it learned.
4. **Mistakes are caught.** A model can still be wrong. The rules at the top of this page (commands only, kernel validation, preview, one undo step, never a machine) mean a wrong answer costs a rejected preview, not a broken project.
5. **Full working out.** It explains its reasoning in plain words first, for example: "the top face is F12, its centre is at x 20 y 15, so the hole goes there". The commands follow, then the kernel's checks. The user can edit the commands before accepting them.
6. **Open.** The model weights, the training scripts and the generated training data are open source, like the rest of Panoshape.
7. **Honest and concise.** No flattery or padding. Claims carry evidence ("this wall is 0.8 mm and your nozzle is 0.4 mm").
8. **Small.** It runs on hardware the user already owns. On a computer too weak for it, the assistant is simply unavailable, and every feature still works without it.

### How it is made

- **Base model.** Start from the best small open model available when work begins. Its licence must let us modify it and give it away for free.
- **Fine-tuning, not pretraining.** Pretraining a model from scratch at a useful size costs hundreds of thousands of dollars. Instead, LoRA (a cheap kind of fine-tuning that trains a small add-on to the model) teaches the base model Panoshape's commands. One run takes hours on a single GPU, which is free on hosted notebook tiers or costs tens of dollars rented.
- **Training data is generated and checked.** A script samples random valid commands from every workspace's `CommandSpec` list, using the same machinery as the command fuzzer. Each command is built on the real kernel, and only commands that produce a valid result are kept. The English side of each example comes from templates, plus paraphrases from a model whose terms allow that use. Opted-in user examples (rule 1) are added once a server for them exists; it is the same open question as in `community.md`.
- **Evaluation.** The model is scored with `runEval` on `EVAL_CASES`, plus a larger held-out set written by hand that never comes from the data generator. Four rates are reported per task type: valid on the first try, exactly the intended command, the right stable id, and needing the retry. It ships only if it clearly beats the untrained base model.
- **Delivered** in two formats: one for the in-browser provider (WebGPU) and one for Ollama. The download is hosted for free, and the size is shown before it starts.
- **Kept apart.** The generator lives in `training/` for now, ready to move to a repository of its own: nothing in the app imports it, and the training scripts will live beside it. Its tests are quick, so CI runs them.

### Phases

The roadmap tracks these as A10 to A13.

- **A10, the gate** (with A7, after step 24). Score two or three off-the-shelf small models through Ollama on the evaluation suite, using constrained output. If one is good enough, it becomes the in-browser default and the phases stop here.
- **A11, the data generator.** Only if A10 falls short.
- **A12, the training runs.** Free tiers first, with a cap of about 100 US dollars until the model ships.
- **A13, shipping.** "Panoshape model" joins `PROVIDERS` and becomes the default only if it wins on the evaluations. From then on, it is retrained as each workspace adds commands (A8). A retrain is a rerun of the scripts, not a new project.

### Guardrails for the main project

- No work on this starts before step 24. There are no commands worth teaching until then.
- The CAD roadmap always comes first, and the work runs in one thread at a time.
- Check the base model's licence and the source of all training data before training, not after.
