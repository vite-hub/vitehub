import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");

function publicEnvCalls(source: string) {
  const codeBlocks = [...source.matchAll(/^```(?:ts|typescript)[^\n]*\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1] || "",
  );
  const calls: string[] = [];

  for (const code of codeBlocks) {
    const lines = code.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const opening = lines[index]?.match(/^(\s*)public:\s*\{$/);
      if (!opening) continue;

      const indent = opening[1] || "";
      const block: string[] = [];
      for (index += 1; index < lines.length; index++) {
        const line = lines[index] || "";
        if (line === `${indent}},`) break;
        block.push(line);
      }

      for (const call of block.join("\n").matchAll(/env\(\{([^)]*)\}\)/g)) {
        calls.push(call[1] || "");
      }
    }
  }

  return calls;
}

describe("Env documentation", () => {
  it("marks every documented Public Env declaration as build-time", async () => {
    const pages = [
      "content/docs/server-primitives/env.md",
      "content/docs/reference/config-options.md",
    ];
    const calls = (
      await Promise.all(pages.map((page) => readFile(resolve(docsRoot, page), "utf8")))
    ).flatMap(publicEnvCalls);

    expect(calls).toHaveLength(3);
    for (const options of calls) {
      expect(options).toMatch(/\bmode:\s*["']build["']/);
    }
  });
});
