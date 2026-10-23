import { writeFileSync } from "node:fs";
import { emptyProject, projectToJson } from "@fission/core";
export const save = (name: string, file: string, doc: unknown) => {
  const p = emptyProject(name);
  p.workspaces.design = doc as never;
  writeFileSync(`${process.argv[2]}/${file}`, projectToJson(p));
};
