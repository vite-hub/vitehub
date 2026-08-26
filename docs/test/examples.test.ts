import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { examples, type Example } from "../app/data/examples";

const docsRoot = resolve(import.meta.dirname, "..");

describe("examples catalog", () => {
  it("exposes the public examples route through primary navigation", () => {
    expect(existsSync(resolve(docsRoot, "app/pages/examples.vue"))).toBe(true);

    const header = readFileSync(resolve(docsRoot, "app/components/AppHeader.vue"), "utf8");
    expect(header).toContain('{ label: "Examples", to: "/examples" }');

    const sitemap = readFileSync(resolve(docsRoot, "server/routes/sitemap.xml.ts"), "utf8");
    expect(sitemap).toContain('{ path: "/examples" }');
  });

  it("publishes available examples while retaining future candidates", () => {
    expect(examples).toEqual([
      expect.objectContaining({
        name: "Drop",
        kind: "project",
        status: "published",
        action: {
          kind: "source",
          label: "View source",
          to: "https://github.com/vite-hub/drop",
        },
        builtWith: ["Blob", "Queue", "Rate Limit", "Sandbox", "Schedule"],
      }),
      expect.objectContaining({
        name: "Calories",
        kind: "template",
        status: "published",
        action: {
          kind: "use",
          label: "Use template",
          to: "https://github.com/vite-hub/calories/generate",
        },
        startPath: "server/agents/calories/agent.ts",
      }),
      expect.objectContaining({
        name: "My Pull Requests",
        kind: "template",
        status: "published",
        action: {
          kind: "use",
          label: "Use template",
          to: "https://github.com/vite-hub/my-pull-requests/generate",
        },
        startPath: "app/pages/index.vue",
      }),
      expect.objectContaining({
        name: "Nuxt Agent",
        kind: "template",
        status: "published",
        action: {
          kind: "use",
          label: "Use template",
          to: "https://github.com/vite-hub/nuxt-agent/generate",
        },
        builtWith: ["Agent Definitions", "MCP", "Workspaces", "Channels", "Rate Limit", "Workflow"],
        startPath: "server/agents/nuxt/agent.ts",
      }),
      expect.objectContaining({
        name: "Babysitter",
        kind: "project",
        status: "pending",
        action: { kind: "source", label: "Source unavailable" },
        builtWith: ["Agent Definitions", "Schedule"],
      }),
    ]);
  });

  it("uses source actions for Projects and use actions with a start path for Templates", () => {
    type Project = Extract<Example, { kind: "project" }>;
    type PublishedProject = Extract<Project, { status: "published" }>;
    type Template = Extract<Example, { kind: "template" }>;

    expectTypeOf<Project["action"]["kind"]>().toEqualTypeOf<"source">();
    expectTypeOf<PublishedProject["action"]["to"]>().toEqualTypeOf<string>();
    expectTypeOf<Template["action"]["kind"]>().toEqualTypeOf<"use">();
    expectTypeOf<Template["startPath"]>().toEqualTypeOf<string>();
  });
});
