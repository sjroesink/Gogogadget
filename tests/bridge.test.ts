import { it, expect, vi, beforeEach } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mock.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { host } from "../src/platform/bridge";
beforeEach(() => mock.invoke.mockReset());
it("waits for ordered channel completion even when the native command returns first", async () => {
  let deliver: (() => void) | undefined;
  mock.invoke.mockImplementation(async (method, args) => {
    if (method === "http_request")
      deliver = () => {
        args.events.onmessage({ type: "line", data: '{"done":true}' });
        args.events.onmessage({ type: "done", data: null });
      };
  });
  const onLine = vi.fn();
  let finished = false;
  const pending = host
    .http(
      "http://localhost",
      "/api/chat",
      {},
      new AbortController().signal,
      onLine,
    )
    .then(() => {
      finished = true;
    });
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  deliver!();
  await pending;
  expect(onLine).toHaveBeenCalledWith('{"done":true}');
});
it("reissues cancellation when native registration races an early abort", async () => {
  let ready: (() => void) | undefined;
  let rejectRequest: (value: unknown) => void = () => {};
  mock.invoke.mockImplementation((method, args) => {
    if (method === "http_request") {
      ready = () => args.events.onmessage({ type: "ready", data: null });
      return new Promise((_, reject) => {
        rejectRequest = reject;
      });
    }
    return Promise.resolve();
  });
  const controller = new AbortController();
  const request = host.http(
    "http://localhost",
    "/api/chat",
    {},
    controller.signal,
    () => {},
  );
  controller.abort();
  ready!();
  rejectRequest(new Error("cancelled"));
  await expect(request).rejects.toThrow("cancelled");
  expect(
    mock.invoke.mock.calls.filter((c) => c[0] === "http_cancel"),
  ).toHaveLength(2);
});
