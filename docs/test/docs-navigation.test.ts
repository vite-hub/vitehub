import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { docsCatalog, docsRailGroups, docsSectionForPath, docsSidebarGroups, findDocsPage } from "@vite-hub/docs";
import { docsPanelPages, docsSectionPanels } from "@vite-hub/docs/navigation";
import { createDocsManifest } from "@vite-hub/docs/server";
import { describe, expect, it } from "vitest";
import config from "../nuxt.config";
import { createDocsRedirectRouteRules, docsPageRedirects } from "../modules/vitehub-docs/redirects";

const docsRoot = resolve(import.meta.dirname, "..");
const docsManifest = await createDocsManifest({ dir: resolve(docsRoot, "content"), base: "/docs" });
const categories = config.docs?.categories ?? [];
const railExclude = config.docs?.railExclude ?? [];

const serverPrimitiveSections = [
  "auth",
  "blob",
  "browser",
  "channels",
  "cms",
  "comments",
  "connections",
  "content",
  "database",
  "decisions",
  "email",
  "env",
  "forge",
  "forms",
  "gateways",
  "i18n",
  "kv",
  "logs",
  "mcp",
  "queue",
  "rate-limit",
  "realtime",
  "sandbox",
  "schedule",
  "shell",
  "source",
  "workflows",
  "workspace",
];

function section(id: string) {
  const found = docsManifest.sections.find(candidate => candidate.id === id);
  if (!found) throw new Error(`Missing docs section ${id}`);
  return found;
}

