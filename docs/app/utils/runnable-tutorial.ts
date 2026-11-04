import type { DocsDocument } from "@vite-hub/docs";

type DocsNode = DocsDocument["nodes"][number];

export const tutorialRoute = "/tutorials";

export const playgroundRoute = "/playground";

/** Runnable tutorials: `/tutorials` and the pages under it. */
export function isIsolatedTutorialPath(path: string): boolean {
  return path === tutorialRoute || path.startsWith(`${tutorialRoute}/`);
}

/** The tutorials and the playground are cross-origin isolated. A link across that boundary must load a new document. */
export function isIsolatedPath(path: string): boolean {
  return isIsolatedTutorialPath(path) || path === playgroundRoute;
}

function isStep(node: DocsNode): boolean {
  return Array.isArray(node) && node[0] === "tutorial-step";
}

/** Splits a tutorial page into the prose before the first step, one node per `::tutorial-step`, and the prose after the last. */
export function splitTutorialDocument(nodes: readonly DocsNode[]): { intro: DocsNode[], steps: DocsNode[], outro: DocsNode[] } {
  const first = nodes.findIndex(isStep);
  const last = nodes.findLastIndex(isStep);
  if (first === -1) return { intro: [...nodes], steps: [], outro: [] };
  return {
    intro: nodes.slice(0, first),
    steps: nodes.slice(first, last + 1).filter(isStep),
    outro: nodes.slice(last + 1),
  };
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let started = false;
  const source = command.replace(/\\\n/g, " ");
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"" && index + 1 < source.length) current += source[++index];
      else current += char;
    }
    else if (char === "'" || char === "\"") {
      quote = char;
      started = true;
    }
    else if (/\s/.test(char)) {
      if (started || current) tokens.push(current);
      current = "";
      started = false;
    }
    else {
      current += char;
    }
  }
  if (started || current) tokens.push(current);
  return tokens;
}

export interface TutorialRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Reads the `curl` command of a lesson, such as `curl -X POST http://localhost:3000/api/greet -d '{}'`. Other commands return `undefined`. */
export function parseCurl(command: string): TutorialRequest | undefined {
  const tokens = tokenize(command.trim());
  if (tokens[0] !== "curl") return undefined;
  const request: TutorialRequest = { method: "", url: "", headers: {} };
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    const value = () => tokens[++index] ?? "";
    if (token === "-X" || token === "--request") request.method = value().toUpperCase();
    else if (token === "-H" || token === "--header") {
      const header = value();
      const colon = header.indexOf(":");
      if (colon > 0) request.headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
    }
    else if (token === "-d" || token === "--data" || token === "--data-raw") request.body = value();
    else if (token.startsWith("-")) return undefined;
    else request.url = token;
  }
  if (!/^https?:\/\/localhost(?::\d+)?\//.test(request.url)) return undefined;
  request.method ||= request.body === undefined ? "GET" : "POST";
  return request;
}

/** A Node script that sends the request from inside the workspace and prints the status and the body, like `curl`. */
export function requestScript(request: TutorialRequest): string {
  const init = { method: request.method, headers: request.headers, body: request.body };
  return [
    `const response = await fetch(${JSON.stringify(request.url)}, ${JSON.stringify(init)})`,
    `console.log(response.status + " " + response.statusText)`,
    `console.log(await response.text())`,
  ].join("\n");
}
