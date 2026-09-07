import { bench } from "vitest";
import { SearchIndex } from "../src/core/search";
const index = new SearchIndex();
index.update(
  Array.from({ length: 10_000 }, (_, i) => ({
    id: String(i),
    title: `Application ${i} editor`,
    subtitle: "",
    keywords: "tool productivity",
    kind: "app" as const,
    icon: "grid",
    run() {},
  })),
);
bench("10,000 commands, fuzzy search, top 40", () => {
  index.search("app 42");
});
