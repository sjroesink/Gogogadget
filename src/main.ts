import "./styles.css";
import { Runtime } from "./core/runtime";
import { SearchIndex } from "./core/search";
import { defaults } from "./core/settings";
import {
  actionPrompt,
  applyProposal,
  isActionRequest,
  parseActions,
  parseProposal,
  proposalPrompt,
  type ActionProposal,
  type TextAction,
} from "./core/actions";
import type {
  AppEntry,
  Command,
  Message,
  Model,
  Provider,
  Settings,
} from "./core/types";
import {
  host,
  desktop,
  loadSettings,
  saveSettings,
  listApps,
  launchApp,
  openUrl,
  hide,
  onFocus,
  onSelection,
  replaceSelection,
  drag,
  quit,
} from "./platform/bridge";
import {
  essentialsPlugin,
  providerInfo,
  providerPlugin,
} from "./plugins/catalog";

const root = document.querySelector<HTMLDivElement>("#app")!;
const icon = (name: string) => {
  const paths: Record<string, string> = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    spark:
      '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    settings:
      '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    back: '<path d="m14 6-6 6 6 6"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
    refresh:
      '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    power: '<path d="M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0"/>',
    plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0ZM12 17v4"/>',
  };
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.grid}</svg>`;
};
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  root.querySelector<T>(selector)!;
let settings: Settings = defaults();
let runtime = new Runtime();
let apps: AppEntry[] = [];
let page: "launcher" | "chat" | "plugins" | "settings" | "actions" = "launcher";
let selectedText = "";
let selectionToken: string | undefined;
let replacementToken: string | undefined;
let replacing = false;
let selectionError = "";
let managingActions = false;
let editingAction = "";
let actionRequest = "";
let actionProposal: ActionProposal | undefined;
let actionGeneration: AbortController | undefined;
let actionError = "";
let savingActions = false;
let filter = "all";
let query = "";
let selection = 0;
let results: Command[] = [];
let searchMs = 0;
let active: AbortController | undefined;
let discovery: AbortController | undefined;
let conversation: Message[] = [];
const actionInputs = new WeakMap<Message, string>();
let response = "";
let markdown: ((text: string) => string) | undefined;
let markdownLoading: Promise<void> | undefined;
let chatStatus = "";
let chatError = "";
let conversationEpoch = 0;
let configured = "ollama";
let modelCache: Record<string, Model[]> = {};
let indexed = !desktop;
let toastTimer: ReturnType<typeof setTimeout>;
const index = new SearchIndex();

function toast(message: string) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5000);
}
function guarded(action: () => unknown | Promise<unknown>) {
  return () => {
    try {
      Promise.resolve(action()).catch((e) => toast(String(e)));
    } catch (e) {
      toast(String(e));
    }
  };
}
function provider(): Provider {
  if (!runtime.has(`ai.${settings.selected}`))
    throw new Error("Enable an AI provider in Plugins.");
  return runtime.get<Provider>(`ai.${settings.selected}`);
}
function essentials(): Command[] {
  return [
    {
      id: "text-actions",
      title: "Text actions",
      subtitle: "Use selected text · Ctrl+Alt+T",
      keywords: "selection translate rewrite text actions",
      icon: "spark",
      kind: "command",
      run: () => {
        managingActions = false;
        navigate("actions");
      },
    },
    {
      id: "manage-actions",
      title: "Manage text actions",
      subtitle: "Add, edit or remove actions, yourself or with AI",
      keywords: "actions prompts templates manage add create",
      icon: "settings",
      kind: "command",
      run: () => {
        managingActions = true;
        navigate("actions");
      },
    },
    {
      id: "plugins",
      title: "Manage your plugins",
      subtitle: "Make Gogogadget yours",
      keywords: "plugins extensions modules",
      icon: "plug",
      kind: "command",
      run: () => navigate("plugins"),
    },
    {
      id: "settings",
      title: "Settings",
      subtitle: "Providers, models and connections",
      keywords: "settings preferences model configure",
      icon: "settings",
      kind: "command",
      run: () => navigate("settings"),
    },
    {
      id: "refresh",
      title: "Reindex apps",
      subtitle: "Refresh the Windows app catalog",
      keywords: "refresh index apps reload",
      icon: "refresh",
      kind: "command",
      run: () => refreshApps(true),
    },
    {
      id: "quit",
      title: "Quit Gogogadget",
      subtitle: "Exit the launcher",
      keywords: "quit exit stop close",
      icon: "power",
      kind: "command",
      run: quit,
    },
  ];
}
async function rebuild() {
  active?.abort();
  discovery?.abort();
  await runtime.dispose();
  const next = new Runtime();
  next.register({
    id: "native.host",
    provides: ["host"],
    activate(ctx) {
      ctx.provide("host", host);
    },
  });
  for (const item of providerInfo) {
    next.register(
      providerPlugin(item.id, { ...settings.providers[item.id] }),
      settings.providers[item.id].enabled,
    );
    next.register({
      id: `commands.ai.${item.id}`,
      requires: [`ai.${item.id}`],
      provides: [`commands.ai.${item.id}`],
      activate(ctx) {
        ctx.get<Provider>(`ai.${item.id}`);
        ctx.provide<Command[]>(`commands.ai.${item.id}`, [
          {
            id: "ask",
            title: "Ask AI",
            subtitle: `Start a conversation with ${item.name}`,
            keywords: "chat question ask ai",
            icon: "spark",
            kind: "ai",
            run: () => navigate("chat"),
          },
          {
            id: "write",
            title: "Help me write",
            subtitle: "From an idea to the right words",
            keywords: "write writing text email",
            icon: "spark",
            kind: "ai",
            run: () => {
              navigate("chat");
              $<HTMLTextAreaElement>("#prompt").value = "Help me write ";
              $("#prompt").focus();
            },
          },
          {
            id: "explain",
            title: "Explain something",
            subtitle: "A clear answer to your next question",
            keywords: "explanation explain understand",
            icon: "spark",
            kind: "ai",
            run: () => {
              navigate("chat");
              $<HTMLTextAreaElement>("#prompt").value =
                "Explain in simple terms: ";
              $("#prompt").focus();
            },
          },
        ]);
      },
    });
  }
  next.register(
    essentialsPlugin(essentials()),
    settings.plugins["commands.essentials"],
  );
  await next.start();
  runtime = next;
  rebuildIndex();
}
function rebuildIndex() {
  const ai = runtime.has(`commands.ai.${settings.selected}`)
    ? runtime.get<Command[]>(`commands.ai.${settings.selected}`)
    : [];
  const commands = runtime.has("commands.essentials")
    ? runtime.get<Command[]>("commands.essentials")
    : [];
  const applicationCommands: Command[] = apps.map((app) => ({
    id: app.id,
    title: app.name,
    subtitle: "Windows application",
    keywords: app.name,
    icon: "grid",
    kind: "app",
    run: () => launchApp(app.id),
  }));
  index.update(
    filter === "apps"
      ? applicationCommands
      : filter === "ai"
        ? ai
        : [
            ...ai.slice(0, 1),
            ...applicationCommands,
            ...commands,
            ...ai.slice(1),
          ],
  );
}
async function refreshApps(refresh = false) {
  indexed = false;
  try {
    apps = await listApps(refresh);
    indexed = true;
    rebuildIndex();
    if (refresh) toast(`${apps.length} apps indexed`);
  } catch (e) {
    indexed = true;
    toast(String(e));
  }
  if (page === "launcher") renderResults();
}
function navigate(next: typeof page) {
  if (next !== "actions") actionGeneration?.abort();
  if (next !== "settings") discovery?.abort();
  page = next;
  render();
}
function shell() {
  root.innerHTML = `<main class="launcher"><header id="drag-area"><div class="brand"><span class="brand-mark">g<span>↗</span></span><span>gogogadget<span class="beta">preview</span></span></div><div class="window-actions"><span class="hotkey"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Space</kbd></span><button id="hide" class="icon-button" aria-label="Hide window">${icon("close")}</button></div></header><div id="view"></div><footer><div class="footer-left"><span class="status-dot"></span><span id="footer-status">Ready when you are</span></div><div class="footer-right"><button id="footer-plugins" class="icon-button" aria-label="Plugins">${icon("plug")}</button><button id="footer-settings" class="icon-button" aria-label="Settings">${icon("settings")}</button><span class="divider"></span><span><kbd>Esc</kbd> close</span></div></footer></main><div id="toast" role="status" hidden></div>`;
  $("#hide").onclick = guarded(hide);
  $("#drag-area").onmousedown = (event) => {
    if (event.button === 0 && !(event.target as HTMLElement).closest("button"))
      void drag();
  };
  $("#footer-plugins").onclick = () => navigate("plugins");
  $("#footer-settings").onclick = () => navigate("settings");
}
function render() {
  if (page === "launcher") renderLauncher();
  if (page === "plugins") renderPlugins();
  if (page === "settings") renderSettings();
  if (page === "chat") renderChat();
  if (page === "actions") renderActions();
}
function renderLauncher() {
  $("#view").innerHTML =
    `<section class="searchbox">${icon("search")}<input id="query" aria-label="Search apps or commands" role="combobox" aria-expanded="true" aria-controls="results" aria-autocomplete="list" placeholder="Search for an app, run a command…" autocomplete="off" spellcheck="false" value="${esc(query)}"/><button class="ai-shortcut" id="quick-ai" title="Ask AI (Ctrl+J)">${icon("spark")}<span>Ask AI</span><kbd>Ctrl J</kbd></button></section><nav class="tabs" aria-label="Search category">${[
      ["all", "All"],
      ["apps", "Apps"],
      ["ai", "AI commands"],
    ]
      .map(
        ([id, label]) =>
          `<button data-filter="${id}" class="${filter === id ? "selected" : ""}">${label}</button>`,
      )
      .join(
        "",
      )}<span class="local-label">${desktop ? "On your machine" : "Browser preview"}</span></nav><section class="results-area"><div class="section-label"><span id="result-heading">Suggestions</span><span id="result-count"></span></div><div id="results" role="listbox" aria-label="Search results"></div></section><div class="launcher-hint"><span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open</span><span>Your tools. Your models.</span></div>`;
  const input = $<HTMLInputElement>("#query");
  input.oninput = () => {
    query = input.value;
    selection = 0;
    renderResults();
  };
  input.onkeydown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      selection = results.length
        ? (selection + (event.key === "ArrowDown" ? 1 : -1) + results.length) %
          results.length
        : 0;
      updateSelection();
    }
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      const command = results[selection];
      if (command) guarded(command.run)();
    }
  };
  $("#quick-ai").onclick = () => navigate("chat");
  root
    .querySelectorAll<HTMLButtonElement>("[data-filter]")
    .forEach((button) => {
      button.onclick = () => {
        filter = button.dataset.filter!;
        selection = 0;
        rebuildIndex();
        renderLauncher();
      };
    });
  renderResults();
  input.focus();
}
function renderResults() {
  const started = performance.now();
  results = index.search(query);
  searchMs = performance.now() - started;
  if (query.trim() && filter !== "apps") {
    const text = query.trim();
    if (runtime.has(`ai.${settings.selected}`))
      results.push({
        id: "ask-query",
        title: `Ask AI: ${text}`,
        subtitle: providerInfo.find((p) => p.id === settings.selected)!.name,
        keywords: "",
        icon: "spark",
        kind: "ai",
        run: () => {
          navigate("chat");
          return ask(text);
        },
      });
    if (filter === "all")
      results.push({
        id: "web-query",
        title: `Search the web: ${text}`,
        subtitle: "Open in your default browser",
        keywords: "",
        icon: "globe",
        kind: "command",
        run: () =>
          openUrl(
            `https://www.google.com/search?q=${encodeURIComponent(text)}`,
          ),
      });
  }
  selection = Math.min(selection, Math.max(0, results.length - 1));
  $("#result-heading").textContent = query.trim()
    ? "Search results"
    : filter === "apps"
      ? "Applications"
      : "At your fingertips";
  $("#result-count").textContent = !indexed
    ? "Loading apps…"
    : `${results.length} results`;
  $("#results").innerHTML = results.length
    ? results
        .map(
          (command, i) =>
            `<button id="result-${i}" role="option" aria-selected="${i === selection}" class="result ${i === selection ? "selected" : ""}" data-index="${i}" tabindex="-1"><span class="command-icon ${command.kind === "ai" ? "lime" : ""}">${icon(command.icon)}</span><span class="result-text"><strong>${esc(command.title)}</strong><small>${esc(command.subtitle)}</small></span><span class="result-kind">${command.kind === "ai" ? "AI" : command.kind === "app" ? "Application" : "Command"}</span><span class="enter">↵</span></button>`,
        )
        .join("")
    : `<div class="empty">${icon("search")}<strong>${!indexed ? "Your apps are loading" : "No apps found"}</strong><p>${desktop ? "Try another search term or refresh the app index." : "Open the desktop app to search your Windows apps."}</p></div>`;
  root.querySelectorAll<HTMLButtonElement>("[data-index]").forEach((button) => {
    button.onclick = guarded(() => results[Number(button.dataset.index)].run());
  });
  $<HTMLInputElement>("#query").setAttribute(
    "aria-activedescendant",
    results.length ? `result-${selection}` : "",
  );
  $("#footer-status").textContent =
    `${desktop ? `${apps.length} apps` : "Local interface preview"} · ${searchMs.toFixed(1)} ms search`;
}
function updateSelection() {
  root.querySelectorAll<HTMLElement>("[data-index]").forEach((row) => {
    const selected = Number(row.dataset.index) === selection;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
    if (selected) row.scrollIntoView({ block: "nearest" });
  });
  $("#query").setAttribute("aria-activedescendant", `result-${selection}`);
}
function heading(title: string, subtitle: string) {
  return `<div class="page-heading"><button id="back" class="icon-button" aria-label="Back to launcher">${icon("back")}</button><div><h1>${title}</h1><p>${subtitle}</p></div></div>`;
}
function bindBack() {
  $("#back").onclick = () => navigate("launcher");
}
function renderPlugins() {
  $("#view").innerHTML =
    `${heading("A launcher that grows with you.", "Small plugins. Together, just what you need.")}<section class="plugin-body"><div class="section-label"><span>AI providers</span><span>3 built in</span></div><div class="provider-grid">${providerInfo
      .map((info) => {
        const enabled = settings.providers[info.id].enabled;
        return `<article class="provider-card"><div class="card-top"><span class="provider-mark ${info.color}">${info.mark}</span><button role="switch" aria-checked="${enabled}" aria-label="Enable ${info.name}" data-toggle="${info.id}" class="switch ${enabled ? "on" : ""}"><span></span></button></div><h2>${info.name}</h2><p>${info.description}</p><div class="card-bottom"><span>${info.transport}</span><button class="text-button" data-config="${info.id}" aria-label="Configure ${info.name}">${icon("arrow")}</button></div></article>`;
      })
      .join(
        "",
      )}</div><div class="section-label"><span>Launcher plugins</span><span>Context runtime</span></div><div class="extension-row"><span class="command-icon">${icon("grid")}</span><div><strong>Essentials</strong><small>Settings, app index and system commands</small></div><button role="switch" aria-label="Enable Essentials" aria-checked="${settings.plugins["commands.essentials"]}" id="toggle-essentials" class="switch ${settings.plugins["commands.essentials"] ? "on" : ""}"><span></span></button></div><div class="composition-note"><span class="small-spark">${icon("plug")}</span><p>Plugins activate when their dependencies are available.<br/>Disabling them automatically cleans up connections and commands.</p></div></section>`;
  bindBack();
  root
    .querySelectorAll<HTMLButtonElement>("[data-toggle]")
    .forEach((button) => {
      button.onclick = guarded(async () => {
        button.disabled = true;
        const id = button.dataset.toggle!;
        const enabled = !settings.providers[id].enabled;
        await runtime.setEnabled(`provider.${id}`, enabled);
        settings.providers[id].enabled = enabled;
        await saveSettings(settings);
        rebuildIndex();
        renderPlugins();
      });
    });
  root
    .querySelectorAll<HTMLButtonElement>("[data-config]")
    .forEach((button) => {
      button.onclick = () => {
        configured = button.dataset.config!;
        navigate("settings");
      };
    });
  $("#toggle-essentials").onclick = guarded(async () => {
    settings.plugins["commands.essentials"] =
      !settings.plugins["commands.essentials"];
    await runtime.setEnabled(
      "commands.essentials",
      settings.plugins["commands.essentials"],
    );
    await saveSettings(settings);
    rebuildIndex();
    renderPlugins();
  });
  $("#footer-status").textContent =
    `${runtime.status().filter((s) => s.state === "active").length} components active · providers start on demand`;
}
function renderSettings() {
  const info = providerInfo.find((p) => p.id === configured)!;
  const config = settings.providers[configured];
  $("#view").innerHTML =
    `${heading("Your AI, your choice.", "Connect a provider and choose your model.")}<section class="settings-layout"><aside class="settings-nav">${providerInfo.map((p) => `<button data-provider="${p.id}" class="${configured === p.id ? "selected" : ""}"><span class="mini-mark ${p.color}">${p.mark}</span>${p.name}<span class="nav-dot ${settings.providers[p.id].enabled ? "enabled" : ""}"></span></button>`).join("")}<div class="settings-note"><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Space</kbd><p>Open the launcher anywhere in Windows.</p></div></aside><form id="config-form" class="config-form"><div class="config-title"><h2>${info.name}</h2><span class="badge">${config.enabled ? "Enabled" : "Disabled"}</span></div>${configured === "ollama" ? `<label>Server address<input name="endpoint" value="${esc(config.endpoint)}" placeholder="http://127.0.0.1:11434" required/></label>` : `<div class="form-grid"><label>Agent executable<input name="command" value="${esc(config.command)}" placeholder="${configured === "codex" ? "codex" : "path/to/agent.exe"}" required/></label><label>Arguments <span>JSON array</span><input name="args" value="${esc(JSON.stringify(config.args))}" placeholder='["--acp"]' required/></label></div><label>Working directory <span>optional</span><input name="cwd" value="${esc(config.cwd)}" placeholder="Default: dedicated Gogogadget workspace"/></label>`}<label>Model<div class="model-field"><input name="model" list="models" value="${esc(config.model)}" placeholder="${configured === "ollama" ? "e.g. qwen3:8b" : "Agent default"}"/><button id="load-models" type="button" class="secondary">${icon("refresh")} Fetch</button></div><datalist id="models">${(modelCache[configured] ?? []).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</datalist></label><p id="connection-status" class="field-help" role="status">${configured === "ollama" ? "Start Ollama and download a model first. Models load only when you ask a question." : configured === "codex" ? "Uses your existing Codex login. Requests run in a read-only sandbox." : "Use an installed ACP agent. Sign in through its CLI first. Permission requests are denied."}</p><div class="form-actions"><label class="checkbox"><input type="checkbox" name="selected" ${settings.selected === configured ? "checked" : ""}/> Use as my AI provider</label><button class="primary" type="submit">Save ${icon("arrow")}</button></div><p class="privacy-note">${desktop ? "Settings stay on this computer." : "Browser preview · AI connections are available in the desktop app."}</p></form></section>`;
  bindBack();
  root
    .querySelectorAll<HTMLButtonElement>("[data-provider]")
    .forEach((button) => {
      button.onclick = () => {
        discovery?.abort();
        configured = button.dataset.provider!;
        renderSettings();
      };
    });
  const readForm = () => {
    const data = new FormData($<HTMLFormElement>("#config-form"));
    const next = { ...config, model: String(data.get("model") ?? "").trim() };
    if (configured === "ollama") {
      next.endpoint = String(data.get("endpoint")).trim();
      const url = new URL(next.endpoint);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Use an HTTP(S) server address.");
    } else {
      next.command = String(data.get("command")).trim();
      next.cwd = String(data.get("cwd") ?? "").trim();
      next.args = JSON.parse(String(data.get("args")));
      if (
        !Array.isArray(next.args) ||
        !next.args.every((a) => typeof a === "string")
      )
        throw new Error("Arguments must be a JSON array of strings.");
      if (!next.command) throw new Error("Enter an agent executable.");
    }
    return { next, selected: data.has("selected") };
  };
  $<HTMLFormElement>("#config-form").onsubmit = (event) => {
    event.preventDefault();
    guarded(async () => {
      const { next, selected } = readForm();
      settings.providers[configured] = {
        ...next,
        enabled: selected || next.enabled,
      };
      if (selected) {
        if (settings.selected !== configured) {
          conversationEpoch++;
          replacementToken = undefined;
          conversation = [];
        }
        settings.selected = configured;
      }
      await saveSettings(settings);
      await rebuild();
      renderSettings();
      toast("Settings saved");
    })();
  };
  $("#load-models").onclick = guarded(async () => {
    const { next } = readForm();
    const id = configured;
    discovery?.abort();
    const controller = new AbortController();
    discovery = controller;
    const button = $<HTMLButtonElement>("#load-models");
    button.disabled = true;
    const status = $("#connection-status");
    status.textContent = "Connecting and fetching models…";
    let temporary: Provider | undefined;
    try {
      temporary =
        id === "ollama"
          ? (await import("./plugins/ollama")).createProvider(host, next)
          : (await import("./plugins/agent")).createAgentProvider(
              id as "acp" | "codex",
              host,
              next,
            );
      const models = await temporary.models(controller.signal);
      controller.signal.throwIfAborted();
      modelCache[id] = models;
      $("#models").innerHTML = models
        .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`)
        .join("");
      const input = $<HTMLInputElement>("input[name=model]");
      if (!input.value && models.length) input.value = models[0].id;
      status.textContent = models.length
        ? `${models.length} models found. Choose a model and save.`
        : "Connected. This agent does not provide a model list; use its default.";
    } catch (e) {
      if (!controller.signal.aborted) status.textContent = String(e);
    } finally {
      await temporary?.dispose();
      button.disabled = false;
      if (discovery === controller) discovery = undefined;
    }
  });
  $("#footer-status").textContent =
    "Models are fetched directly from your provider";
}
async function persistActions(next: TextAction[]) {
  if (savingActions) throw new Error("An action is already being saved.");
  const value = { ...settings, actions: parseActions(next) };
  savingActions = true;
  try {
    await saveSettings(value);
    settings.actions = value.actions;
    rebuildIndex();
  } finally {
    savingActions = false;
  }
}
async function runTextAction(action: TextAction) {
  if (active || replacing)
    throw new Error("Stop the current response before running a text action.");
  const prompt = actionPrompt(action, selectedText);
  provider();
  conversationEpoch++;
  conversation = [];
  replacementToken = selectionToken;
  response = "";
  chatError = "";
  navigate("chat");
  await ask(prompt, false, `${action.title}\n\n${selectedText}`);
}
function renderActions() {
  const current = settings.actions.find((a) => a.id === editingAction);
  const proposal = actionProposal;
  $("#view").innerHTML =
    `${heading("Text actions", "Select text in another app, then press Ctrl+Alt+T.")}<nav class="tabs"><button id="use-actions" class="${managingActions ? "" : "selected"}">Use actions</button><button id="manage-actions" class="${managingActions ? "selected" : ""}">Manage actions</button></nav><section class="actions-body">${
      managingActions
        ? `
    <form id="action-ai-form" class="action-ai"><label for="action-request">Describe an action to add, change or remove</label><div class="model-field"><input id="action-request" maxlength="2000" value="${esc(actionRequest)}" placeholder="Add an action that explains selected code" ${actionGeneration ? "disabled" : ""}/><button class="secondary" type="submit">${actionGeneration ? "Stop" : "Create proposal"}</button></div><p class="field-help">Uses your selected AI provider. Review the proposal before saving.</p></form>
    ${actionError ? `<p class="chat-error" role="alert">${esc(actionError)}</p>` : ""}
    ${proposal ? `<form id="proposal-form" class="action-proposal config-form"><strong>${proposal.operation === "delete" ? "Remove action" : "Review action"}</strong>${proposal.operation === "delete" ? `<p>${esc(settings.actions.find((a) => a.id === proposal.id)?.title ?? proposal.id)}</p>` : `<label>Title<input name="title" maxlength="80" required value="${esc(proposal.title)}"/></label><label>Instructions<textarea name="instructions" maxlength="3000" rows="4" required>${esc(proposal.prompt)}</textarea></label>`}<div class="form-actions"><button type="button" id="discard-proposal" class="secondary">Discard</button><button class="primary" type="submit">${proposal.operation === "delete" ? "Remove action" : "Save action"}</button></div></form>` : ""}
    <form id="action-editor" class="config-form action-editor"><div class="form-grid"><label>Action<select id="action-choice"><option value="">New action</option>${settings.actions.map((a) => `<option value="${esc(a.id)}" ${a.id === editingAction ? "selected" : ""}>${esc(a.title)}</option>`).join("")}</select></label><label>Title<input name="title" maxlength="80" value="${esc(current?.title ?? "")}" placeholder="Explain with AI" required/></label></div><label>Instructions<textarea name="instructions" maxlength="3000" rows="3" placeholder="Explain the selected text clearly, with examples." required>${esc(current?.prompt ?? "")}</textarea></label><p class="field-help">Selected text is appended automatically. Change the translation language or writing style here.</p><div class="form-actions"><label class="checkbox"><input type="checkbox" name="enabled" ${current?.enabled !== false ? "checked" : ""}/> Enabled</label>${current ? `<button id="delete-action" type="button" class="secondary">Delete action</button>` : ""}<button type="submit" class="primary">${current ? "Save changes" : "Add action"}</button></div></form>
  `
        : `
    <label for="selected-text">Selected text <span id="selection-count">${selectedText.length.toLocaleString()} characters</span></label><textarea id="selected-text" maxlength="100000" rows="5" placeholder="Selected text appears here. You can also paste or type text.">${esc(selectedText)}</textarea>
    ${selectionError ? `<p class="field-help" role="status">${esc(selectionError)}</p>` : ""}<p class="field-help">Only sent to ${esc(providerInfo.find((p) => p.id === settings.selected)!.name)} when you choose an action. The result opens in chat; copy it back when ready.</p><div class="text-action-list">${
      settings.actions
        .filter((a) => a.enabled)
        .map(
          (a) =>
            `<button class="text-action" data-text-action="${esc(a.id)}">${icon("spark")}<span>${esc(a.title)}</span>${icon("arrow")}</button>`,
        )
        .join("") || `<p>No enabled actions. Add one in Manage actions.</p>`
    }</div>
  `
    }</section>`;
  bindBack();
  $("#use-actions").onclick = () => {
    actionGeneration?.abort();
    managingActions = false;
    renderActions();
  };
  $("#manage-actions").onclick = () => {
    managingActions = true;
    renderActions();
  };
  $("#footer-status").textContent =
    "Text actions · your prompts, your AI provider";
  if (!managingActions) {
    $<HTMLTextAreaElement>("#selected-text").oninput = (event) => {
      selectionToken = undefined;
      selectedText = (event.target as HTMLTextAreaElement).value;
      $("#selection-count").textContent =
        `${selectedText.length.toLocaleString()} characters`;
    };
    root
      .querySelectorAll<HTMLButtonElement>("[data-text-action]")
      .forEach((button) => {
        button.onclick = guarded(() =>
          runTextAction(
            settings.actions.find((a) => a.id === button.dataset.textAction)!,
          ),
        );
      });
    (
      root.querySelector<HTMLButtonElement>("[data-text-action]") ??
      $("#selected-text")
    ).focus();
    return;
  }
  $<HTMLInputElement>("#action-request").oninput = (event) => {
    actionRequest = (event.target as HTMLInputElement).value;
  };
  $<HTMLFormElement>("#action-ai-form").onsubmit = (event) => {
    event.preventDefault();
    if (actionGeneration) actionGeneration.abort();
    else guarded(generateAction)();
  };
  $<HTMLSelectElement>("#action-choice").onchange = (event) => {
    editingAction = (event.target as HTMLSelectElement).value;
    renderActions();
  };
  $<HTMLFormElement>("#action-editor").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    guarded(async () => {
      const data = new FormData(form);
      const action: TextAction = {
        id: current?.id ?? crypto.randomUUID(),
        title: String(data.get("title")),
        prompt: String(data.get("instructions")),
        enabled: data.has("enabled"),
      };
      await persistActions(
        current
          ? settings.actions.map((a) => (a.id === current.id ? action : a))
          : [...settings.actions, action],
      );
      editingAction = action.id;
      if (page === "actions") renderActions();
      toast("Action saved");
    })();
  };
  if (current)
    $("#delete-action").onclick = guarded(async () => {
      await persistActions(settings.actions.filter((a) => a.id !== current.id));
      editingAction = "";
      if (page === "actions") renderActions();
      toast("Action removed");
    });
  if (proposal) {
    $("#discard-proposal").onclick = () => {
      actionProposal = undefined;
      renderActions();
    };
    $<HTMLFormElement>("#proposal-form").onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      guarded(async () => {
        const edited =
          proposal.operation === "delete"
            ? proposal
            : {
                ...proposal,
                title: String(data.get("title")),
                prompt: String(data.get("instructions")),
              };
        await persistActions(applyProposal(settings.actions, edited));
        actionProposal = undefined;
        actionRequest = "";
        if (page === "actions") renderActions();
        toast("Action changes saved");
      })();
    };
  }
}
async function generateAction() {
  if (!actionRequest.trim() || actionGeneration) return;
  if (actionRequest.length > 2000)
    throw new Error("Describe your action in at most 2,000 characters.");
  if (active)
    throw new Error(
      "Stop the current chat response before creating an action.",
    );
  const ai = provider();
  const controller = new AbortController();
  actionGeneration = controller;
  actionProposal = undefined;
  actionError = "";
  const request = proposalPrompt(actionRequest, settings.actions);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(60_000),
  ]);
  renderActions();
  let output = "";
  try {
    await ai.complete({
      model: settings.providers[settings.selected].model,
      messages: [{ role: "user", content: request }],
      signal,
      onStatus() {},
      onText(chunk) {
        if (controller.signal.aborted) return;
        output += chunk;
        if (output.length > 16_000) {
          actionError = "Action proposal is too large. Try a shorter request.";
          controller.abort();
        }
      },
    });
    signal.throwIfAborted();
    actionProposal = parseProposal(output, settings.actions);
  } catch (e) {
    actionError = controller.signal.aborted
      ? actionError || "Action generation stopped."
      : String(e);
  } finally {
    if (actionGeneration === controller) actionGeneration = undefined;
    if (page === "actions") renderActions();
  }
}
function renderChat() {
  markdownLoading ??= import("./core/markdown")
    .then((module) => {
      markdown = module.renderMarkdown;
      renderConversation();
    })
    .catch((error) => {
      markdownLoading = undefined;
      toast(String(error));
    });
  $("#view").innerHTML =
    `<div class="chat-heading"><button id="back" class="icon-button" aria-label="Back to launcher">${icon("back")}</button><span>${icon("spark")} Ask AI</span><div class="chat-select"><select id="chat-provider" aria-label="AI provider" ${active ? "disabled" : ""}>${providerInfo.map((p) => `<option value="${p.id}" ${settings.selected === p.id ? "selected" : ""} ${settings.providers[p.id].enabled ? "" : "disabled"}>${p.name}</option>`).join("")}</select><button id="chat-model" class="text-button">${esc(settings.providers[settings.selected].model || "Set model")} ${icon("settings")}</button></div><button class="icon-button" id="new-chat" aria-label="New conversation">${icon("refresh")}</button></div><div id="conversation" class="conversation" role="log" aria-label="AI conversation"></div><form id="prompt-form" class="prompt-form"><textarea id="prompt" rows="2" placeholder="What would you like to know or create?" aria-label="Your question" ${active ? "disabled" : ""}></textarea><div class="prompt-bottom"><span><kbd>Enter</kbd> send <span class="dot-separator">·</span> <kbd>Shift ↵</kbd> new line</span><button class="send-button" id="send" type="submit" aria-label="${active ? "Stop response" : "Send question"}">${active ? "■" : icon("arrow")}</button></div></form>`;
  bindBack();
  renderConversation();
  $("#chat-model").onclick = () => {
    configured = settings.selected;
    navigate("settings");
  };
  $<HTMLSelectElement>("#chat-provider").onchange = guarded(async () => {
    replacementToken = undefined;
    settings.selected = $<HTMLSelectElement>("#chat-provider").value;
    conversation = [];
    response = "";
    chatError = "";
    await saveSettings(settings);
    rebuildIndex();
    renderChat();
  });
  $("#new-chat").onclick = () => {
    replacementToken = undefined;
    active?.abort();
    conversationEpoch++;
    conversation = [];
    response = "";
    chatError = "";
    chatStatus = "";
    renderChat();
  };
  $<HTMLFormElement>("#prompt-form").onsubmit = (event) => {
    event.preventDefault();
    if (active) active.abort();
    else guarded(() => ask($<HTMLTextAreaElement>("#prompt").value))();
  };
  $<HTMLTextAreaElement>("#prompt").onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $<HTMLFormElement>("#prompt-form").requestSubmit();
    }
  };
  if (!active) $("#prompt").focus();
  $("#footer-status").textContent = active
    ? "Streaming response…"
    : `${providerInfo.find((p) => p.id === settings.selected)!.name} · sends only what you enter here`;
}
function renderConversation() {
  if (page !== "chat") return;
  const container = $("#conversation");
  const atBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 70;
  if (!conversation.length && !active && !response && !chatError) {
    container.innerHTML = `<div class="chat-empty"><span class="ai-orb">${icon("spark")}</span><h2>Room for your next idea.</h2><p>A quick question, a fresh perspective or a first draft.<br/>Think it through with your model.</p><div class="suggestions"><button data-prompt="Help me make a clear plan for ">Make a plan ${icon("arrow")}</button><button data-prompt="Explain in simple terms: ">Explain something ${icon("arrow")}</button></div></div>`;
    root.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((b) => {
      b.onclick = () => {
        $<HTMLTextAreaElement>("#prompt").value = b.dataset.prompt!;
        $("#prompt").focus();
      };
    });
    return;
  }
  container.innerHTML = `${conversation.map((m) => `<article class="message ${m.role}"><span class="message-label">${m.role === "user" ? "YOU" : "GOGOGADGET"}</span><div class="message-content">${m.role === "assistant" && markdown ? markdown(m.content) : esc(m.content)}</div></article>`).join("")}${active || response ? `<article class="message assistant"><span class="message-label">GOGOGADGET <span class="stream-dot ${active ? "pulsing" : ""}"></span></span><div class="message-content">${markdown ? markdown(response) : esc(response)}</div>${active ? `<p class="stream-status">${esc(chatStatus || "Connecting…")}</p>` : ""}</article>` : ""}${chatError ? `<div class="chat-error" role="alert">${esc(chatError)}</div>` : ""}${!active && conversation.some((m) => m.role === "assistant") ? `<div class="response-actions"><button id="copy-answer" class="copy-button">${icon("copy")} Copy response</button>${desktop && replacementToken && !chatError ? `<button id="replace-answer" class="copy-button">${icon("arrow")} Replace selection</button>` : ""}</div>` : ""}`;
  container.onclick = (event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
      "a[href]",
    );
    if (!link) return;
    event.preventDefault();
    guarded(() => openUrl(link.href))();
  };
  const replace = root.querySelector<HTMLButtonElement>("#replace-answer");
  if (replace)
    replace.onclick = guarded(async () => {
      if (!replacementToken || active || replacing) return;
      const token = replacementToken;
      const answer = [...conversation]
        .reverse()
        .find((m) => m.role === "assistant")!.content;
      replacing = true;
      replacementToken = undefined;
      selectionToken = undefined;
      replace.disabled = true;
      replace.textContent = "Replacing…";
      try {
        await replaceSelection(token, answer);
        toast("Replacement sent to the original text field");
      } finally {
        replacing = false;
        renderConversation();
      }
    });
  const copy = root.querySelector<HTMLElement>("#copy-answer");
  if (copy)
    copy.onclick = guarded(async () => {
      await navigator.clipboard.writeText(
        [...conversation].reverse().find((m) => m.role === "assistant")!
          .content,
      );
      toast("Response copied");
    });
  if (atBottom) container.scrollTop = container.scrollHeight;
}
async function ask(text: string, allowManagement = true, displayText = text) {
  text = text.trim();
  if (!text || active || replacing) return;
  if (allowManagement && isActionRequest(text)) {
    actionRequest = text;
    managingActions = true;
    navigate("actions");
    await generateAction();
    return;
  }
  let ai: Provider;
  try {
    ai = provider();
  } catch (e) {
    toast(String(e));
    return;
  }
  const controller = new AbortController();
  const epoch = conversationEpoch;
  active = controller;
  const message: Message = { role: "user", content: displayText.trim() };
  if (!allowManagement) actionInputs.set(message, text);
  conversation.push(message);
  response = "";
  chatError = "";
  chatStatus = "Connecting…";
  const history = conversation.slice(-20).map((message) => ({
    ...message,
    content: actionInputs.get(message) ?? message.content,
  }));
  let frame: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    if (!frame)
      frame = setTimeout(
        () => {
          frame = undefined;
          if (page !== "chat") return;
          const container = $("#conversation");
          const atBottom =
            container.scrollHeight -
              container.scrollTop -
              container.clientHeight <
            70;
          const content = container.querySelector(
            ".message:last-of-type .message-content",
          );
          if (content) {
            if (markdown) content.innerHTML = markdown(response);
            else content.textContent = response;
          }
          const status = container.querySelector(".stream-status");
          if (status) status.textContent = chatStatus;
          if (atBottom) container.scrollTop = container.scrollHeight;
        },
        response.length > 50_000 ? 250 : 80,
      );
  };
  renderChat();
  try {
    await ai.complete({
      model: settings.providers[settings.selected].model,
      messages: history,
      signal: controller.signal,
      onText(chunk) {
        if (controller.signal.aborted) return;
        if (response.length + chunk.length > 500_000) {
          controller.abort();
          chatError = "Response limit reached (500,000 characters).";
          return;
        }
        response += chunk;
        chatStatus = "Receiving response…";
        update();
      },
      onStatus(status) {
        if (!controller.signal.aborted) {
          chatStatus = status;
          update();
        }
      },
    });
    if (!response.trim() && !controller.signal.aborted)
      chatError = "The provider returned no text response.";
  } catch (e) {
    if (epoch === conversationEpoch)
      chatError = controller.signal.aborted
        ? chatError || "Response stopped."
        : String(e);
  } finally {
    clearTimeout(frame);
    if (response && epoch === conversationEpoch)
      conversation.push({ role: "assistant", content: response });
    conversation = conversation.slice(-40);
    response = "";
    active = undefined;
    if (page === "chat") renderChat();
  }
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    if (active) active.abort();
    else if (page !== "launcher") navigate("launcher");
    else if (query) {
      query = "";
      selection = 0;
      renderLauncher();
    } else void hide();
  }
  if (event.ctrlKey && event.key.toLowerCase() === "j") {
    event.preventDefault();
    navigate("chat");
  }
  if (event.ctrlKey && event.key === ",") {
    event.preventDefault();
    navigate("settings");
  }
});
async function boot() {
  if (desktop) document.documentElement.classList.add("desktop");
  shell();
  try {
    settings = await loadSettings();
    configured = settings.selected;
  } catch (e) {
    toast(`Failed to load settings: ${e}`);
  }
  await rebuild();
  render();
  void refreshApps();
  await onFocus(() => {
    if (page === "launcher") $("#query").focus();
    else if (page === "chat" && !active) $("#prompt").focus();
  });
  await onSelection(({ text, error, token }) => {
    selectionToken = token ?? undefined;
    replacementToken = undefined;
    selectedText = text;
    selectionError = error;
    managingActions = false;
    navigate("actions");
  });
}
void boot().catch((e) => {
  root.textContent = `Gogogadget could not start: ${String(e)}`;
});
