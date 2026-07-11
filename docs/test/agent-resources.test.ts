import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");
const contentRoot = resolve(docsRoot, "content/docs");
const aiResourcesRoot = resolve(contentRoot, "ai-resources");
const skillRoot = resolve(docsRoot, "skills/vitehub");

function listFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((entry) => {
      const path = resolve(root, entry);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

function readFiles(root: string) {
  return listFiles(root).map(path => ({
    path,
    source: readFileSync(path, "utf8"),
  }));
}

describe("public ViteHub skill", () => {
  it("keeps one compact model-invoked skill package", () => {
    expect(listFiles(skillRoot).map(path => relative(skillRoot, path))).toEqual([
      "SKILL.md",
      "agents/openai.yaml",
    ]);

    const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
    const description = skill.match(/^description: (.+)$/m)?.[1];
    expect(description?.length).toBeLessThan(300);
    expect(description).toContain("server primitives and Runtime Helpers");
    expect(description).toContain("Agent Definitions");
    expect(description).toContain("Provider Output");

    const openai = readFileSync(resolve(skillRoot, "agents/openai.yaml"), "utf8");
    expect(openai).toContain("Use $vitehub");
    expect(openai).toContain("live docs and installed contract");
  });

  it("routes through one lane, the installed contract, recovery, and proof", () => {
    const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");

    expect(skill).toContain("## 1. Orient");
    expect(skill).toContain("## 2. Choose One Lane");
    expect(skill).toContain("## 3. Inspect The Installed Contract");
    expect(skill).toContain("## 4. Act");
    expect(skill).toContain("## 5. Recover");
    expect(skill).toContain("## 6. Prove");
    expect(skill).toContain("Vite Integration is registered, its Runtime Helper executes, and the observed output matches the expected output");
    expect(skill).toContain("Agent Invocation returns or streams the expected result, the Agent Driver prerequisites are satisfied, and granted authority is inspectable");
    expect(skill).toContain("build emits the documented Provider Output and every target limitation is explicit");
  });

  it("keeps published agent resources free of private filesystem paths", () => {
    const files = [...readFiles(skillRoot), ...readFiles(aiResourcesRoot)];

    for (const file of files) {
      expect(file.source, relative(docsRoot, file.path)).not.toMatch(/(?:\/Users\/|\/home\/[^/]+\/|file:\/\/|[A-Za-z]:\\Users\\)/);
    }
  });

  it("keeps raw docs links aligned with current content routes", () => {
    const files = [...readFiles(skillRoot), ...readFiles(aiResourcesRoot)];
    const urls = files.flatMap(({ source }) => [...source.matchAll(/https:\/\/vitehub\.dev\/raw\/docs(?:\/([^\s`)]+))?/g)]
      .map(match => match[1])
      .filter((path): path is string => Boolean(path?.endsWith(".md"))));

    expect(urls.length).toBeGreaterThan(0);
    for (const rawPath of urls) {
      expect(rawPath).not.toMatch(/(?:^|\/)index\.md$/);
      expect(existsSync(resolve(contentRoot, rawPath)), rawPath).toBe(true);
    }
  });
});
