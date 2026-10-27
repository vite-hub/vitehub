import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const fixture = resolve(root, "fixtures/tutorials/chat-app");
const tutorial = resolve(root, "docs/content/docs/agents/build-a-chat-app.md");

async function appFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === ".vitehub") continue;
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory() && ["app", "server", "shared", "scripts"].includes(entry.name)) {
      files.push(...await appFiles(resolve(directory, entry.name), `${name}/`));
    } else if (entry.isDirectory() && prefix) {
      files.push(...await appFiles(resolve(directory, entry.name), `${name}/`));
    } else if (entry.isFile() && (prefix || ["package.json", "nuxt.config.ts", "tsconfig.json", ".gitignore", ".env.example"].includes(name))) {
      files.push(name);
    }
  }
  return files.sort();
}

describe("chat project tutorial", () => {
  it("keeps every complete application file in the code panel in sync with the executable fixture", async () => {
    const source = await readFile(tutorial, "utf8");
    const blocks = [...source.matchAll(/^```\w+ \[([^\n]+)\]\n([\s\S]*?)^```$/gm)];
    const labels = blocks.map(block => block[1]);
    expect(new Set(labels).size).toBe(labels.length);
    const appBlocks = new Map(blocks.filter(block => !block[1]!.startsWith("commands/")).map(block => [block[1], block[2]]));
    expect([...appBlocks.keys()].sort()).toEqual(await appFiles(fixture));
    for (const [filename, contents] of appBlocks) {
      expect(contents?.trimEnd(), filename).toBe((await readFile(resolve(fixture, filename!), "utf8")).trimEnd());
    }
  });

  it("publishes a project tutorial with ordered steps and checkpoints", async () => {
    const source = await readFile(tutorial, "utf8");
    const frontmatter = parse(source.split("---")[1]!);
    expect(frontmatter).toMatchObject({ layout: "tutorial", tutorial: "project", codePanel: true, "navigation.kind": "tutorial" });
    const steps = source.split(/::tutorial-step\{title="[^"]+"\}/).slice(1);
    expect(steps.length).toBeGreaterThanOrEqual(7);
    for (const step of steps) expect(step).toContain("Checkpoint:");
    expect(source).not.toContain("\u2014");
  });

  it("ships an offline default and separate store and restart checks", async () => {
    const env = await readFile(resolve(fixture, ".env.example"), "utf8");
    expect(env).toMatch(/^CHAT_MODE=offline$/m);
    for (const name of ["CHAT_PASSWORD", "CHAT_SESSION_SECRET", "AI_GATEWAY_API_KEY"]) {
      expect(env).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    const manifest = JSON.parse(await readFile(resolve(fixture, "package.json"), "utf8"));
    expect(manifest.scripts.test).toBe("node --test test/store.test.ts");
    expect(manifest.scripts["test:journey"]).toBe("node --test test/journey.test.mjs");
    expect(await readFile(resolve(fixture, "test/journey.test.mjs"), "utf8")).toContain('CHAT_MODE: "offline"');
  });
});
