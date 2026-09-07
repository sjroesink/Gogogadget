import { describe, it, expect, vi } from "vitest";
import { Rpc } from "../src/core/rpc";
import { createAgentProvider } from "../src/plugins/agent";
import { createProvider } from "../src/plugins/ollama";
import { defaults } from "../src/core/settings";
import type { Host, WireEvent } from "../src/platform/bridge";

function fakeHost(handle: (message: any, send: (value: any) => void) => void) {
  let receive: (event: WireEvent) => void = () => {};
  const sent: any[] = [];
  const close = vi.fn(async () => {});
  const host: Host = {
    cwd: async () => "/workspace",
    http: async () => {},
    async process(_, callback) {
      receive = callback;
      return {
        async send(message) {
          sent.push(message);
          handle(message, (value) =>
            callback({ type: "line", data: JSON.stringify(value) }),
          );
        },
        close,
      };
    },
  };
  return { host, sent, close, event: (event: WireEvent) => receive(event) };
}
describe("provider protocols", () => {
  it("awaits shutdown exactly once, including after a failure", async () => {
    const f = fakeHost(() => {});
    let release = () => {};
    f.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const rpc = new Rpc(f.host, { command: "test", args: [], cwd: "" });
    await rpc.open();
    f.event({ type: "error", data: "failed" });
    let closed = false;
    const pending = rpc.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(closed).toBe(true);
  });
  it("performs ACP handshake, discovers config models, selects a model and streams only its session", async () => {
    const fixture = fakeHost((m, send) => {
      if (!m.id) return;
      if (m.method === "initialize")
        return send({ id: m.id, result: { protocolVersion: 1 } });
      if (m.method === "session/new")
        return send({
          id: m.id,
          result: {
            sessionId: "s",
            configOptions: [
              {
                id: "llm",
                category: "model",
                type: "select",
                options: [{ value: "local", name: "Local" }],
              },
            ],
          },
        });
      if (m.method === "session/prompt") {
        send({
          method: "session/update",
          params: {
            sessionId: "other",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "wrong" },
            },
          },
        });
        send({
          method: "session/update",
          params: {
            sessionId: "s",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hallo" },
            },
          },
        });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      send({ id: m.id, result: {} });
    });
    const provider = createAgentProvider(
      "acp",
      fixture.host,
      defaults().providers.acp,
    );
    expect(await provider.models(new AbortController().signal)).toEqual([
      { id: "local", name: "Local" },
    ]);
    const onText = vi.fn();
    await provider.complete({
      model: "local",
      messages: [{ role: "user", content: "Hoi" }],
      signal: new AbortController().signal,
      onText,
      onStatus() {},
    });
    expect(onText).toHaveBeenCalledExactlyOnceWith("Hallo");
    expect(
      fixture.sent.find((m) => m.method === "session/set_config_option").params,
    ).toEqual({ sessionId: "s", configId: "llm", value: "local" });
    expect(fixture.sent[0].jsonrpc).toBe("2.0");
    expect(fixture.close).toHaveBeenCalled();
  });
  it("performs Codex initialization, paginates models and waits for turn completion", async () => {
    const fixture = fakeHost((m, send) => {
      if (!m.id) return;
      if (m.method === "model/list")
        return send({
          id: m.id,
          result: {
            data: [
              { model: m.params.cursor ? "two" : "one", displayName: "Model" },
            ],
            nextCursor: m.params.cursor ? null : "page2",
          },
        });
      if (m.method === "thread/start")
        return send({ id: m.id, result: { thread: { id: "thread" } } });
      if (m.method === "turn/start") {
        send({ id: m.id, result: { turn: { id: "turn" } } });
        send({
          method: "item/agentMessage/delta",
          params: { threadId: "thread", delta: "Hello" },
        });
        send({
          method: "turn/completed",
          params: { threadId: "thread", turn: { status: "completed" } },
        });
        return;
      }
      send({ id: m.id, result: {} });
    });
    const provider = createAgentProvider(
      "codex",
      fixture.host,
      defaults().providers.codex,
    );
    expect(
      (await provider.models(new AbortController().signal)).map((m) => m.id),
    ).toEqual(["one", "two"]);
    const onText = vi.fn();
    await provider.complete({
      model: "one",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onText,
      onStatus() {},
    });
    expect(onText).toHaveBeenCalledWith("Hello");
    expect(fixture.sent[0].jsonrpc).toBeUndefined();
    expect(fixture.sent[1].method).toBe("initialized");
    expect(
      fixture.sent.find((m) => m.method === "thread/start").params.sandbox,
    ).toBe("read-only");
  });
  it("rejects ACP protocol mismatches and releases the process", async () => {
    const f = fakeHost((m, send) =>
      send({ id: m.id, result: { protocolVersion: 99 } }),
    );
    const p = createAgentProvider("acp", f.host, defaults().providers.acp);
    await expect(p.models(new AbortController().signal)).rejects.toThrow(
      "ACP version",
    );
    expect(f.close).toHaveBeenCalled();
  });
  it("cancels a pending agent request and prevents use after disposal", async () => {
    const f = fakeHost(() => {});
    const p = createAgentProvider("acp", f.host, defaults().providers.acp);
    const controller = new AbortController();
    const request = p.models(controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toThrow();
    expect(f.close).toHaveBeenCalled();
    await p.dispose();
    await expect(p.models(new AbortController().signal)).rejects.toThrow();
  });
  it("rejects pending RPC calls on malformed data and denies permissions", async () => {
    const f = fakeHost(() => {});
    const rpc = new Rpc(f.host, { command: "test", args: [], cwd: "" });
    await rpc.open();
    f.event({
      type: "line",
      data: JSON.stringify({
        id: 99,
        method: "session/request_permission",
        params: {},
      }),
    });
    expect(f.sent.at(-1).result.outcome.outcome).toBe("cancelled");
    const pending = rpc.request("test", {});
    f.event({ type: "line", data: "not json" });
    await expect(pending).rejects.toThrow("JSON");
  });
  it("times out RPC calls instead of leaking pending promises", async () => {
    const f = fakeHost(() => {});
    const rpc = new Rpc(f.host, { command: "test", args: [], cwd: "" });
    await rpc.open();
    await expect(rpc.request("missing", {}, 5)).rejects.toThrow(
      "did not respond",
    );
    await rpc.close();
  });
  it("streams Ollama text, passes explicit model/history, and detects truncated streams", async () => {
    const f = fakeHost(() => {});
    let body: any;
    let truncated = false;
    f.host.http = async (_, path, value, __, onLine) => {
      if (path === "/api/tags") return onLine('{"models":[{"name":"qwen"}]}');
      body = value;
      onLine('{"message":{"content":"é🙂"},"done":false}');
      if (!truncated) onLine('{"done":true}');
    };
    const p = createProvider(f.host, defaults().providers.ollama);
    expect(await p.models(new AbortController().signal)).toEqual([
      { id: "qwen", name: "qwen" },
    ]);
    const onText = vi.fn();
    const request = {
      model: "qwen",
      messages: [{ role: "user" as const, content: "Hoi" }],
      signal: new AbortController().signal,
      onText,
      onStatus() {},
    };
    await p.complete(request);
    expect(body.model).toBe("qwen");
    expect(body.messages).toEqual(request.messages);
    expect(onText).toHaveBeenCalledWith("é🙂");
    truncated = true;
    await expect(p.complete(request)).rejects.toThrow("disconnected");
  });
});
