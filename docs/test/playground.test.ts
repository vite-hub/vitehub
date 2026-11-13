import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decodePlaygroundLink, encodePlaygroundLink } from "@vite-hub/ui/playground";
import { describe, expect, it } from "vitest";

import { readWorkspaceVersions } from "../modules/tutorials/build";
import { runnableTutorials } from "../modules/tutorials/list";
import { buildPlaygroundTemplates, playgroundTemplates, snapshotSources } from "../modules/tutorials/playground";
import { dependencyKey } from "../modules/tutorials/steps";
import { isIsolatedPath, isIsolatedTutorialPath } from "../app/utils/runnable-tutorial";

const docsRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(docsRoot, "..");
const fixturesDir = resolve(repoRoot, "fixtures/tutorials");

async function templates() {
  return buildPlaygroundTemplates({ fixturesDir, versions: await readWorkspaceVersions(repoRoot), tutorials: runnableTutorials });
}

describe("playground", () => {
  it("reads each template from its fixture, so the code has one source", async () => {
    const built = await templates();
    expect(built.map(template => template.id)).toEqual(["kv", "blob", "queue", "cache", "rate-limit", "agent", "channels", "ui"]);
    // The editor and the preview open a file and a route of the template.
    for (const template of built) expect(template.files[template.open], template.id).toBeDefined();
    for (const template of built.filter(item => item.id !== "ui")) expect(template.preview, template.id).toMatch(/^\/api\//);
    const kv = built.find(template => template.id === "kv")!;
    expect(kv.files["server/api/settings.post.ts"]).toBe(await readFile(resolve(fixturesDir, "server-primitives/server/api/settings.post.ts"), "utf8"));
    expect(kv.files["vite.config.ts"]).toContain("kv:");
    // The browser runs npm, so pnpm specifiers become versions.
    expect(kv.files["package.json"]).not.toMatch(/catalog:|workspace:/);
    expect(built.find(template => template.id === "agent")!.files["server/agents/greeting.ts"]).toContain("defineAgent");
    // The Channels template opens the simulated Slack page of its Agent, so the preview needs no bot or token.
    const channels = built.find(template => template.id === "channels")!;
    expect(channels.files["vite.config.ts"]).toContain("channels: { simulate: true }");
    expect(channels.preview).toBe("/api/_vitehub/agents/support/webhooks/slack");
    for (const channel of ["slack()", "discord()", "teams()", "telegram()"]) expect(channels.files["server/agents/support.ts"]).toContain(channel);
    // The ViteHub UI template is a Vue app on the headless parts of @vite-hub/kit, and its preview is the app page.
    const ui = built.find(template => template.id === "ui")!;
    expect(ui.preview).toBe("/");
    expect(ui.files["src/App.vue"]).toContain("@vite-hub/kit/dialog");
    expect(JSON.parse(ui.files["package.json"]!).dependencies["@vite-hub/kit"]).toMatch(/^\^\d/);
  });

  it("reuses tutorial snapshots only for matching dependencies", async () => {
    const built = await templates();
    const snapshots = Object.fromEntries(built.map(template => [template.id, template.snapshotOf]));
    expect(snapshots).toEqual({
      "kv": "first-server-primitive",
      "blob": "playground-blob",
      "queue": "playground-queue",
      "cache": "playground-cache",
      "rate-limit": "playground-rate-limit",
      "agent": "first-agent",
      "channels": "first-agent",
      "ui": "playground-ui",
    });
    // Each distinct feature install needs its own snapshot.
    expect(snapshotSources(runnableTutorials, built)).toEqual([
      ...runnableTutorials,
      { slug: "playground-blob", page: "/playground", fixture: "playground-blob" },
      { slug: "playground-queue", page: "/playground", fixture: "playground-queue" },
      { slug: "playground-cache", page: "/playground", fixture: "playground-cache" },
      { slug: "playground-rate-limit", page: "/playground", fixture: "playground-rate-limit" },
      { slug: "playground-ui", page: "/playground", fixture: "playground-ui" },
    ]);
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
    expect(isIsolatedPath("/learn/first-agent")).toBe(true);
    expect(isIsolatedPath("/playground/other")).toBe(false);
    expect(isIsolatedPath("/docs")).toBe(false);
    // The "Run this tutorial" link hides only on tutorials.
    expect(isIsolatedTutorialPath("/playground")).toBe(false);
  });

  it("shares a template's changes and restores them on the same template", async () => {
    const built = await templates();
    const kv = built.find(template => template.id === "kv")!;
    const files = { ...kv.files, "server/api/new.get.ts": "export default () => 1\n" };
    const code = await encodePlaygroundLink({ template: "kv", files }, kv.files);
    expect(await decodePlaygroundLink(code, built)).toEqual({ template: "kv", files });
  });

  it("lists templates whose fixtures exist", async () => {
    for (const template of playgroundTemplates) {
      await expect(readFile(resolve(fixturesDir, template.fixture, "package.json"), "utf8")).resolves.toContain("\"dev\"");
    }
  });
});
