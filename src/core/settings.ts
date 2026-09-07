import type { Settings, ProviderConfig } from "./types";
import { defaultActions, parseActions } from "./actions";
const base: ProviderConfig = {
  enabled: true,
  model: "",
  endpoint: "",
  command: "",
  args: [],
  cwd: "",
};
export const defaults = (): Settings => ({
  version: 1,
  actions: defaultActions(),
  selected: "codex",
  plugins: { "commands.essentials": true },
  providers: {
    ollama: { ...base, endpoint: "http://127.0.0.1:11434" },
    codex: {
      ...base,
      model: "gpt-5.6-terra",
      command: "codex",
      args: ["app-server"],
    },
    acp: { ...base, enabled: false },
  },
});
export function parseSettings(value: unknown): Settings {
  const result = defaults();
  if (!value || typeof value !== "object") return result;
  const input = value as Partial<Settings>;
  if (input.version !== 1) throw new Error("Unknown settings version");
  if (input.actions !== undefined) result.actions = parseActions(input.actions);
  if (
    typeof input.selected === "string" &&
    Object.hasOwn(result.providers, input.selected)
  )
    result.selected = input.selected;
  for (const id of Object.keys(result.providers)) {
    const config = input.providers?.[id];
    if (!config || typeof config !== "object") continue;
    for (const key of ["model", "endpoint", "command", "cwd"] as const)
      if (typeof config[key] === "string")
        result.providers[id][key] = config[key];
    if (typeof config.enabled === "boolean")
      result.providers[id].enabled = config.enabled;
    if (
      Array.isArray(config.args) &&
      config.args.every((v) => typeof v === "string")
    )
      result.providers[id].args = config.args;
  }
  if (typeof input.plugins?.["commands.essentials"] === "boolean")
    result.plugins["commands.essentials"] =
      input.plugins["commands.essentials"];
  return result;
}
