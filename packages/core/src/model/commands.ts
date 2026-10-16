// The command API: the actions a user can take, described as data. Each
// workspace lists its commands (WorkspacePlugin.commands); the AI
// assistant gets JSON schemas generated from these same descriptions, and
// everything it sends back goes through parseCommand before anything is
// built. So the AI can only do what a user could, and malformed output is
// a clean error, never broken geometry.

/** One parameter of a command. References are stable ids, never coordinates. */
export type ParamSpec = { description: string; optional?: boolean } & (
  | { type: "length" } // mm, finite, > 0; the kernel then checks its modelling range
  | { type: "number"; min?: number; max?: number }
  | { type: "choice"; values: readonly string[] }
  | { type: "text"; maxLength: number }
  | { type: "reference"; to: "body" | "face" | "edge" | "feature" }
);

export interface CommandSpec {
  op: string;
  /** One line, for people and for the model. */
  summary: string;
  params: Record<string, ParamSpec>;
}

export interface Command {
  op: string;
  [param: string]: unknown;
}

export type Parsed = { ok: true; command: Command } | { ok: false; error: string };

function paramSchema(p: ParamSpec): object {
  const description = p.description;
  switch (p.type) {
    case "length":
      return { type: "number", exclusiveMinimum: 0, description: `${description} (mm)` };
    case "number":
      return { type: "number", ...(p.min !== undefined && { minimum: p.min }), ...(p.max !== undefined && { maximum: p.max }), description };
    case "choice":
      return { type: "string", enum: [...p.values], description };
    case "text":
      return { type: "string", maxLength: p.maxLength, description };
    case "reference":
      return { type: "string", description: `${description} (stable id of a ${p.to}; never coordinates)` };
  }
}

/** A JSON schema for one command, generated from its description. */
export function commandSchema(spec: CommandSpec): object {
  const required = ["op", ...Object.entries(spec.params).filter(([, p]) => !p.optional).map(([k]) => k)];
  return {
    type: "object",
    description: spec.summary,
    properties: { op: { const: spec.op }, ...Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, paramSchema(p)])) },
    required,
    additionalProperties: false,
  };
}

/** The schema for a list of commands, any of these specs: what the model must answer with. */
export function commandListSchema(specs: readonly CommandSpec[]): object {
  return { type: "object", properties: { commands: { type: "array", items: { oneOf: specs.map(commandSchema) } } }, required: ["commands"], additionalProperties: false };
}

const show = (v: unknown) => {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 40)}…` : s;
  } catch {
    return String(v);
  }
};

function checkParam(name: string, p: ParamSpec, v: unknown): string | null {
  switch (p.type) {
    case "length":
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? null : `${name} must be a length in mm greater than 0, got ${show(v)}`;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `${name} must be a number, got ${show(v)}`;
      if (p.min !== undefined && v < p.min) return `${name} must be at least ${p.min}, got ${v}`;
      if (p.max !== undefined && v > p.max) return `${name} must be at most ${p.max}, got ${v}`;
      return null;
    case "choice":
      return typeof v === "string" && p.values.includes(v) ? null : `${name} must be one of ${p.values.join(", ")}, got ${show(v)}`;
    case "text":
      return typeof v === "string" && v.length <= p.maxLength ? null : `${name} must be text of at most ${p.maxLength} characters`;
    case "reference":
      return typeof v === "string" && v.length > 0 && v.length <= 200 ? null : `${name} must be the stable id of a ${p.to}, got ${show(v)}`;
  }
}

/** Checks untrusted input (e.g. a model's answer) against the commands. Never throws. */
export function parseCommand(raw: unknown, specs: readonly CommandSpec[]): Parsed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: `a command must be an object, got ${show(raw)}` };
  const obj = raw as Record<string, unknown>;
  const spec = specs.find((s) => s.op === obj.op);
  if (!spec) return { ok: false, error: `unknown command ${show(obj.op)}; known: ${specs.map((s) => s.op).join(", ")}` };
  for (const key of Object.keys(obj)) if (key !== "op" && !(key in spec.params)) return { ok: false, error: `${spec.op} has no parameter ${show(key)}` };
  for (const [name, p] of Object.entries(spec.params)) {
    if (!(name in obj) || obj[name] === undefined) {
      if (p.optional) continue;
      return { ok: false, error: `${spec.op} needs ${name}` };
    }
    const problem = checkParam(name, p, obj[name]);
    if (problem) return { ok: false, error: `${spec.op}: ${problem}` };
  }
  return { ok: true, command: { ...obj, op: spec.op } };
}

/** Parses a model's whole answer: JSON text holding { "commands": [...] }. Never throws. */
export function parseCommandList(text: string, specs: readonly CommandSpec[]): { ok: true; commands: Command[] } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "the answer is not JSON" };
  }
  const list = (data as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(list)) return { ok: false, error: 'the answer must be an object with a "commands" list' };
  if (list.length > 50) return { ok: false, error: "too many commands in one answer (at most 50)" };
  const commands: Command[] = [];
  for (const [i, raw] of list.entries()) {
    const parsed = parseCommand(raw, specs);
    if (!parsed.ok) return { ok: false, error: `command ${i + 1}: ${parsed.error}` };
    commands.push(parsed.command);
  }
  return { ok: true, commands };
}
