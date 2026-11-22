import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decodePlaygroundLink, encodePlaygroundLink } from "@vite-hub/ui/playground";
import { describe, expect, it } from "vitest";

import { readWorkspaceVersions } from "../../packages/docs/src/runnable/build";
import { buildPlaygroundTemplates, snapshotSources } from "../../packages/docs/src/runnable/playground";
import { webContainerRoutes } from "../../packages/docs/src/runnable/workspaces";
import { isIsolatedTutorialPath } from "../app/utils/runnable-tutorial";
import { learnPages, playgroundExamples, playgroundPage, runnableLessons } from "./workspace-pages";

const docsRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(docsRoot, "..");
const fixturesDir = resolve(repoRoot, "fixtures/tutorials");

const page = "playground--";

async function templates() {
  const built = await buildPlaygroundTemplates({ fixturesDir, versions: await readWorkspaceVersions(repoRoot), tutorials: await runnableLessons(), examples: await playgroundExamples() });
  return built.map(template => ({ ...template, id: template.id.slice(page.length) }));
}

describe("playground", () => {
  it("reads each template from its fixture, so the code has one source", async () => {
    const built = await templates();
    expect(built.map(template => template.id)).toEqual(["kv", "blob", "queue", "cache", "rate-limit", "agent", "channels", "ui"]);
    // The editor and the preview open a file and a route of the template.
    for (const template of built) expect(template.files[template.open], template.id).toBeDefined();
    for (const template of built.filter(item => item.id !== "ui" && item.id !== "channels")) expect(template.preview, template.id).toMatch(/^\/api\//);
    const kv = built.find(template => template.id === "kv")!;
    expect(kv.files["server/api/settings.post.ts"]).toBe(await readFile(resolve(fixturesDir, "server-primitives/server/api/settings.post.ts"), "utf8"));
    expect(kv.files["vite.config.ts"]).toContain("kv:");
    // The browser runs npm, so pnpm specifiers become versions.
    expect(kv.files["package.json"]).not.toMatch(/catalog:|workspace:/);
    expect(built.find(template => template.id === "agent")!.files["server/agents/greeting.ts"]).toContain("defineAgent");
    // The Channels template opens the simulated Slack page of its Agent, so the preview needs no bot or token.
    const channels = built.find(template => template.id === "channels")!;
    expect(channels.files["vite.config.ts"]).toContain("channels: { simulate: true }");
    expect(channels.preview).toBe("/_vitehub/agents/support/webhooks/slack");
    for (const channel of ["slack()", "discord()", "teams()", "telegram()"]) expect(channels.files["server/agents/support.ts"]).toContain(channel);
    // The ViteHub UI template is a Vue app on the headless parts of @ui-sdk/vue, and its preview is the app page.
    const ui = built.find(template => template.id === "ui")!;
    expect(ui.preview).toBe("/");
    expect(ui.files["src/App.vue"]).toContain("@ui-sdk/vue/dialog");
    expect(JSON.parse(ui.files["package.json"]!).dependencies["@ui-sdk/vue"]).toMatch(/^\d/);
  });

  it("reuses tutorial snapshots only for matching dependencies", async () => {
    const built = await templates();
    const snapshots = Object.fromEntries(built.map(template => [template.id, template.snapshotOf]));
    expect(snapshots).toEqual({
      "kv": "learn-first-server-primitive",
      "blob": `playground-${page}blob`,
      "queue": `playground-${page}queue`,
      "cache": `playground-${page}cache`,
      "rate-limit": `playground-${page}rate-limit`,
      "agent": "learn-first-agent",
      "channels": "learn-first-agent",
      "ui": `playground-${page}ui`,
    });
    // Each distinct feature install needs its own snapshot.
    const lessons = await runnableLessons();
    const examples = await playgroundExamples();
    const own = (id: string) => ({ slug: `playground-${page}${id}`, page: "/playground", fixture: resolve(fixturesDir, `playground-${id}`) });
    const withPage = built.map(template => ({ ...template, id: `${page}${template.id}` }));
    expect(snapshotSources(lessons, examples, withPage)).toEqual([...lessons, own("blob"), own("queue"), own("cache"), own("rate-limit"), own("ui")]);
  });

  it("shows the \"Run this tutorial\" link only on tutorials", () => {
    expect(isIsolatedTutorialPath("/learn/first-agent")).toBe(true);
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
    for (const template of await playgroundExamples()) {
      await expect(readFile(resolve(template.fixture, "package.json"), "utf8")).resolves.toContain("\"dev\"");
    }
  });

  it("isolates /playground and every lesson, and offers the Connect accounts", async () => {
    const pages = [await playgroundPage(), ...await learnPages()];
    expect(webContainerRoutes(pages)).toEqual(["/playground", "/learn/first-server-primitive", "/learn/first-agent", "/learn/choices"]);
    expect((await playgroundPage()).workspace.connect).toEqual(["anthropic", "github", "netlify", "openai", "vercel"]);
  });
});
