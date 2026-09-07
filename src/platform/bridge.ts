import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { AppEntry, Settings } from "../core/types";
import { defaults, parseSettings } from "../core/settings";
export const desktop = isTauri();
export type WireEvent = {
  type: "line" | "error" | "exit" | "ready" | "done";
  data: string | number | null;
};
export interface ProcessConnection {
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
}
export interface Host {
  process(
    config: { command: string; args: string[]; cwd: string },
    receive: (event: WireEvent) => void,
  ): Promise<ProcessConnection>;
  http(
    base: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    onLine: (line: string) => void,
  ): Promise<void>;
  cwd(): Promise<string>;
}
const nativeOnly = () => {
  if (!desktop) throw new Error("Open the desktop app to connect a provider.");
};
export const host: Host = {
  async process(config, receive) {
    nativeOnly();
    const id = crypto.randomUUID();
    const events = new Channel<WireEvent>();
    events.onmessage = receive;
    await invoke("process_open", {
      id,
      executable: config.command,
      args: config.args,
      cwd: config.cwd,
      events,
    });
    return {
      send: (message) =>
        invoke("process_write", { id, message: JSON.stringify(message) }),
      close: () => invoke("process_close", { id }),
    };
  },
  async http(base, path, body, signal, onLine) {
    nativeOnly();
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const events = new Channel<WireEvent>();
    let parseError: unknown;
    let finish = () => {};
    const delivered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    events.onmessage = (event) => {
      if (event.type === "ready" && signal.aborted) cancel();
      if (event.type === "done") finish();
      if (signal.aborted || parseError) return;
      try {
        if (event.type === "line") onLine(String(event.data));
      } catch (e) {
        parseError = e;
        cancel();
      }
    };
    const cancel = () => {
      void invoke("http_cancel", { id }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await Promise.all([
        delivered,
        invoke("http_request", {
          id,
          base,
          path,
          body: body ?? null,
          events,
        }),
      ]);
    } catch (error) {
      throw parseError ?? error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    signal.throwIfAborted();
    if (parseError) throw parseError;
  },
  cwd: () => {
    nativeOnly();
    return invoke<string>("default_cwd");
  },
};
export async function loadSettings(): Promise<Settings> {
  const data = desktop
    ? await invoke("load_settings")
    : JSON.parse(localStorage.getItem("gogogadget.settings") ?? "null");
  return data ? parseSettings(data) : defaults();
}
let saveQueue = Promise.resolve();
export function saveSettings(settings: Settings): Promise<void> {
  const value = structuredClone(settings);
  const result = saveQueue.then(async () => {
    if (desktop) await invoke("save_settings", { value });
    else localStorage.setItem("gogogadget.settings", JSON.stringify(value));
  });
  saveQueue = result.catch(() => {});
  return result;
}
export const listApps = (refresh = false) =>
  desktop ? invoke<AppEntry[]>("list_apps", { refresh }) : Promise.resolve([]);
export async function launchApp(id: string) {
  nativeOnly();
  await invoke("launch_app", { id });
  await hide();
}
export async function openUrl(url: string) {
  if (desktop) {
    await invoke("open_url", { url });
    await hide();
  } else window.open(url, "_blank", "noopener,noreferrer");
}
export async function hide() {
  if (desktop) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  }
}
export async function onFocus(callback: () => void) {
  if (desktop) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("launcher:focus", callback);
  }
}
export async function drag() {
  if (desktop) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  }
}
export async function quit() {
  if (desktop) await invoke("quit");
}
