import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/core/markdown";

describe("chat Markdown", () => {
  it("renders headings, emphasis, lists, code and tables", () => {
    const html = renderMarkdown(
      "# Heading\n\n**Bold** and `code`\n\n- One\n- Two\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |",
    );
    for (const tag of [
      "<h1>",
      "<strong>",
      "<code>",
      "<ul>",
      "<pre>",
      "<table>",
    ])
      expect(html).toContain(tag);
  });
  it("keeps executable HTML, unsafe links and remote images inert", () => {
    const html = renderMarkdown(
      "<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) [file](file:///secret) ![alt](https://example.com/tracker)",
    );
    expect(html).not.toMatch(/<(script|img)|href=/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("alt");
  });
  it("renders HTTPS links and tolerates incomplete streamed fences", () => {
    expect(renderMarkdown("[Weather](https://example.com/weather)")).toContain(
      'href="https://example.com/weather"',
    );
    expect(renderMarkdown("```html\n<script>")).toContain("&lt;script&gt;");
  });
});
