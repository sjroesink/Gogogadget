import type {
  Completion,
  Model,
  Provider,
  ProviderConfig,
} from "../core/types";
import type { Host } from "../platform/bridge";
export function createProvider(host: Host, config: ProviderConfig): Provider {
  const lifetime = new AbortController();
  return {
    id: "ollama",
    name: "Ollama",
    async models(signal) {
      const models: Model[] = [];
      await host.http(
        config.endpoint,
        "/api/tags",
        null,
        AbortSignal.any([signal, lifetime.signal]),
        (line) => {
          const data = JSON.parse(line);
          if (data.error) throw new Error(data.error);
          for (const model of data.models ?? [])
            models.push({ id: model.name, name: model.name });
        },
      );
      return models;
    },
    async complete(request: Completion) {
      if (!request.model)
        throw new Error("Choose an Ollama model in Settings first.");
      let done = false;
      await host.http(
        config.endpoint,
        "/api/chat",
        {
          model: request.model,
          messages: request.messages,
          stream: true,
          keep_alive: "60s",
        },
        AbortSignal.any([request.signal, lifetime.signal]),
        (line) => {
          const data = JSON.parse(line);
          if (data.error) throw new Error(data.error);
          if (data.message?.content) request.onText(data.message.content);
          if (data.message?.thinking) request.onStatus("Model is thinking…");
          if (data.done) done = true;
        },
      );
      if (!done)
        throw new Error(
          "Ollama disconnected before the response was complete.",
        );
    },
    async dispose() {
      lifetime.abort();
    },
  };
}
