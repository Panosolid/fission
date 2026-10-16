# Storage

Contents of `packages/storage`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- projects kept in the browser. `store.ts` (`projectStore(kv, readers, now)`: list, open, save, remove; each project is `project/<id>`, its exact .fission.json text, and `summary/<id>`, name and save time; open goes through `projectFromJson`) over the `KeyValue` interface in `key-value.ts` (`memoryKeyValue()` for unit tests); `indexeddb.ts` is the thin browser adapter, checked by `apps/fission/e2e/storage.mjs`; `localStore(readers)` is the two together; `autosave.ts` (`startAutosave`: saves a quiet moment after each `changed()`, one save in flight, reports "saving"/"saved"/error; tested on a fake clock). Workspaces call `ctx.projectChanged()` after writing `ctx.project`; the shell autosaves on it.
