import { it, expect } from "vitest";
import { SearchIndex } from "../src/core/search";
import { parseSettings } from "../src/core/settings";
import type { Command } from "../src/core/types";
const command = (title: string): Command => ({
  id: title,
  title,
  subtitle: "",
  keywords: title,
  kind: "app",
  icon: "grid",
  run() {},
});
it("ranks exact and prefix matches before fuzzy matches, handles accents and limits output", () => {
  const index = new SearchIndex();
  index.update(
    ["Visual Studio Code", "Code", "Code Editor", "Café", "Calculator"].map(
      command,
    ),
  );
  expect(index.search("code").map((c) => c.title)).toEqual([
    "Code",
    "Code Editor",
    "Visual Studio Code",
  ]);
  expect(index.search("vsc")[0].title).toBe("Visual Studio Code");
  expect(index.search("cafe")[0].title).toBe("Café");
  expect(index.search("impossible")).toEqual([]);
  expect(index.search("", 2)).toHaveLength(2);
});
it("does not accept malformed provider settings", () => {
  const settings = parseSettings({
    version: 1,
    selected: "__proto__",
    providers: { codex: { args: "unsafe", model: 42 } },
  });
  expect(settings.providers.codex.args).toEqual(["app-server"]);
  expect(settings.providers.codex.model).toBe("gpt-5.6-terra");
  expect(settings.selected).toBe("codex");
  expect(() => parseSettings({ version: 99 })).toThrow();
});
