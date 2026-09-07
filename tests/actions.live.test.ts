/// <reference types="node" />
import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "../src/platform/bridge";
import { createAgentProvider } from "../src/plugins/agent";
import { defaults } from "../src/core/settings";
import {
  actionPrompt,
  applyProposal,
  parseProposal,
  proposalPrompt,
} from "../src/core/actions";

// Explicitly opt in with the path to an authenticated Codex binary. Sends two synthetic prompts.
it.skipIf(!process.env.GOGOGADGET_ACTION_CODEX_EXE)(
  "creates and executes a text action through the real Codex adapter",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gogogadget-action-test-"));
    const host: Host = {
      cwd: async () => cwd,
      http: async () => {
        throw new Error("Unused");
      },
      async process(config, receive) {
        const child = spawn(config.command, config.args, {
          cwd,
          windowsHide: true,
          stdio: "pipe",
        });
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (data) => receive({ type: "line", data }));
        child.stderr.resume();
        child.on("error", (error) =>
          receive({ type: "error", data: error.message }),
        );
        const exited = new Promise<void>((resolve) =>
          child.on("close", (code) => {
            receive({ type: "exit", data: code });
            resolve();
          }),
        );
        return {
          send: (message) =>
            new Promise<void>((resolve, reject) =>
              child.stdin.write(JSON.stringify(message) + "\n", (error) =>
                error ? reject(error) : resolve(),
              ),
            ),
          async close() {
            child.stdin.end();
            child.kill();
            await exited;
            lines.close();
          },
        };
      },
    };
    const settings = defaults();
    const ai = createAgentProvider("codex", host, {
      ...settings.providers.codex,
      command: process.env.GOGOGADGET_ACTION_CODEX_EXE!,
    });
    async function complete(prompt: string) {
      let output = "";
      await ai.complete({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: prompt }],
        signal: AbortSignal.timeout(60_000),
        onStatus() {},
        onText: (chunk) => {
          output += chunk;
        },
      });
      return output;
    }
    try {
      const output = await complete(
        proposalPrompt(
          "Voeg een actie toe waarmee ik geselecteerde code kan laten uitleggen met AI. Geef een korte uitleg in het Nederlands.",
          settings.actions,
        ),
      );
      const proposal = parseProposal(output, settings.actions);
      expect(proposal.operation).toBe("add");
      const actions = applyProposal(settings.actions, proposal);
      const answer = await complete(
        actionPrompt(
          actions[actions.length - 1],
          "const total = [1, 2, 3].reduce((sum, value) => sum + value, 0);",
        ),
      );
      expect(answer).toContain("6");
      console.log(
        "Live action:",
        actions[actions.length - 1].title,
        "— explanation received:",
        answer.length,
        "characters",
      );
    } finally {
      await ai.dispose();
      await rm(cwd, { recursive: true, force: true }); // Only the directory created by mkdtemp above.
    }
  },
  130_000,
);
