import MarkdownIt from "markdown-it";

const parser = new MarkdownIt({ html: false, breaks: true });
// Links open through the host; never load remote images inside a conversation.
parser.validateLink = (url) => /^https?:\/\//i.test(url);
parser.renderer.rules.image = (tokens, index) =>
  parser.utils.escapeHtml(tokens[index].content);

export function renderMarkdown(text: string): string {
  return parser.render(text);
}
