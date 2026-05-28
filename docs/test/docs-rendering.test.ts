import { describe, expect, it } from "vitest";
import {
  buildDocsSidebarNavigation,
  createDocsPageState,
  getDocsPageFallback,
  getSupportedDocsSections,
  renderDocsPage,
  resolveDocsRoute,
} from "../modules/vitehub-docs/runtime/utils/docs-rendering";
import { getDocsPage } from "../modules/vitehub-docs/runtime/utils/docs";

describe("docs rendering state", () => {
  it("resolves route meta, manifest page, support, and source path together", () => {
    expect(resolveDocsRoute("/docs/vite/blob/quickstart")).toMatchObject({
      meta: { framework: "vite", section: "blob", page: "quickstart" },
      routePath: "/docs/vite/blob/quickstart",
      sourcePath: "/docs/blob/quickstart",
      supported: true,
    });

    expect(resolveDocsRoute("/docs/nuxt/blob")).toMatchObject({
      routePath: "/docs/nuxt/blob",
      sourcePath: "/docs/blob",
      supported: false,
    });
  });

  it("normalizes content page state before rendering framework blocks", () => {
    const page = getDocsPage("getting-started", "index");
    expect(page).toBeTruthy();

    const rendered = renderDocsPage(
      {
        title: "",
        description: null,
        meta: { package: "vitehub" },
        body: {
          toc: { links: [] },
          value: [
            ["h2", { id: "intro" }, "Intro"],
            ["fw", { id: "vite:dev" }, ["h2", { id: "vite-dev" }, "Vite dev"]],
            ["fw", { id: "nitro:dev" }, ["h2", { id: "nitro-dev" }, "Nitro dev"]],
          ],
        },
      },
      "/docs",
      getDocsPageFallback(page!),
      { framework: "vite", mode: "dev", renderMode: "single", tocMode: "current-selection" },
    );

    expect(rendered?.path).toBe("/docs");
    expect(rendered?.title).toBe(page?.sourceTitle || page?.title);
    expect(rendered?.data).toEqual({ package: "vitehub" });
    expect(rendered?.body?.value).toEqual([
      ["h2", { id: "intro" }, "Intro"],
      ["fw", { id: "vite:dev" }, ["h2", { id: "vite-dev" }, "Vite dev"]],
    ]);
    expect(rendered?.body?.toc?.links?.map(link => link.id)).toEqual(["intro", "vite-dev"]);
  });

  it("builds navigation-facing docs state from supported pages", () => {
    const sections = getSupportedDocsSections("vite");
    const sidebar = buildDocsSidebarNavigation("/docs/vite/blob/quickstart", "vite", sections);

    expect(sections.map(section => section.id)).toContain("blob");
    expect(sidebar.some(item => item.path === "/docs/vite/blob/quickstart" && item.active)).toBe(true);
  });

  it("keeps local sidebar links on the selected framework", () => {
    const sidebar = buildDocsSidebarNavigation("/docs/nitro/philosophy", "nitro");

    expect(sidebar.some(item => item.path === "/docs/nitro/philosophy" && item.active)).toBe(true);
    expect(sidebar.some(item => item.path?.startsWith("/docs/vite/"))).toBe(false);
  });

  it("creates a content page state without mutating the source document", () => {
    const doc = { title: "Source", description: "Desc", meta: { order: 1 } };
    const state = createDocsPageState(doc, "/docs/vite/getting-started", {
      title: "Fallback",
      sourceTitle: null,
      description: null,
    });

    expect(state).toMatchObject({
      path: "/docs/vite/getting-started",
      title: "Source",
      description: "Desc",
      seo: { title: "Source", description: "Desc" },
      data: { order: 1 },
    });
    expect(doc).not.toHaveProperty("path");
  });
});
