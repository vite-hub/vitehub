import { describe, expect, it } from "vitest";
import { docsManifest, getDocsPageByPath } from "../modules/vitehub-docs/runtime/utils/docs";
import {
  docsCategoryOrder,
  docsRootSectionId,
  getDocsCatalog,
  getDocsRailCatalog,
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
    const template = ["Overview", "Tutorial", "Configure", "Server API", "Agent capability", "Hosts", "Limits and errors"];

    for (const sectionId of serverPrimitiveSections) {
      const section = docsManifest.sections.find(candidate => candidate.id === sectionId);
      const pages = section?.pages.filter(page => page.navigation) || [];
      const titles = pages.map(page => page.title);
      const templateTitles = titles.filter(title => template.includes(title));

      expect(pages[0]?.path, sectionId).toBe(`/docs/${sectionId}`);
      expect(titles[0], sectionId).toBe("Overview");
      expect(templateTitles, sectionId).toContain("Tutorial");
      expect(templateTitles, sectionId).toContain("Server API");
      // Template pages appear in template order. Concepts pages may sit between
      // template lanes without changing the order of the shared template pages.
      expect(templateTitles, sectionId).toEqual(template.filter(title => templateTitles.includes(title)));
      const laneLabels = getDocsSidebarGroups(section!).map(group => group.label).filter((label): label is string => label !== null);
      const laneOrder = ["Learn", "Build", "Deploy and operate"];
      const knownLaneIndexes = laneLabels
        .map(label => laneOrder.indexOf(label))
        .filter(index => index !== -1);
      expect(knownLaneIndexes, sectionId).toEqual([...knownLaneIndexes].sort((left, right) => left - right));

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
    expect(getDocsSidebarGroups(ui!).find(group => group.label === "Start")?.pages.map(page => page.title))
      .toEqual(["Overview", "Tutorial", "Installation", "Why Vue?"]);
  });

  it("publishes tutorials for public packages without product sections", () => {
    expect(getDocsPageByPath("/docs/agents/box-tutorial")?.title).toBe("Box tutorial");
    expect(getDocsPageByPath("/docs/reference/markdown-template-tutorial")?.title).toBe("Tutorial");
    expect(getDocsPageByPath("/docs/ui/get-started")?.title).toBe("Tutorial");
  });

  it("groups every navigable page of a large section", () => {
    for (const sectionId of ["agents", "development", "frameworks-hosts", "reference", "ui"]) {
      const section = docsManifest.sections.find(candidate => candidate.id === sectionId);
      const groups = getDocsSidebarGroups(section!);

      expect(groups.length, sectionId).toBeGreaterThan(0);
      expect(groups.every(group => group.pages.length > 0 && (!group.label || group.pages.length > 1)), sectionId).toBe(true);
    }

    const kv = docsManifest.sections.find(candidate => candidate.id === "kv");
    expect(getDocsSidebarGroups(kv!).map(group => group.label)).toEqual([null, null, "Build", null]);
  });

  it("groups execution tutorials and concepts together before API and configuration pages", () => {
    for (const sectionId of ["sandbox", "queue", "workflows"]) {
      const section = docsManifest.sections.find(candidate => candidate.id === sectionId);
      const groups = getDocsSidebarGroups(section!);

      expect(groups.map(group => group.label), sectionId).toContain("Learn");
      expect(groups.find(group => group.label === "Learn")?.pages.map(page => page.title), sectionId)
        .toEqual(["Tutorial", "Concepts"]);
      expect(groups.find(group => group.label === "Build")?.pages.map(page => page.title), sectionId)
        .toContain("Configure");
    }
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
    expect(getDocsSectionSubpages(kv!).map(page => page.title)[0]).toBe("Tutorial");
    expect(getDocsSectionSubpages(kv!).some(page => page.id === "index")).toBe(false);
  });

  it("puts setup in Get started and keeps platform topics off the rail", () => {
    const start = docsManifest.sections.find(section => section.id === docsRootSectionId);
    expect(start?.title).toBe("Get started");
    expect(start?.pages.map(page => page.path)).toContain("/docs/getting-started/migrate-from-nuxthub");
    expect(start?.pages.some(page => page.path.includes("runtime-policy") || page.path.includes("workspace-and-sources"))).toBe(false);
    expect(getDocsRailCatalog(docsManifest.sections).flatMap(group => group.sections).map(section => section.id))
      .not.toContain("frameworks-hosts");
    expect(getDocsPageByPath("/docs/workspace/concepts")?.title).toBe("Workspaces and Sources");
    expect(getDocsPageByPath("/docs/agents/runtime-policy")?.sourceTitle).toBe("Runtime policy, approvals, and traces");
  });

  it("redirects each removed page, its trailing-slash form, and its raw Markdown copy to a published page", () => {
    const routeRules = createDocsRedirectRouteRules();

    expect(routeRules["/databases"]).toEqual({ redirect: { statusCode: 301, to: "/database" } });
    expect(routeRules["/rate-limits/"]).toEqual({ redirect: { statusCode: 301, to: "/rate-limit" } });

    expect(docsPageRedirects["/docs/server-primitives/kv"]).toBe("/docs/kv");
    expect(docsPageRedirects["/blog/server-primitives"]).toBe("/docs/getting-started/server-primitives");
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
