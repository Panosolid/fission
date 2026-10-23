// The planted STEP fault for the oracle (step 29b3), as the kernel's tests
// plant it (kernel/tests/support/step_file.rs, `flip_first_face`): the
// first face's normal flipped, its ADVANCED_FACE's same_sense swapped, and
// nothing else changed. OpenCascade's checks (prototypes/oracle/compare.py,
// `step_issues`) must catch it in every body; golden/night.ts (fault
// "step") and fuzz/sketch-extrude.ts (FISSION_STEP_FAULT) plant it.

/** `step` with its first ADVANCED_FACE's same_sense swapped. Throws on a file without one, or a face line the writer doesn't write. */
export function flipFirstFace(step: string): string {
  const at = step.search(/= ADVANCED_FACE\(/);
  if (at < 0) throw new Error("no face to flip");
  const end = step.indexOf("\n", at);
  const line = step.slice(at, end < 0 ? undefined : end);
  const flipped = line.endsWith(",.T.);") ? line.slice(0, -5) + ".F.);" : line.endsWith(",.F.);") ? line.slice(0, -5) + ".T.);" : null;
  if (flipped === null) throw new Error(`an ADVANCED_FACE line the writer doesn't write: ${line}`);
  return step.slice(0, at) + flipped + (end < 0 ? "" : step.slice(end));
}
