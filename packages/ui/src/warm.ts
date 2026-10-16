// Warm workspaces (X7, docs/integration.md principle 10): a workspace is
// mounted the first time it is shown in a pane and kept after that. Switching
// away puts it to sleep and switching back wakes it, so a switch builds
// nothing and loses nothing. This is the bookkeeping only; the shell says
// what mounting, sleeping, waking and unmounting do on screen.

/** What the pool asks of the shell for one workspace in one pane. */
export interface WarmHooks<Id extends string, Pane extends string, T> {
  mount(pane: Pane, id: Id): T;
  sleep(pane: Pane, id: Id, instance: T): void;
  wake(pane: Pane, id: Id, instance: T): void;
  /** Only ever called on a sleeping instance. */
  unmount(pane: Pane, id: Id, instance: T): void;
}

interface Warm<Pane, T> {
  pane: Pane;
  instance: T;
}

/**
 * At most one instance of each workspace, living in one pane; each pane shows
 * at most one workspace, which is awake, and every other instance sleeps.
 * A workspace asked for in another pane than the one it lives in is unmounted
 * there and mounted afresh (each pane has its own slots and viewport).
 */
export class WarmPool<Id extends string, Pane extends string, T> {
  private readonly warm = new Map<Id, Warm<Pane, T>>();
  private readonly shown = new Map<Pane, Id>();

  private readonly hooks: WarmHooks<Id, Pane, T>;

  constructor(hooks: WarmHooks<Id, Pane, T>) {
    this.hooks = hooks;
  }

  /** The workspace on screen in `pane`, if any. */
  showing(pane: Pane): Id | null {
    return this.shown.get(pane) ?? null;
  }

  /** The instance on screen in `pane` (awake), if any. */
  awake(pane: Pane): T | null {
    const id = this.shown.get(pane);
    return id === undefined ? null : this.warm.get(id)!.instance;
  }

  /** The pane workspace `id` lives in (awake or asleep), if it is mounted. */
  paneOf(id: Id): Pane | null {
    return this.warm.get(id)?.pane ?? null;
  }

  /** Shows `id` in `pane`: wakes it if it sleeps there, else mounts it; whatever `pane` showed goes to sleep. */
  show(pane: Pane, id: Id): T {
    if (this.shown.get(pane) === id) return this.warm.get(id)!.instance;
    this.hide(pane);
    const held = this.warm.get(id);
    if (held && held.pane === pane) {
      this.shown.set(pane, id);
      this.hooks.wake(pane, id, held.instance);
      return held.instance;
    }
    if (held) this.forget(id);
    const instance = this.hooks.mount(pane, id);
    this.warm.set(id, { pane, instance });
    this.shown.set(pane, id);
    return instance;
  }

  /** Puts what `pane` shows to sleep; the pane then shows nothing (Community, a closed split). */
  hide(pane: Pane): void {
    const id = this.shown.get(pane);
    if (id === undefined) return;
    this.shown.delete(pane);
    this.hooks.sleep(pane, id, this.warm.get(id)!.instance);
  }

  /** Unmounts `id` wherever it lives (asleep first if it is on screen). */
  forget(id: Id): void {
    const held = this.warm.get(id);
    if (!held) return;
    if (this.shown.get(held.pane) === id) this.hide(held.pane);
    this.warm.delete(id);
    this.hooks.unmount(held.pane, id, held.instance);
  }

  /** Unmounts every workspace living in `pane` (its viewport is going away). */
  forgetPane(pane: Pane): void {
    for (const [id, held] of [...this.warm]) if (held.pane === pane) this.forget(id);
  }

  /** Unmounts everything (another project opened). */
  forgetAll(): void {
    for (const id of [...this.warm.keys()]) this.forget(id);
  }
}
