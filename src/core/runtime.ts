export type Cleanup = () => void | Promise<void>;
export interface Plugin {
  id: string;
  requires?: string[];
  provides?: string[];
  activate(context: Context): void | Promise<void>;
}
type Slot = { owner: string; value: unknown };
type Entry = {
  plugin: Plugin;
  enabled: boolean;
  context?: Context;
  error?: string;
};

/** All owned effects unwind in reverse order, including partially failed activation. */
export class Context {
  private cleanups: Cleanup[] = [];
  readonly controller = new AbortController();
  get signal() {
    return this.controller.signal;
  }
  constructor(
    private runtime: Runtime,
    private plugin: Plugin,
  ) {}
  get<T>(key: string): T {
    if (!this.plugin.requires?.includes(key))
      throw new Error(`Undeclared dependency: ${key}`);
    return this.runtime.get<T>(key);
  }
  provide<T>(key: string, value: T) {
    if (!this.plugin.provides?.includes(key))
      throw new Error(`Undeclared provision: ${key}`);
    this.signal.throwIfAborted();
    this.effect(this.runtime.provide(this.plugin.id, key, value));
  }
  effect(cleanup: Cleanup) {
    if (this.signal.aborted) throw new Error("Context disposed");
    this.cleanups.push(cleanup);
  }
  async dispose() {
    if (this.signal.aborted) return;
    this.controller.abort();
    const errors: unknown[] = [];
    for (const undo of this.cleanups.reverse()) {
      try {
        await undo();
      } catch (error) {
        errors.push(error);
      }
    }
    this.cleanups = [];
    if (errors.length)
      throw new AggregateError(errors, "Plugin cleanup failed");
  }
}

/** Serialized graph reconciliation: deactivate consumers before removing dependencies. */
export class Runtime {
  private entries = new Map<string, Entry>();
  private slots = new Map<string, Slot>();
  private queue: Promise<void> = Promise.resolve();
  register(plugin: Plugin, enabled = true) {
    if (this.entries.has(plugin.id))
      throw new Error(`Duplicate plugin: ${plugin.id}`);
    const keys = new Set(plugin.provides ?? []);
    for (const entry of this.entries.values())
      for (const key of entry.plugin.provides ?? [])
        if (keys.has(key)) throw new Error(`Conflicting provision: ${key}`);
    this.entries.set(plugin.id, { plugin, enabled });
  }
  get<T>(key: string): T {
    const slot = this.slots.get(key);
    if (!slot) throw new Error(`Service unavailable: ${key}`);
    return slot.value as T;
  }
  has(key: string) {
    return this.slots.has(key);
  }
  provide(owner: string, key: string, value: unknown): Cleanup {
    if (this.slots.has(key)) throw new Error(`Duplicate service: ${key}`);
    const slot = { owner, value };
    this.slots.set(key, slot);
    return () => {
      if (this.slots.get(key) === slot) this.slots.delete(key);
    };
  }
  status() {
    return [...this.entries.values()].map((e) => ({
      id: e.plugin.id,
      enabled: e.enabled,
      state: e.error
        ? "failed"
        : e.context
          ? "active"
          : e.enabled
            ? "waiting"
            : "disabled",
      error: e.error,
      requires: e.plugin.requires ?? [],
      provides: e.plugin.provides ?? [],
    }));
  }
  setEnabled(id: string, enabled: boolean) {
    return this.enqueue(async () => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown plugin: ${id}`);
      entry.enabled = enabled;
      entry.error = undefined;
      await this.reconcile();
    });
  }
  start() {
    return this.enqueue(() => this.reconcile());
  }
  dispose() {
    return this.enqueue(async () => {
      for (const e of this.entries.values()) e.enabled = false;
      await this.reconcile();
    });
  }
  private enqueue(operation: () => Promise<void>) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private async deactivate(entry: Entry, visited = new Set<string>()) {
    if (!entry.context || visited.has(entry.plugin.id)) return;
    visited.add(entry.plugin.id);
    for (const consumer of this.entries.values()) {
      if (
        consumer.plugin.requires?.some((key) =>
          entry.plugin.provides?.includes(key),
        )
      )
        await this.deactivate(consumer, visited);
    }
    const ctx = entry.context;
    entry.context = undefined;
    try {
      await ctx.dispose();
    } catch (e) {
      entry.error = String(e);
    }
  }
  private async reconcile() {
    for (const entry of this.entries.values())
      if (
        !entry.enabled ||
        entry.plugin.requires?.some((k) => !this.slots.has(k))
      )
        await this.deactivate(entry);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of this.entries.values()) {
        if (!entry.enabled || entry.context || entry.error) continue;
        if (entry.plugin.requires?.some((k) => !this.slots.has(k))) continue;
        const ctx = new Context(this, entry.plugin);
        try {
          await entry.plugin.activate(ctx);
          for (const key of entry.plugin.provides ?? [])
            if (!this.slots.has(key))
              throw new Error(`Missing promised service: ${key}`);
          entry.context = ctx;
          changed = true;
        } catch (error) {
          entry.error = String(error);
          try {
            await ctx.dispose();
          } catch (cleanup) {
            entry.error += `; ${cleanup}`;
          }
        }
      }
    }
  }
}
