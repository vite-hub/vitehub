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
      "references/agent-definitions.md",
      "references/boxes-hosts.md",
      "references/capabilities-authority.md",
      "references/channels-triggers.md",
      "references/framework-composition.md",
      "references/preview-contract.md",
      "references/project-patterns.md",
      "references/project-shapes.md",
      "references/proof-recovery.md",
      "references/schedules-workflows-invocations.md",
      "references/server-primitives.md",
      "references/workspaces-sources-access.md",
    ]);

    const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
    const description = skill.match(/^description: (.+)$/m)?.[1];
    expect(description?.length).toBeLessThan(300);
    expect(description).toContain("server primitives and Runtime Helpers");
    expect(description).toContain("Agent Definitions");
    expect(description).toContain("Provider Output");

    const openai = readFileSync(resolve(skillRoot, "agents/openai.yaml"), "utf8");
    expect(openai).toContain("Use $vitehub");
    expect(openai).toContain("live docs and the installed contract");
  });

  it("routes through references, the installed contract, a coherent build, and proof", () => {
    const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");

    expect(skill).toContain("## 1. Orient");
    expect(skill).toContain("## 2. Route before code");
    expect(skill).toContain("## 3. Inspect the installed contract");
    expect(skill).toContain("## 4. Build the coherent file set");
    expect(skill).toContain("## 5. Prove and repair");
    expect(skill).toContain("Package owner | Source file | Runtime path | Authority or persistence | Proof");
    expect(skill).toContain("every behavior row has an observed result, or a precise source-backed unsupported boundary");
  });

  it("publishes every directly routed reference", () => {
    const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
    const referencesRoot = resolve(skillRoot, "references");
    const references = listFiles(referencesRoot).map(path => relative(referencesRoot, path));

    expect(references.length).toBeGreaterThan(10);
    for (const reference of references) {
      expect(skill).toContain(`references/${reference}`);
    }

    const localLinks = [...new Set([...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map(match => match[1]))];
    expect(localLinks).toHaveLength(references.length);
    for (const localLink of localLinks) {
      expect(existsSync(resolve(skillRoot, localLink)), localLink).toBe(true);
    }
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
      const directPath = resolve(contentRoot, rawPath);
      const sectionIndexPath = resolve(contentRoot, rawPath.replace(/\.md$/, "/index.md"));
      expect(existsSync(directPath) || existsSync(sectionIndexPath), rawPath).toBe(true);
    }
  });
});
