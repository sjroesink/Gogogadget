# Gogogadget

A small, keyboard-driven AI launcher for Windows. Built with Tauri 2, Rust and TypeScript, using the system WebView without bundling a Node or Chromium runtime. Node is only needed for development and, optionally, for an agent you choose to connect.

## Getting started

The built executable is located at `src-tauri/target/release/gogogadget.exe`. After running `npm run desktop:build`, the NSIS installer is located in `src-tauri/target/release/bundle/nsis/`.

Open the app and press **Ctrl+Alt+Space** to show or hide the window. The system tray menu offers **Open Gogogadget** and **Quit**. Closing the window with the close button keeps the launcher running. No startup entry is created automatically.

| Shortcut | Action |
|---|---|
| Ctrl+Alt+Space | Show or hide the launcher, even from another app |
| Ctrl+Alt+T | Capture selected text and open text actions |
| ↑ / ↓, Enter | Select and open a result |
| Ctrl+J | AI conversation |
| Ctrl+, | Settings |
| Enter / Shift+Enter | Send a prompt / insert a new line |
| Esc | Stop a response, go back, clear the search field or hide the window |

The app indexes Windows Start apps once in the background. Searches stay local. You can refresh the index manually. AI is only called when you submit a prompt; a web search action opens your default browser.

## App icons and usage

Windows apps display their original program icons. Icons are fetched only when results come into view and are cached temporarily. If Windows cannot provide an icon, the generic app icon remains visible.

Choose **Best match**, **Most used** or **Name** above the results. **Most used** sorts matching items by how often you have opened them from the results list. The count appears next to each item. Counting starts with version 0.1.8 and is saved locally along with your preferred sort order. Launches outside Gogogadget are not tracked, and search queries are not stored.

## GitHub Releases

The **Release Windows** workflow automatically builds and publishes a release when you push a version tag such as `v0.1.8`. A regular branch push does not create a release. The tag must match the versions in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`; a mismatch stops the workflow.

For the next release, update those versions, commit and push your changes, then run, for example, `git tag v0.1.9` and `git push origin v0.1.9`. The workflow runs tests and Clippy, builds on Windows and publishes the standalone executable, NSIS installer and `SHA256SUMS.txt`. The release is published only after all assets have been uploaded. Failed runs can be rerun through GitHub Actions. The binaries are not yet signed with a Windows code-signing certificate.

## Text actions

Select text or code in another app and press **Ctrl+Alt+T**. Review the selection and choose **Translate with AI** or **Rewrite with AI**. The result appears in a new conversation with Markdown rendering. Clicking **Replace selection** writes the response back into the original text field; **Copy response** remains available for manual pasting. Replacement is available for a selection captured through the shortcut, as long as you have not manually changed that input. The translation action defaults to English; edit its instructions to choose another target language.

**Replace selection** checks the original field, text, both selection boundaries and editability before sending input to Windows. Changed, expired or non-editable selections are rejected. Each attempt consumes the replacement target, so you must select the text again after an error. The response is placed on the clipboard as complete Unicode text and pasted with a single Ctrl+V command, preserving any Markdown syntax. It stays on the clipboard so you can paste it manually if an error occurs. Text is no longer typed character by character.

Use **Manage actions** to add, edit, disable and delete actions. Each action has a unique ID, title, instructions and an enabled flag. Selected text is appended automatically as input. Actions use your selected provider and model; they are not executable scripts. They are stored locally in the `actions` field of `settings.json`. Existing installations receive the two default actions; a deliberately emptied list stays empty.

You can also ask **Ask AI** to “Add an action that explains selected text with AI”, or describe what you want to add, change or delete in **Manage actions**. AI produces a proposal that you can edit and save. If a request is not recognized automatically, start it with `/action`. Only directly entered management requests open this flow; selected text and AI responses cannot change actions on their own.

Windows selections are read on demand through UI Automation TextPattern, before the launcher takes focus. Capture does not poll or read or overwrite the clipboard. Password fields are skipped. Some apps and code editors do not expose their selection through accessibility APIs; in that case, copy and paste the text into the selection field. Stalled accessibility providers have up to 1.5 seconds before the paste field appears, with at most one capture worker active at a time. Selections are limited to 100,000 characters and remain in memory until an action uses them as chat input. macOS and Linux still need a native adapter for this feature.

## Configuring providers

Open **Settings**, choose a provider, enter a model or use **Fetch**, then click **Save**. New installations default to Codex with `gpt-5.6-terra`. **Use as my AI provider** selects the active provider. Providers can be enabled and disabled individually under **Plugins**.

### Ollama

Start an existing Ollama installation. The default address is `http://127.0.0.1:11434`. Download a model yourself using the Ollama CLI, fetch the model list and select a model. There is no built-in default model or automatic model download. The plugin uses `/api/tags` and streaming `/api/chat`. Local HTTP and HTTPS endpoints are supported; remote HTTP and redirects are rejected. Cloud API key authentication is not implemented yet.

