export type CodeToken = { text: string; kind: "plain" | "string" | "keyword" | "call" };

// Landing snippets use double-quoted strings, so the pattern needs no other quote forms.
const tokenPattern = /("[^"]*")|\b(import|from|export|default|await|const|return)\b|([A-Za-z]+)(?=\()/g;

export function tokenize(line: string) {
  const tokens: CodeToken[] = [];
  let cursor = 0;
  for (const match of line.matchAll(tokenPattern)) {
    if (match.index > cursor) {
      tokens.push({ text: line.slice(cursor, match.index), kind: "plain" });
    }
    tokens.push({
      text: match[0],
      kind: match[1] ? "string" : match[2] ? "keyword" : "call",
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) {
    tokens.push({ text: line.slice(cursor), kind: "plain" });
  }
  return tokens;
}
