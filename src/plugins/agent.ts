import { Rpc } from "../core/rpc";
import type {
  Completion,
  Model,
  Provider,
  ProviderConfig,
} from "../core/types";
import type { Host } from "../platform/bridge";
type ConfigOption = {
  id: string;
  category?: string;
  currentValue: string;
  type: string;
  options: (
    | { value: string; name: string }
    | { options: { value: string; name: string }[] }
  )[];
};
type Session = {
  sessionId: string;
  configOptions?: ConfigOption[];
  models?: { availableModels: { modelId: string; name: string }[] };
};

/** Transient connections deliberately leave zero agent processes when idle. */
export function createAgentProvider(
  id: "acp" | "codex",
  host: Host,
  config: ProviderConfig,
): Provider {
  const connections = new Set<Rpc>();
  const lifetime = new AbortController();
  async function withAgent<T>(
    signal: AbortSignal,
    run: (rpc: Rpc, cwd: string) => Promise<T>,
  ): Promise<T> {
    const combined = AbortSignal.any([signal, lifetime.signal]);
    combined.throwIfAborted();
    const cwd = config.cwd || (await host.cwd());
    combined.throwIfAborted();
    const rpc = new Rpc(host, { ...config, cwd }, id === "acp");
    connections.add(rpc);
    const abort = () => {
      void rpc.close().catch(() => {});
    };
    combined.addEventListener("abort", abort, { once: true });
    try {
      await rpc.open();
      combined.throwIfAborted();
      if (id === "codex") {
        await rpc.request("initialize", {
          clientInfo: {
            name: "gogogadget",
            title: "Gogogadget",
            version: "0.1.0",
          },
        });
        await rpc.notify("initialized");
      } else {
        const response = await rpc.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "gogogadget", version: "0.1.0" },
        });
        if (response.protocolVersion !== 1)
          throw new Error(
            `Unsupported ACP version: ${response.protocolVersion}`,
          );
      }
      return await run(rpc, cwd);
    } finally {
      combined.removeEventListener("abort", abort);
      await rpc.close();
      connections.delete(rpc);
    }
  }
  const newSession = (rpc: Rpc, cwd: string) =>
    rpc.request<Session>("session/new", { cwd, mcpServers: [] });
  const modelOption = (session: Session) =>
    session.configOptions?.find(
      (option) => option.category === "model" && option.type === "select",
    );
  const options = (option: ConfigOption) =>
    option.options.flatMap((value) =>
      "options" in value ? value.options : [value],
    );
  return {
    id,
    name: id === "codex" ? "Codex" : "ACP",
    models: (signal) =>
      withAgent(signal, async (rpc, cwd) => {
        if (id === "codex") {
          const result: Model[] = [];
          let cursor: string | null = null;
          do {
            const page: {
              data: { model: string; displayName: string }[];
              nextCursor?: string;
            } = await rpc.request("model/list", { limit: 100, cursor });
            result.push(
              ...page.data.map((model) => ({
                id: model.model,
                name: model.displayName,
              })),
            );
            cursor = page.nextCursor ?? null;
          } while (cursor && result.length < 1000);
          return result;
        }
        const session = await newSession(rpc, cwd);
        const option = modelOption(session);
        if (option)
          return options(option).map((v) => ({ id: v.value, name: v.name }));
        return (
          session.models?.availableModels.map((m) => ({
            id: m.modelId,
            name: m.name,
          })) ?? []
        );
      }),
    complete: (request: Completion) =>
      withAgent(request.signal, async (rpc, cwd) => {
        // Each request has a fresh session; carry explicit conversation context across requests.
        const text =
          request.messages.length === 1
            ? request.messages[0].content
            : `Conversation context (previous messages):\n${request.messages
                .slice(0, -1)
                .map((m) => `${m.role}: ${m.content}`)
                .join(
                  "\n\n",
                )}\n\nNew question:\n${request.messages.at(-1)!.content}`;
        if (id === "acp") {
          const session = await newSession(rpc, cwd);
          if (request.model) {
            const option = modelOption(session);
            if (option)
              await rpc.request("session/set_config_option", {
                sessionId: session.sessionId,
                configId: option.id,
                value: request.model,
              });
            else if (session.models)
              await rpc.request("session/set_model", {
                sessionId: session.sessionId,
                modelId: request.model,
              });
            else
              throw new Error(
                "This ACP agent does not support model selection. Leave the model field empty to use its default.",
              );
          }
          const off = rpc.onMessage((message) => {
            if (message.method === "session/request_permission")
              request.onStatus(
                "Agent permission denied; this launcher does not grant permission automatically.",
              );
            if (
              message.method !== "session/update" ||
              message.params?.sessionId !== session.sessionId
            )
              return;
            const update = message.params.update;
            if (
              update?.sessionUpdate === "agent_message_chunk" &&
              update.content?.type === "text"
            )
              request.onText(update.content.text);
            if (update?.sessionUpdate === "tool_call")
              request.onStatus(update.title ?? "Agent is working…");
          });
          try {
            const result = await rpc.request(
              "session/prompt",
              {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text }],
              },
              300_000,
            );
            if (result.stopReason === "cancelled")
              throw new Error("The agent cancelled the request.");
            if (result.stopReason === "max_tokens")
              request.onStatus("Token limit reached.");
          } finally {
            off();
          }
        } else {
          const response = await rpc.request("thread/start", {
            model: request.model || null,
            cwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
          });
          const threadId = response.thread.id;
          let off = () => {};
          let fail = () => {};
          let timer: ReturnType<typeof setTimeout>;
          const completed = new Promise<void>((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Codex response exceeded 5 minutes.")),
              300_000,
            );
            fail = rpc.onFailure(reject);
            off = rpc.onMessage((message) => {
              const p = message.params;
              if (p?.threadId !== threadId) return;
              if (message.method === "item/agentMessage/delta")
                request.onText(p.delta);
              if (message.method === "error" && !p.willRetry)
                reject(new Error(p.error?.message ?? "Codex error"));
              if (message.method === "turn/completed") {
                if (p.turn?.status === "failed")
                  reject(
                    new Error(p.turn.error?.message ?? "Codex request failed"),
                  );
                else if (p.turn?.status === "interrupted")
                  reject(new Error("Codex request interrupted"));
                else resolve();
              }
            });
          });
          // Attach a handler immediately: a process may fail while turn/start is pending.
          void completed.catch(() => {});
          try {
            await rpc.request("turn/start", {
              threadId,
              input: [{ type: "text", text }],
            });
            await completed;
          } finally {
            clearTimeout(timer!);
            off();
            fail();
          }
        }
      }),
    async dispose() {
      lifetime.abort();
      await Promise.all([...connections].map((rpc) => rpc.close()));
      connections.clear();
    },
  };
}
