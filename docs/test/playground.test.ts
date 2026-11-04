import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readWorkspaceVersions } from "../modules/tutorials/build";
import { runnableTutorials } from "../modules/tutorials/list";
import { buildPlaygroundTemplates, playgroundTemplates, snapshotSources } from "../modules/tutorials/playground";
import { dependencyKey } from "../modules/tutorials/steps";
import { isIsolatedPath, isIsolatedTutorialPath } from "../app/utils/runnable-tutorial";
import { decodePlayground, encodePlayground, shareCode, shareLimit } from "../app/utils/playground-share";
import { zipFiles } from "../app/utils/zip";

const docsRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(docsRoot, "..");
const fixturesDir = resolve(repoRoot, "fixtures/tutorials");

async function templates() {
  return buildPlaygroundTemplates({ fixturesDir, versions: await readWorkspaceVersions(repoRoot), tutorials: runnableTutorials });
}

describe("playground", () => {
  it("reads each template from its fixture, so the code has one source", async () => {
    const built = await templates();
    expect(built.map(template => template.id)).toEqual(["kv", "agent"]);
    const kv = built.find(template => template.id === "kv")!;
    expect(kv.files["server/api/settings.post.ts"]).toBe(await readFile(resolve(fixturesDir, "server-primitives/server/api/settings.post.ts"), "utf8"));
    expect(kv.files["vite.config.ts"]).toContain("kv:");
    // The browser runs npm, so pnpm specifiers become versions.
    expect(kv.files["package.json"]).not.toMatch(/catalog:|workspace:/);
    expect(built.find(template => template.id === "agent")!.files["server/agents/greeting.ts"]).toContain("defineAgent");
  });

  it("mounts the snapshot of the tutorial with the same dependencies", async () => {
    const built = await templates();
    expect(Object.fromEntries(built.map(template => [template.id, template.snapshotOf]))).toEqual({ kv: "first-server-primitive", agent: "first-agent" });
    // Both templates share a tutorial snapshot, so the build makes no extra one.
    expect(snapshotSources(runnableTutorials, built)).toEqual(runnableTutorials);
    expect(snapshotSources(runnableTutorials, [{ id: "kv", snapshotOf: "playground-kv" }]).at(-1)).toEqual({ slug: "playground-kv", page: "/playground", fixture: "server-primitives" });
  });

  it("compares installs by dependencies only", () => {
    const manifest = (dependencies: Record<string, string>, extra = {}) => JSON.stringify({ name: "app", dependencies, ...extra });
    expect(dependencyKey(manifest({ b: "1", a: "2" }))).toBe(dependencyKey(manifest({ a: "2", b: "1" }, { scripts: { dev: "vite" } })));
    expect(dependencyKey(manifest({ a: "2" }))).not.toBe(dependencyKey(manifest({ a: "3" })));
    expect(dependencyKey("{")).toBe("invalid");
  });

  it("isolates /playground besides the tutorials, and nothing below it", () => {
    expect(isIsolatedPath("/playground")).toBe(true);
    expect(isIsolatedPath("/tutorials/first-agent")).toBe(true);
    expect(isIsolatedPath("/playground/other")).toBe(false);
    expect(isIsolatedPath("/docs")).toBe(false);
    // The "Run this tutorial" link hides only on tutorials.
    expect(isIsolatedTutorialPath("/playground")).toBe(false);
  });

  it("shares only the changes from the template, and restores them", async () => {
    const built = await templates();
    const kv = built.find(template => template.id === "kv")!;
    const files = { ...kv.files, "server/api/health.get.ts": "export default () => ({ ok: 'edited' })\n", "server/api/new.get.ts": "export default () => 1\n" };
    delete files["tsconfig.json"];
    const code = await encodePlayground({ template: "kv", files }, kv.files);
    expect(code).toMatch(/^[\w-]+$/);
    // An unedited template is a short link.
    expect((await encodePlayground({ template: "kv", files: kv.files }, kv.files)).length).toBeLessThan(40);
    expect(shareCode(`#code=${code}`)).toBe(code);
    expect(await decodePlayground(code, built)).toEqual({ template: "kv", files });
  });

  it("rejects links that it cannot read", async () => {
    const built = await templates();
    expect(await decodePlayground("not-a-code", built)).toBeUndefined();
    expect(await decodePlayground(await encodePlayground({ template: "gone", files: {} }, {}), built)).toBeUndefined();
    expect(shareCode("#other=1")).toBeUndefined();
  });

  it("does not inflate a crafted link past its limit", async () => {
    const huge = await encodePlayground({ template: "kv", files: { "big.txt": "a".repeat(3 * 2 ** 20) } }, {});
    // Highly repetitive data fits in a short link, so the limit is on the inflated size.
    expect(huge.length).toBeLessThan(shareLimit);
    expect(await decodePlayground(huge, await templates())).toBeUndefined();
  });

  it("downloads the files as a zip that unzip reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-playground-zip-"));
    try {
      const files = { "package.json": "{}\n", "server/api/é.get.ts": "export default () => 'ü'\n" };
      await writeFile(join(dir, "app.zip"), zipFiles(files, "vitehub-kv"));
      execFileSync("unzip", ["-q", "app.zip"], { cwd: dir });
      expect(await readFile(join(dir, "vitehub-kv/server/api/é.get.ts"), "utf8")).toBe(files["server/api/é.get.ts"]);
      expect(await readFile(join(dir, "vitehub-kv/package.json"), "utf8")).toBe("{}\n");
      // The same files give the same bytes.
      expect(zipFiles(files, "a")).toEqual(zipFiles({ ...files }, "a"));
    }
    finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists templates whose fixtures exist", async () => {
    for (const template of playgroundTemplates) {
      await expect(readFile(resolve(fixturesDir, template.fixture, "package.json"), "utf8")).resolves.toContain("\"dev\"");
    }
  });
});
