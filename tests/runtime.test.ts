import { describe, it, expect } from "vitest";
import { Runtime } from "../src/core/runtime";

describe("composable runtime", () => {
  it("reactively activates waiting consumers and unwinds consumers before providers", async () => {
    const runtime = new Runtime();
    const events: string[] = [];
    runtime.register({
      id: "consumer",
      requires: ["ai"],
      provides: ["command"],
      activate(ctx) {
        expect(ctx.get("ai")).toBe(42);
        events.push("consumer up");
        ctx.effect(() => {
          events.push("consumer down");
        });
        ctx.provide("command", true);
      },
    });
    runtime.register(
      {
        id: "provider",
        provides: ["ai"],
        activate(ctx) {
          events.push("provider up");
          ctx.effect(() => {
            events.push("provider down");
          });
          ctx.provide("ai", 42);
        },
      },
      false,
    );
    await runtime.start();
    expect(runtime.has("command")).toBe(false);
    await runtime.setEnabled("provider", true);
    expect(runtime.has("command")).toBe(true);
    await runtime.setEnabled("provider", false);
    expect(events).toEqual([
      "provider up",
      "consumer up",
      "consumer down",
      "provider down",
    ]);
    expect(runtime.has("command")).toBe(false);
    expect(runtime.has("ai")).toBe(false);
    await runtime.setEnabled("provider", true);
    expect(runtime.get("command")).toBe(true);
    await runtime.dispose();
    await runtime.dispose();
    expect(events.filter((e) => e === "provider down")).toHaveLength(2);
  });
  it("rolls back partial activation without harming unrelated plugins", async () => {
    const runtime = new Runtime();
    const effects: number[] = [];
    runtime.register({
      id: "broken",
      provides: ["broken"],
      activate(ctx) {
        ctx.provide("broken", 1);
        ctx.effect(() => {
          effects.push(1);
        });
        ctx.effect(() => {
          effects.push(2);
          throw new Error("cleanup");
        });
        throw new Error("activation");
      },
    });
    runtime.register({
      id: "healthy",
      provides: ["healthy"],
      activate(ctx) {
        ctx.provide("healthy", 2);
      },
    });
    await runtime.start();
    expect(runtime.has("broken")).toBe(false);
    expect(runtime.get("healthy")).toBe(2);
    expect(effects).toEqual([2, 1]);
    expect(runtime.status()[0].state).toBe("failed");
    await runtime.start();
    expect(effects).toEqual([2, 1]);
  });
  it("serializes concurrent changes, waits for async cleanup, and aborts owned work", async () => {
    const runtime = new Runtime();
    let signal: AbortSignal | undefined;
    let cleaned = false;
    runtime.register({
      id: "async",
      provides: ["resource"],
      async activate(ctx) {
        signal = ctx.signal;
        await Promise.resolve();
        ctx.provide("resource", {});
        ctx.effect(async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          cleaned = true;
        });
      },
    });
    await runtime.start();
    const original = signal;
    await Promise.all([
      runtime.setEnabled("async", false),
      runtime.setEnabled("async", true),
    ]);
    expect(original!.aborted).toBe(true);
    expect(cleaned).toBe(true);
    expect(signal!.aborted).toBe(false);
  });
  it("rejects duplicate ownership and undeclared context access", async () => {
    const runtime = new Runtime();
    runtime.register({
      id: "one",
      provides: ["key"],
      activate(ctx) {
        ctx.provide("key", 1);
      },
    });
    expect(() =>
      runtime.register({ id: "two", provides: ["key"], activate() {} }),
    ).toThrow("Conflicting");
    runtime.register({
      id: "sneaky",
      activate(ctx) {
        ctx.get("key");
      },
    });
    await runtime.start();
    expect(runtime.status()[1].error).toContain("Undeclared");
  });
  it("leaves dependency cycles waiting without spinning", async () => {
    const runtime = new Runtime();
    runtime.register({
      id: "a",
      requires: ["b"],
      provides: ["a"],
      activate(ctx) {
        ctx.provide("a", 1);
      },
    });
    runtime.register({
      id: "b",
      requires: ["a"],
      provides: ["b"],
      activate(ctx) {
        ctx.provide("b", 1);
      },
    });
    await runtime.start();
    expect(runtime.status().map((s) => s.state)).toEqual([
      "waiting",
      "waiting",
    ]);
  });
});
