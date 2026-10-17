// The A10 check (AI3): scores small free models, through Ollama, on the
// evaluation suite with the one command the assistant offers (set_part),
// the same prompt and the same constrained output the app uses. Writes a
// table (Markdown) and the full results (JSON). A measurement: it exits 0
// whatever the scores, and 1 only if it couldn't run.
//
//   node --experimental-strip-types packages/testing/scripts/ai-eval-ollama.ts <out.json> <model> [model…]
//
// OLLAMA_URL (default http://localhost:11434) says where Ollama listens.

import { writeFileSync } from "node:fs";
import { createProvider } from "@fission/ai";
import { DESIGN_COMMANDS } from "@fission/design";
import { EVAL_CASES, runEval, successRates, type EvalResult } from "../src/ai-eval.ts";

const [out, ...models] = process.argv.slice(2);
if (!out || models.length === 0) {
  console.error("usage: ai-eval-ollama.ts <out.json> <model> [model…]");
  process.exit(1);
}
const specs = DESIGN_COMMANDS.filter((c) => c.op === "set_part");
const ready = EVAL_CASES.filter((c) => !c.waitsFor);
const report: { model: string; seconds: number; rates: ReturnType<typeof successRates>; passed: number; firstTry: number; results: EvalResult[] }[] = [];

for (const model of models) {
  const provider = createProvider({ kind: "ollama", model, endpoint: process.env.OLLAMA_URL });
  const check = await provider.check();
  if (!check.ok) {
    console.error(`${model}: ${check.reason}`);
    process.exit(1);
  }
  const started = performance.now();
  const results = await runEval(provider, EVAL_CASES, specs);
  const seconds = (performance.now() - started) / 1000;
  report.push({ model, seconds, rates: successRates(results), passed: results.filter((r) => r.passed).length, firstTry: results.filter((r) => r.attempts === 1).length, results });
  for (const r of results) console.log(`${model}  ${r.passed ? "PASS" : "FAIL"}  ${r.id}  ${r.detail}`);
}

const pct = (x: number | undefined) => (x === undefined ? "–" : `${Math.round(x * 100)}%`);
const lines = [
  `### A10 check: ${ready.length} evaluation cases, set_part only`,
  "",
  "| Model | Right | Create | Edit | Usable first try | Time |",
  "|---|---|---|---|---|---|",
  ...report.map((r) => `| ${r.model} | ${r.passed}/${ready.length} | ${pct(r.rates.create)} | ${pct(r.rates["edit-parameter"])} | ${r.firstTry}/${ready.length} | ${r.seconds.toFixed(0)} s |`),
  "",
  "Wrong answers:",
  ...report.flatMap((r) => r.results.filter((x) => !x.passed).map((x) => `- ${r.model}, ${x.id}: ${x.detail}`)),
];
console.log(lines.join("\n"));
writeFileSync(out, JSON.stringify({ cases: ready.map((c) => c.id), report }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" });
