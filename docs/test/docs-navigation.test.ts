import { describe, expect, it } from "vitest";
import { docsManifest, getDocsPageByPath } from "../modules/vitehub-docs/runtime/utils/docs";
import {
  docsCategoryOrder,
  docsRootSectionId,
  getDocsCatalog,
  getDocsSectionForPath,
  getDocsSectionSubpages,
  getDocsSidebarGroups,
  getUncategorizedDocsSections,
  isDocsLandingPath,
} from "../modules/vitehub-docs/runtime/utils/docs-navigation";
import { createDocsRedirectRouteRules, docsPageRedirects } from "../modules/vitehub-docs/redirects";

const serverPrimitiveSections = [
  "auth",
  "blob",
  "browser",
  "channels",
  "connections",
  "content",
  "database",
  "email",
  "env",
  "kv",
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

describe("docs product navigation", () => {
  it("files every section under one catalog category", () => {
    expect(getUncategorizedDocsSections(docsManifest.sections)).toEqual([]);

    const catalog = getDocsCatalog(docsManifest.sections);
    expect(catalog.map(group => group.category)).toEqual([...docsCategoryOrder]);
    expect(catalog.find(group => group.category === "Start")?.sections.map(section => section.id)).toEqual([docsRootSectionId]);

    const productIds = catalog
      .filter(group => ["Data", "Compute", "Access", "Delivery", "Files"].includes(group.category))
      .flatMap(group => group.sections.map(section => section.id))
      .sort();
    expect(productIds).toEqual(serverPrimitiveSections);
    expect(catalog.find(group => group.category === "Agents")?.sections.map(section => section.id)).toEqual(["agents", "ui"]);
  });

  it("orders every Server Primitive section by the product page template", () => {
    const template = ["Overview", "Get started", "Configure", "Server API", "Agent capability", "Hosts", "Limits and errors"];

    for (const sectionId of serverPrimitiveSections) {
      const section = docsManifest.sections.find(candidate => candidate.id === sectionId);
      const pages = section?.pages.filter(page => page.navigation) || [];
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
        expect(capability.sourceTitle, sectionId).toBe(`${section?.title} capability`);
      }
    }
  });

  it("keeps Agent-only Capabilities inside the Agents section", () => {
    const agents = docsManifest.sections.find(section => section.id === "agents");
    const capabilities = agents?.pages.filter(page => page.id.startsWith("capabilities")) || [];

    expect(capabilities.map(page => page.path)).toContain("/docs/agents/capabilities");
    expect(capabilities.map(page => page.path)).toContain("/docs/agents/capabilities/mcp");
    expect(capabilities.every(page => page.group === "Capabilities")).toBe(true);
    expect(docsManifest.sections.map(section => section.id)).not.toContain("capabilities");
    expect(docsManifest.sections.map(section => section.id)).not.toContain("server-primitives");
  });

  it("resolves the sidebar section from the route", () => {
    expect(getDocsSectionForPath(docsManifest.sections, "/docs/kv/agent-capability/")?.id).toBe("kv");
    expect(getDocsSectionForPath(docsManifest.sections, "/docs/agents/capabilities/mcp")?.id).toBe("agents");
    expect(getDocsSectionForPath(docsManifest.sections, "/docs")).toBeNull();
    expect(getDocsSectionForPath(docsManifest.sections, "/docs/unknown")).toBeNull();
  });

  it("keeps the UI sidebar Console-first", () => {
    const ui = docsManifest.sections.find(section => section.id === "ui");
    expect(getDocsSidebarGroups(ui!).map(group => group.label)).toEqual([
      "Start",
      "Console",
      "Chat",
      "Agent work",
      "Utilities",
    ]);
    expect(getDocsSidebarGroups(ui!).find(group => group.label === "Console")?.pages.map(page => page.title))
      .toEqual(["Chat App", "Invocation Dashboard", "Code Review"]);
  });

  it("groups every navigable page of a large section", () => {
    for (const sectionId of ["agents", "development", "frameworks-hosts", "reference", "ui"]) {
      const section = docsManifest.sections.find(candidate => candidate.id === sectionId);
      const groups = getDocsSidebarGroups(section!);

      expect(groups.length, sectionId).toBeGreaterThan(0);
      expect(groups.every(group => group.label && group.pages.length > 0), sectionId).toBe(true);
    }

    const kv = docsManifest.sections.find(candidate => candidate.id === "kv");
    expect(getDocsSidebarGroups(kv!).map(group => group.label)).toEqual([null]);
  });

  it("lists each topic once inside a section", () => {
    for (const section of docsManifest.sections) {
      // UI components are named after the feature they render.
      if (section.id === "ui") continue;
      const pathsByTitle = new Map<string, string[]>();

      for (const page of section.pages.filter(page => page.navigation && page.title !== "Overview")) {
        const title = page.title.toLowerCase();
        pathsByTitle.set(title, [...(pathsByTitle.get(title) || []), page.path]);
      }

      const duplicates = [...pathsByTitle].filter(([, paths]) => paths.length > 1);
      expect(duplicates, section.id).toEqual([]);
    }
  });

  it("renders the catalog and every product Overview as a landing page", () => {
    expect(isDocsLandingPath(docsManifest.sections, "/docs")).toBe(true);
    expect(isDocsLandingPath(docsManifest.sections, "/docs/kv/")).toBe(true);
    expect(isDocsLandingPath(docsManifest.sections, "/docs/agents")).toBe(true);
    expect(isDocsLandingPath(docsManifest.sections, "/docs/kv/get-started")).toBe(false);
    expect(isDocsLandingPath(docsManifest.sections, "/docs/getting-started")).toBe(false);
    expect(isDocsLandingPath(docsManifest.sections, "/docs/reference")).toBe(false);
    expect(isDocsLandingPath(docsManifest.sections, "/docs/ui")).toBe(false);

    const kv = docsManifest.sections.find(section => section.id === "kv");
    expect(getDocsSectionSubpages(kv!).map(page => page.title)[0]).toBe("Get started");
    expect(getDocsSectionSubpages(kv!).some(page => page.id === "index")).toBe(false);
  });

  it("keeps commas in frontmatter titles", () => {
    expect(getDocsPageByPath("/docs/getting-started/concepts/runtime-policy-approvals-and-traces")?.title)
      .toBe("Runtime policy, approvals, and traces");
  });

  it("redirects each removed page, its trailing-slash form, and its raw Markdown copy to a published page", () => {
    const routeRules = createDocsRedirectRouteRules();

    expect(docsPageRedirects["/docs/server-primitives/kv"]).toBe("/docs/kv");
    expect(docsPageRedirects["/docs/capabilities/db"]).toBe("/docs/database/agent-capability");
    expect(docsPageRedirects["/docs/capabilities/mcp"]).toBe("/docs/agents/capabilities/mcp");

    for (const [from, to] of Object.entries(docsPageRedirects)) {
      expect(getDocsPageByPath(from), from).toBeNull();
      expect(getDocsPageByPath(to), to).not.toBeNull();
      expect(routeRules[from]).toEqual({ redirect: { statusCode: 301, to } });
      expect(routeRules[`${from}/`]).toEqual({ redirect: { statusCode: 301, to } });
      expect(routeRules[`/raw${from}.md`]).toEqual({ redirect: { statusCode: 301, to: `/raw${to}.md` } });
    }
  });
});
