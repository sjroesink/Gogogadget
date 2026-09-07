import type { Plugin } from "../core/runtime";
import type { ProviderConfig, Provider, Command } from "../core/types";
import type { Host } from "../platform/bridge";

export const providerInfo = [
  {
    id: "ollama",
    name: "Ollama",
    mark: "O",
    description: "Your models, running locally.",
    transport: "Local HTTP",
    color: "cream",
  },
  {
    id: "codex",
    name: "Codex",
    mark: "⌘",
    description: "Connect to your signed-in Codex CLI.",
    transport: "App server · stdio",
    color: "green",
  },
  {
    id: "acp",
    name: "ACP",
    mark: "↗",
    description: "An open connection to your agent.",
    transport: "Agent Client Protocol",
    color: "purple",
  },
] as const;

// Lazy imports keep provider implementations off the launcher startup path.
export function providerPlugin(id: string, config: ProviderConfig): Plugin {
  return {
    id: `provider.${id}`,
    requires: ["host"],
    provides: [`ai.${id}`],
    activate(context) {
      const host = context.get<Host>("host");
      let loading: Promise<Provider> | undefined;
      const get = () =>
        (loading ??=
          id === "ollama"
            ? import("./ollama").then((m) => m.createProvider(host, config))
            : import("./agent").then((m) =>
                m.createAgentProvider(id as "acp" | "codex", host, config),
              ));
      context.effect(async () => {
        if (loading) await (await loading).dispose();
      });
      context.provide<Provider>(`ai.${id}`, {
        id,
        name: providerInfo.find((p) => p.id === id)!.name,
        async models(signal) {
          const provider = await get();
          context.signal.throwIfAborted();
          return provider.models(AbortSignal.any([signal, context.signal]));
        },
        async complete(request) {
          const provider = await get();
          context.signal.throwIfAborted();
          return provider.complete({
            ...request,
            signal: AbortSignal.any([request.signal, context.signal]),
          });
        },
        async dispose() {
          if (loading) await (await loading).dispose();
        },
      });
    },
  };
}
export function essentialsPlugin(commands: Command[]): Plugin {
  return {
    id: "commands.essentials",
    provides: ["commands.essentials"],
    activate(ctx) {
      ctx.provide("commands.essentials", commands);
    },
  };
}
