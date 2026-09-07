export interface Model {
  id: string;
  name: string;
}
export interface Message {
  role: "user" | "assistant";
  content: string;
}
export interface Completion {
  model: string;
  messages: Message[];
  signal: AbortSignal;
  onText(text: string): void;
  onStatus(text: string): void;
}
export interface Provider {
  id: string;
  name: string;
  models(signal: AbortSignal): Promise<Model[]>;
  complete(request: Completion): Promise<void>;
  dispose(): Promise<void>;
}
export interface ProviderConfig {
  enabled: boolean;
  model: string;
  endpoint: string;
  command: string;
  args: string[];
  cwd: string;
}
export interface Settings {
  actions: import("./actions").TextAction[];
  version: 1;
  selected: string;
  providers: Record<string, ProviderConfig>;
  plugins: Record<string, boolean>;
}
export interface AppEntry {
  id: string;
  name: string;
}
export interface Command {
  id: string;
  title: string;
  subtitle: string;
  keywords: string;
  icon: string;
  kind: "app" | "command" | "ai";
  run(): void | Promise<void>;
}
