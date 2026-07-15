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

  it("keeps Babysitter pending until its source is publishable", () => {
    expect(examples).toEqual([
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
    expectTypeOf<PublishedProject["license"]>().toEqualTypeOf<string>();
    expectTypeOf<Template["action"]["kind"]>().toEqualTypeOf<"use">();
    expectTypeOf<Template["startPath"]>().toEqualTypeOf<string>();
  });
});