describe("docs product navigation", () => {
  it("exposes UI, development, deployment, and reference without crowding the product rail", () => {
    const catalog = docsCatalog(docsManifest, categories);
    const rail = docsRailGroups(docsManifest, categories, railExclude);
    expect(railExclude).toEqual(["Develop and deploy", "Reference"]);
    expect(catalog.find(group => group.category === "Develop and deploy")?.sections.map(candidate => candidate.id))
      .toEqual(expect.arrayContaining(["console", "development", "frameworks-hosts", "guides"]));
    expect(catalog.find(group => group.category === "Reference")?.sections.map(candidate => candidate.id))
      .toEqual(expect.arrayContaining(["reference", "compare"]));
    const railSectionIds = rail.flat().map(candidate => candidate.id);
    const excludedSectionIds = catalog
      .filter(group => railExclude.includes(group.category))
      .flatMap(group => group.sections.map(candidate => candidate.id));
    expect(excludedSectionIds).toEqual(expect.arrayContaining(["development", "frameworks-hosts", "guides", "reference", "compare"]));
    for (const sectionId of excludedSectionIds) {
      expect(railSectionIds).not.toContain(sectionId);
    }
    // Every section has a known category, so the rail has one group per category that it keeps.
    expect(rail.map(group => group[0]?.category)).toEqual(categories.filter(category => !railExclude.includes(category)));
    expect(rail.find(group => group[0]?.category === "Agents")?.map(candidate => candidate.id)).toEqual(["agents"]);
    expect(rail.find(group => group[0]?.category === "UI")?.map(candidate => candidate.id)).toEqual(["ui", "docs-site"]);
  });

  it("files every section under one catalog category", () => {
    expect(docsManifest.sections.filter(candidate => !candidate.category || !categories.includes(candidate.category)).map(candidate => candidate.id)).toEqual([]);

    const catalog = docsCatalog(docsManifest, categories);
    expect(catalog.map(group => group.category)).toEqual(categories);
    expect(catalog.find(group => group.category === "Start")?.sections.map(candidate => candidate.id)).toEqual([config.docs?.start?.section]);

    const productIds = catalog
      .filter(group => ["Data", "Compute", "Access", "Delivery", "Files"].includes(group.category))
      .flatMap(group => group.sections.map(candidate => candidate.id))
      .sort();
    expect(productIds).toEqual(serverPrimitiveSections);
    expect(catalog.find(group => group.category === "Agents")?.sections.map(candidate => candidate.id)).toEqual(["agents"]);
    expect(catalog.find(group => group.category === "UI")?.sections.map(candidate => candidate.id)).toEqual(["ui", "docs-site"]);
  });

  it("orders every Server Primitive section by the product page template", () => {
    const template = ["Overview", "Get started", "Configure", "Server API", "Agent capability", "Hosts", "Limits and errors"];

    for (const sectionId of serverPrimitiveSections) {
      const product = section(sectionId);
      const pages = docsPanelPages(product, null).filter(page => page.navigation);
      const titles = pages.map(page => page.title);
      const templateTitles = titles.filter(title => template.includes(title));

      expect(pages[0]?.path, sectionId).toBe(`/docs/${sectionId}`);
      expect(titles[0], sectionId).toBe("Overview");
      expect(templateTitles, sectionId).toContain("Get started");
      expect(templateTitles, sectionId).toContain("Server API");
      // Template pages appear in template order. Product-specific pages such as Env Bridge come after them.
      expect(templateTitles, sectionId).toEqual(template.filter(title => templateTitles.includes(title)));
      expect(titles.slice(templateTitles.length).some(title => template.includes(title)), sectionId).toBe(false);

      const capability = pages.find(page => page.id === "agent-capability");
      if (capability) {
        expect(capability.title, sectionId).toBe("Agent capability");
        expect(capability.sourceTitle, sectionId).toBe(`${product.title} capability`);
      }
    }
  });

  it("resolves product Overviews by their section name and their sidebar label", () => {
    expect(findDocsPage(docsManifest, "/docs/kv")?.page).toMatchObject({ sourceTitle: "KV", title: "Overview" });
    // Framework-prefixed docs routes were removed.
    expect(findDocsPage(docsManifest, "/docs/vite/kv")).toBeNull();
  });

  it("preserves the Agents Learning path title", () => {
    expect(findDocsPage(docsManifest, "/docs/agents/get-started")?.page.title).toBe("Learning path");
  });

  it("keeps Agent-only Capabilities inside the Agents section", () => {
    const capabilities = section("agents").pages.filter(page => page.id.startsWith("capabilities"));

    expect(capabilities.map(page => page.path)).toContain("/docs/agents/capabilities");
    expect(capabilities.map(page => page.path)).toContain("/docs/agents/capabilities/mcp");
    expect(capabilities.find(page => page.id === "capabilities")?.group).toBe("Instructions and tools");
    expect(capabilities.find(page => page.id === "capabilities/custom")?.group).toBe("Advanced");
    expect(capabilities.filter(page => !["capabilities", "capabilities/official", "capabilities/custom"].includes(page.id)).every(page => page.group === "Capabilities")).toBe(true);
    expect(docsManifest.sections.map(candidate => candidate.id)).not.toContain("capabilities");
    expect(docsManifest.sections.map(candidate => candidate.id)).not.toContain("server-primitives");
  });

  it("resolves the sidebar section from the route", () => {
    expect(docsSectionForPath(docsManifest, "/docs/kv/agent-capability/")?.id).toBe("kv");
    expect(docsSectionForPath(docsManifest, "/docs/agents/capabilities/mcp")?.id).toBe("agents");
    expect(docsSectionForPath(docsManifest, "/docs")).toBeNull();
    expect(docsSectionForPath(docsManifest, "/docs/unknown")).toBeNull();
  });

  it("puts reusable UI blocks after setup", () => {
    const groups = docsSidebarGroups(section("ui"));
    expect(groups.map(group => group.label)).toEqual([
      "Start",
      "Blocks",
      "Parts",
      "Chat",
      "Collaboration",
      "Agent work",
      "Utilities",
    ]);
    expect(groups.find(group => group.label === "Blocks")?.pages.map(page => page.title))
      .toEqual(["Chat App", "Code Review", "Collaborative Editor"]);
  });

  it("groups every navigable page of a large section", () => {
    for (const sectionId of ["agents", "cli", "console", "development", "frameworks-hosts", "reference", "ui"]) {
      const groups = docsSidebarGroups(section(sectionId));

      expect(groups.length, sectionId).toBeGreaterThan(0);
      expect(groups.every(group => group.label && group.pages.length > 0), sectionId).toBe(true);
    }

    expect(docsSidebarGroups(section("kv")).map(group => group.label)).toEqual([null]);
  });

  it("lists each topic once inside a section", () => {
    for (const candidate of docsManifest.sections) {
      // UI components are named after the feature they render.
      if (candidate.id === "ui") continue;
      const pathsByTitle = new Map<string, string[]>();

      for (const page of docsPanelPages(candidate, null).filter(page => page.navigation && page.title !== "Overview")) {
        const title = page.title.toLowerCase();
        pathsByTitle.set(title, [...(pathsByTitle.get(title) || []), page.path]);
      }

      const duplicates = [...pathsByTitle].filter(([, paths]) => paths.length > 1);
      expect(duplicates, candidate.id).toEqual([]);
    }
  });

  it("keeps generated diagnostic codes in their own sidebar panels", () => {
    for (const sectionId of ["agents", "auth", "queue", "ui"]) {
      const product = section(sectionId);
      const panel = docsSectionPanels(product).find(candidate => candidate.page.id === "diagnostics");
      expect(panel?.count, sectionId).toBeGreaterThan(0);
      expect(docsPanelPages(product, panel!.page).length).toBe(panel!.count + 1);
      expect(docsSidebarGroups(product).flatMap(group => group.pages).some(page => page.id.startsWith("diagnostics"))).toBe(false);
    }
    expect(findDocsPage(docsManifest, "/docs/queue/diagnostics/queue_disabled")?.page.title).toBe("QUEUE_DISABLED");
  });

  it("renders the catalog and every product Overview as a landing page", () => {
    const landingSections = ["agents", "docs-site", ...serverPrimitiveSections];
    expect(docsManifest.root?.layout).toBe("landing");
    for (const candidate of docsManifest.sections) {
      const overview = candidate.pages.find(page => page.id === "index");
      expect(overview?.layout, candidate.id).toBe(landingSections.includes(candidate.id) ? "landing" : "article");
    }
    // The frontmatter sets the layout, so the raw Markdown and the Console editor see it too.
    for (const sectionId of landingSections) {
      expect(readFileSync(resolve(docsRoot, `content/docs/${sectionId}/index.md`), "utf8"), sectionId).toMatch(/^---\n[\s\S]*?^layout: landing$[\s\S]*?^---$/m);
    }
    expect(findDocsPage(docsManifest, "/docs/kv/get-started")?.page.layout).not.toBe("landing");
  });

  it("keeps commas in frontmatter titles", () => {
    expect(findDocsPage(docsManifest, "/docs/agents/runtime-policy")?.page.title)
      .toBe("Runtime policy, approvals, and traces");
  });

  it("lists the trust pages outside the docs base", () => {
    expect(docsManifest.pages.map(page => page.path)).toEqual(expect.arrayContaining(["/", "/about", "/contact", "/privacy"]));
  });

  it("redirects each removed page, its trailing-slash form, and its raw Markdown copy to a published page", () => {
    const routeRules = createDocsRedirectRouteRules();

    expect(docsPageRedirects["/docs/server-primitives/kv"]).toBe("/docs/kv");
    expect(docsPageRedirects["/docs/capabilities/db"]).toBe("/docs/database/agent-capability");
    expect(docsPageRedirects["/docs/capabilities/mcp"]).toBe("/docs/agents/capabilities/mcp");

    for (const [from, to] of Object.entries(docsPageRedirects)) {
      expect(findDocsPage(docsManifest, from), from).toBeNull();
      expect(findDocsPage(docsManifest, to), to).not.toBeNull();
      expect(routeRules[from]).toEqual({ redirect: { status: 301, to } });
      expect(routeRules[`${from}/`]).toEqual({ redirect: { status: 301, to } });
      expect(routeRules[`/raw${from}.md`]).toEqual({ redirect: { status: 301, to: `/raw${to}.md` } });
    }
  });
});
