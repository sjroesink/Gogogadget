import { expect, it } from "vitest";
import { recordUsage, parseUsage, usageKey } from "../src/core/usage";
import { defaults, parseSettings } from "../src/core/settings";
import { SearchIndex } from "../src/core/search";
import type { Command } from "../src/core/types";
const app = (id: string): Command => ({
  id,
  title: id,
  subtitle: "",
  keywords: "",
  kind: "app",
  icon: "grid",
  run() {},
});
it("persists separate counters for identically named commands and apps", () => {
  const item = app("settings");
  let usage = recordUsage({}, item);
  usage = recordUsage(usage, item);
  usage = recordUsage(usage, { id: item.id, kind: "command" });
  expect(usage[usageKey(item)]).toBe(2);
  expect(usage["command:settings"]).toBe(1);
  const settings = parseSettings(
    JSON.parse(
      JSON.stringify({ ...defaults(), usage, sortOrder: "most-used" }),
    ),
  );
  expect(settings.usage).toEqual(usage);
  expect(settings.sortOrder).toBe("most-used");
});
it("migrates missing usage and rejects malformed counters", () => {
  expect(parseSettings({ version: 1 }).usage).toEqual({});
  expect(
    parseUsage({
      "app:valid": 7,
      "app:negative": -1,
      "app:fraction": 0.5,
      "app:string": "3",
      "app:infinite": Infinity,
      other: 2,
    }),
  ).toEqual({ "app:valid": 7 });
});
it("sorts the entire matching set by usage before limiting and excludes nonmatches", () => {
  const index = new SearchIndex();
  index.update([
    ...Array.from({ length: 60 }, (_, i) => app(`Editor ${i}`)),
    app("Browser"),
  ]);
  const usage = { "app:Editor 59": 10, "app:Browser": 100 };
  expect(index.search("Editor", 3, { order: "most-used", usage })[0].id).toBe(
    "Editor 59",
  );
  expect(
    index
      .search("Editor", 40, { order: "most-used", usage })
      .some((a) => a.id === "Browser"),
  ).toBe(false);
  expect(index.search("", 1, { order: "most-used", usage })[0].id).toBe(
    "Browser",
  );
  expect(index.search("", 1, { order: "name", usage })[0].id).toBe("Browser");
});
