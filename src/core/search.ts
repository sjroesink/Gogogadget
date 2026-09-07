import type { Command } from "./types";
const normalize = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
export class SearchIndex {
  private rows: { command: Command; title: string; text: string }[] = [];
  update(commands: Command[]) {
    this.rows = commands.map((command) => ({
      command,
      title: normalize(command.title),
      text: normalize(`${command.title} ${command.keywords}`),
    }));
  }
  search(query: string, limit = 40): Command[] {
    const words = normalize(query).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return this.rows.slice(0, limit).map((r) => r.command);
    return this.rows
      .flatMap((row) => {
        let score = 0;
        for (const word of words) {
          const index = row.text.indexOf(word);
          if (index >= 0) {
            score +=
              row.title === word
                ? 1000
                : row.title.startsWith(word)
                  ? 500
                  : 200 - Math.min(index, 150);
            continue;
          }
          let at = -1,
            gap = 0;
          for (const char of word) {
            const next = row.title.indexOf(char, at + 1);
            if (next < 0) return [];
            gap += next - at - 1;
            at = next;
          }
          score += 30 - gap;
        }
        return [{ command: row.command, score }];
      })
      .sort(
        (a, b) =>
          b.score - a.score || a.command.title.localeCompare(b.command.title),
      )
      .slice(0, limit)
      .map((r) => r.command);
  }
}
