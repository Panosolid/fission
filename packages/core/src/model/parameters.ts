// DRAFT: parameters that drive everything (I18). User parameters (step
// 34) live in the project, not in Design, so every workspace can read
// them and some can write them:
// - Laser: material thickness and kerf drive slot and finger-joint widths
// - Simulate: sweep a parameter ("thinnest wall with safety factor ≥ 2")
// - Circuit: the board size follows an enclosure parameter
// A change goes through the dependency graph like any other edit.

export interface Parameter {
  name: string;
  /** e.g. "3 mm", "thickness + kerf". */
  expression: string;
  /** Unit of the result, e.g. "mm", "deg", "" for a plain number. */
  unit: string;
}

/** A sweep: rebuild and rerun for each value, keeping the results side by side. */
export interface ParameterSweep {
  parameter: string;
  values: string[];
  /** e.g. "minimum safety factor", read from a Data representation. */
  measure: string;
}

export interface ProjectParameters {
  list(): Parameter[];
  set(name: string, expression: string): void;
  /** The value in mm (or degrees), after evaluating expressions. */
  value(name: string): number;
}

/** The project's parameters. Not implemented yet (step 55). */
export function projectParameters(): ProjectParameters {
  throw new Error("not implemented");
}
