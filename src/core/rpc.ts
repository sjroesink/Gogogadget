import type { Host, ProcessConnection, WireEvent } from "../platform/bridge";
type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};
type Pending = {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export class Rpc {
  private connection?: ProcessConnection;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private failures = new Set<(error: Error) => void>();
  private sequence = 0;
  private closed = false;
  private failure?: Error;
  private shutdown?: Promise<void>;
  constructor(
    private host: Host,
    private config: { command: string; args: string[]; cwd: string },
    private jsonrpc = true,
  ) {}
  async open() {
    const connection = await this.host.process(this.config, (event) =>
      this.receive(event),
    );
    this.connection = connection;
    if (this.closed) {
      await (this.shutdown ??= connection.close());
      throw this.failure ?? new Error("Connection closed");
    }
  }
  onMessage(fn: (message: RpcMessage) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  onFailure(fn: (error: Error) => void) {
    this.failures.add(fn);
    if (this.failure) fn(this.failure);
    return () => {
      this.failures.delete(fn);
    };
  }
  async send(message: RpcMessage) {
    if (this.closed || !this.connection)
      throw this.failure ?? new Error("Agent is not connected");
    await this.connection.send(
      this.jsonrpc ? { jsonrpc: "2.0", ...message } : message,
    );
  }
  notify(method: string, params: unknown = {}) {
    return this.send({ method, params });
  }
  request<T = any>(
    method: string,
    params: unknown,
    timeout = 20_000,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(this.failure ?? new Error("Agent closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent did not respond to ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  private receive(event: WireEvent) {
    if (this.closed) return;
    if (event.type !== "line") {
      this.fail(
        new Error(
          event.type === "error"
            ? String(event.data)
            : "Agent connection closed",
        ),
      );
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      this.fail(new Error("Agent sent invalid JSON"));
      return;
    }
    if (!message || typeof message !== "object") {
      this.fail(new Error("Invalid agent message"));
      return;
    }
    if (message.id !== undefined && !message.method) {
      const item = this.pending.get(Number(message.id));
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(Number(message.id));
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      // No implicit approvals or host filesystem/terminal capabilities.
      const result =
        message.method === "session/request_permission"
          ? { outcome: { outcome: "cancelled" } }
          : message.method.endsWith("/requestApproval")
            ? { decision: "decline" }
            : undefined;
      void this.send(
        result
          ? { id: message.id, result }
          : ({
              id: message.id,
              error: { message: "Unsupported client method", code: -32601 },
            } as RpcMessage),
      ).catch(() => {});
      for (const listener of this.listeners) listener(message);
    } else {
      for (const listener of this.listeners) listener(message);
    }
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
    if (this.connection) {
      this.shutdown ??= this.connection.close();
      void this.shutdown.catch(() => {});
    }
  }
  async close() {
    this.fail(new Error("Connection closed"));
    await this.shutdown;
    this.listeners.clear();
    this.failures.clear();
  }
}
