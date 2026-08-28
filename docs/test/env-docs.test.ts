import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");

function envCalls(source: string) {
  const calls: string[] = [];
  const declarationStarts = ["env(", "env.variable("];

  for (let start = 0; start < source.length; start++) {
    const character = source[start] || "";
    const next = source[start + 1] || "";
    if (character === "/" && next === "/") {
      start = source.indexOf("\n", start + 2);
      if (start === -1) break;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", start + 2);
      if (end === -1) break;
      start = end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      for (start += 1; start < source.length; start++) {
        if (source[start] === "\\") start += 1;
        else if (source[start] === character) break;
      }
      continue;
    }
    const declarationStart = declarationStarts.find((candidate) =>
      source.startsWith(candidate, start),
    );
    if (!declarationStart || /[\w$]/.test(source[start - 1] || "")) {
      continue;
    }

    let depth = 0;
    let quote = "";
    let escaped = false;
    let comment = "";

    for (let index = start + declarationStart.length; index < source.length; index++) {
      const character = source[index] || "";
      const next = source[index + 1] || "";
      if (comment === "line") {
        if (character === "\n") comment = "";
      } else if (comment === "block") {
        if (character === "*" && next === "/") {
          comment = "";
          index += 1;
        }
      } else if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
      } else if (character === "/" && next === "/") {
        comment = "line";
        index += 1;
      } else if (character === "/" && next === "*") {
        comment = "block";
        index += 1;
      } else if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) {
          calls.push(source.slice(start + declarationStart.length, index));
          start = index;
          break;
        }
        depth -= 1;
      }
    }
  }

  return calls;
}

interface EnvOptionToken {
  kind: "identifier" | "punctuation" | "string";
  value: string;
}

function envOptionTokens(source: string): EnvOptionToken[] {
  const tokens: EnvOptionToken[] = [];

  for (let index = 0; index < source.length; index++) {
    const character = source[index] || "";
    const next = source[index + 1] || "";
    if (/\s/.test(character)) continue;
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      let value = "";
      for (index += 1; index < source.length; index++) {
        const quoted = source[index] || "";
        if (quoted === "\\") {
          index += 1;
          value += source[index] || "";
        } else if (quoted === character) {
          break;
        } else {
          value += quoted;
        }
      }
      tokens.push({ kind: "string", value });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (/[\w$]/.test(source[end] || "")) end += 1;
      tokens.push({ kind: "identifier", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
  }

  return tokens;
}

function hasBuildMode(options: string): boolean {
  const tokens = envOptionTokens(options);
  let depth = 0;
  let isBuildMode = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.value === "{" || token.value === "[" || token.value === "(") {
      depth += 1;
      continue;
    }
    if (token.value === "}" || token.value === "]" || token.value === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;

    if (
      token.value === "." &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.value === "."
    ) {
      isBuildMode = false;
      continue;
    }

    if (token.value === "mode" && tokens[index + 1]?.value === ":") {
      isBuildMode = tokens[index + 2]?.kind === "string" && tokens[index + 2]?.value === "build";
    }
  }

  return isBuildMode;
}

function buildEnvCalls(source: string) {
  const codeBlocks = [...source.matchAll(/^```(?:ts|typescript)[^\n]*\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1] || "",
  );
  const calls: { options: string; section: "define" | "public" }[] = [];

  for (const code of codeBlocks) {
    const lines = code.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const opening = lines[index]?.match(/^(\s*)(define|public):\s*\{$/);
      if (!opening) continue;

      const indent = opening[1] || "";
      const section = opening[2] === "define" ? "define" : "public";
      const block: string[] = [];
      for (index += 1; index < lines.length; index++) {
        const line = lines[index] || "";
        if (line === `${indent}},`) break;
        block.push(line);
      }

      for (const options of envCalls(block.join("\n"))) {
        calls.push({ options, section });
      }
    }
  }

  return calls;
}

describe("Env documentation", () => {
  it("parses declarations with nested calls", () => {
    expect(
      envCalls(
        "env({ source: env.source('APP_NAME'), mode: 'build' }); env.variable({ mode: 'build' })",
      ),
    ).toEqual(["{ source: env.source('APP_NAME'), mode: 'build' }", "{ mode: 'build' }"]);
  });

  it("ignores declarations in comments and strings", () => {
    expect(
      envCalls(`
        // env({ mode: 'build' })
        const example = "env({ mode: 'build' })";
        env({ source: env.source('APP_NAME'), mode: 'build' })
        /* env({ mode: 'build' }) */
      `),
    ).toEqual(["{ source: env.source('APP_NAME'), mode: 'build' }"]);
  });

  it("requires an actual top-level build mode property", () => {
    expect(hasBuildMode("{ source: env.source('APP_NAME'), mode: 'build' }")).toBe(true);
    expect(hasBuildMode("{ default: \"mode: 'build'\" }")).toBe(false);
    expect(hasBuildMode("{ default: 'preview' /* mode: 'build' */ }")).toBe(false);
    expect(hasBuildMode("{ defaults: { mode: 'build' } }")).toBe(false);
    expect(hasBuildMode("{ mode: 'build', mode: 'runtime' }")).toBe(false);
    expect(hasBuildMode("{ mode: 'build', ...defaults }")).toBe(false);
    expect(hasBuildMode("{ ...defaults, mode: 'build' }")).toBe(true);
  });

  it("marks every documented build-backed Env declaration as build-time", async () => {
    const pages = [
      "content/docs/server-primitives/env.md",
      "content/docs/reference/config-options.md",
    ];
    const calls = (
      await Promise.all(pages.map((page) => readFile(resolve(docsRoot, page), "utf8")))
    ).flatMap(buildEnvCalls);

    expect(calls.filter(({ section }) => section === "public")).toHaveLength(3);
    expect(calls.filter(({ section }) => section === "define")).toHaveLength(1);
    for (const { options } of calls) {
      expect(hasBuildMode(options)).toBe(true);
    }
  });
});
