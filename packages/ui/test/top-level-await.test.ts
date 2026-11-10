import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, parseAst } from "vite";
import { describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

// Nitro transforms server chunks with an es2019 target, which rejects top-level await.
function topLevelAwaits(code: string): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object" || !("type" in node) || typeof node.type !== "string") return;
    if (/Function|StaticBlock|PropertyDefinition/.test(node.type)) return;
    const isForAwait = node.type === "ForOfStatement" && "await" in node && node.await === true;
    if ((node.type === "AwaitExpression" || isForAwait) && "start" in node && typeof node.start === "number") {
      found.push(code.slice(node.start, node.start + 80));
    }
    Object.values(node).forEach(visit);
  };
  visit(parseAst(code));
  return found;
}

const chunks = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".js"));

describe("built dist", () => {
  it("has no top-level await in any chunk", () => {
    expect(chunks.length).toBeGreaterThan(0);
    const offenders = chunks
      .map((name) => [name, topLevelAwaits(readFileSync(`${dist}${name}`, "utf8"))] as const)
      .filter(([, found]) => found.length > 0);
    expect(offenders).toEqual([]);
  });

  it("has no top-level await when a Node server build bundles every dependency", async () => {
    const manifest: { exports: Record<string, unknown>; peerDependencies: Record<string, string> } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const input = Object.entries(manifest.exports)
      .filter(([key, value]) => !["./nuxt", "./vite"].includes(key) && typeof value === "object")
      .map(([key]) => `${dist}${key === "." ? "index" : key.slice(2)}.js`);
    const external = [...Object.keys(manifest.peerDependencies), "nuxt", "#app", "@nuxt/kit"]
      .map((name) => new RegExp(`^${name}(?:/|$)`));
    const result = await build({
      configFile: false,
      logLevel: "silent",
      ssr: { noExternal: true },
      build: { ssr: true, write: false, rolldownOptions: { input, external } },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => "output" in entry ? entry.output : []);
    const offenders = outputs
      .flatMap((chunk) => chunk.type === "chunk" ? [[chunk.fileName, topLevelAwaits(chunk.code)] as const] : [])
      .filter(([, found]) => found.length > 0);
    expect(outputs.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  }, 120_000);
});