### Codex

Install the Codex CLI and sign in with `codex login`. Configure the executable as `codex` and arguments as `["app-server"]`. On Windows, the official npm shim is resolved directly to its Node entry point; prompt text is never executed as a shell command. You can also configure a full path to `codex.exe`.

The plugin uses `initialize`, `initialized`, `model/list`, `thread/start`, `turn/start` and streaming notifications. An empty model field uses the agent's default. Tasks use a `read-only` sandbox, `approvalPolicy: never` and an ephemeral thread. The default working directory is a separate Gogogadget folder; a custom working directory is optional.

### ACP — Agent Client Protocol

First install and authenticate an ACP-compatible agent. Enter its native executable and arguments as a JSON array. For a JavaScript agent, use executable `node` and arguments such as `["C:/path/to/agent.js", "--acp"]`, adjusted for that agent. `.cmd` and `.bat` files are not executed through a shell. If you specify a working directory, it must exist.

ACP v1 over newline-delimited JSON-RPC/stdio is supported: initialization, new sessions, prompt streams and model selection through `configOptions` with category `model`, falling back to the older `models` interface. Not every ACP agent publishes a model list; leave the model field empty in that case. This client does not provide authentication, filesystem or terminal callbacks. Permission requests are answered with cancellation. An ACP agent is a local program with its own capabilities, not a Gogogadget sandbox.

Agent processes start for each model lookup or prompt and shut down afterward. On Windows, a Job Object tracks the process tree. Cancellation closes the connection and terminates the managed process tree. Ollama's external server keeps running, with a model keep-alive of 60 seconds.

## Development

Requirements: Windows 10/11, WebView2 Runtime, Node.js 22.12+, stable Rust and Visual Studio Build Tools with Desktop development with C++. Lockfiles are included in the repository.

```powershell
npm ci
npm run desktop
```

To preview just the interface, run `npm run dev` and open `http://127.0.0.1:1420`. The browser preview does not show fabricated apps or AI responses; native capabilities only work in the desktop app. Preview settings and desktop settings are separate.

```powershell
npm test
npm run bench
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run desktop:build
```

Regular tests use protocol fixtures and local transports. Optional native live tests query models from installed Codex/Ollama instances and start an ephemeral Codex thread without inference:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml installed_ -- --ignored --nocapture
```

For an explicit live inference test, also set `GOGOGADGET_LIVE_COMPLETION=1` and use `GOGOGADGET_TEST_MODEL` to choose a model from your Codex catalog. This sends one short test prompt. Both the CLI version and your account must support the model; its presence in the model list alone does not guarantee this.

`.npmrc` uses `legacy-peer-deps` because of an npm 10 resolver issue with optional Vitest browser peers. No browser test adapters are used.

## Composability

The runtime is inspired by [A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512). Plugins declare `requires` and `provides`, receive their own context and register cleanup functions for their effects. Dependent plugins reactivate when their services become available again. When disabling a provider, consumers are removed first, then the provider. Cleanup is awaited, including after partially failed activation.

This is a limited implementation of the principles, not an implementation of the full Cordis calculus or a formal proof of the paper. Cleanup applies to registered runtime effects. Launching an app, sending an AI request or changes made by external agents are not reversible runtime effects. See the [plugin architecture](docs/architecture.md) for details and an example.

## Current status

- Windows: native window, system tray, single instance, global shortcut, Start app index and app launching.
- Providers: three built-in plugins with loading on demand, configurable models, streaming, cancellation, error handling and timeouts.
- Plugins: source modules that can be disabled at runtime. An external plugin store, package installation and a sandbox for untrusted plugins have not been built yet.
- Chat: Markdown rendering with links, lists, tables and code blocks, response copying and starting a new conversation. The interface uses grayscale colors. Up to 40 messages remain in memory, with up to 20 included in a new prompt. There is no persistent conversation history. Agents may retain data according to their own configuration.
- Portability: the frontend, runtime and provider logic are platform independent. App indexing and process tree cleanup for macOS/Linux still need to be added and tested; Windows is currently the only supported target.
- The installer is not code-signed. Automatic updates, launching at startup, file search and clipboard history are outside the scope of this initial version.

Measurements and exact verification limits are documented in [validation.md](docs/validation.md).

Protocol references: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization), [ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options), [Ollama chat API](https://docs.ollama.com/api/chat), [Tauri](https://v2.tauri.app/start/).
