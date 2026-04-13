import { describe, expect, it } from "vitest";
import { normalizeFrameworkPage, type NormalizedPage } from "../modules/vitehub-docs/runtime/utils/framework-content";
import { getFwVariantIdFromProps, getFwVariantsFromProps } from "../modules/vitehub-docs/runtime/utils/fw-variants";

describe("normalizeFrameworkPage", () => {
  it("filters non-matching framework and mode blocks in single render mode", () => {
    const page: NormalizedPage = {
      path: "/docs/nuxt/dummy",
      body: {
        toc: { links: [] },
        value: [
          ["h2", { id: "intro" }, "Intro"],
          ["fw", { id: "nuxt:dev" }, ["h2", { id: "nuxt-dev" }, "Nuxt dev"]],
          ["fw", { id: "nuxt:build" }, ["h2", { id: "nuxt-build" }, "Nuxt build"]],
        ],
      },
    };

    const normalized = normalizeFrameworkPage(page, {
      framework: "nuxt",
      mode: "build",
      renderMode: "single",
      tocMode: "current-selection",
    });

    expect(normalized?.body?.value).toEqual([
      ["h2", { id: "intro" }, "Intro"],
      ["fw", { id: "nuxt:build" }, ["h2", { id: "nuxt-build" }, "Nuxt build"]],
    ]);
    expect(normalized?.body?.toc?.links?.map(link => link.id)).toEqual(["intro", "nuxt-build"]);
  });

  it("groups adjacent fw blocks in all render mode", () => {
    const page: NormalizedPage = {
      path: "/docs/nuxt/dummy",
      body: {
        toc: { links: [] },
        value: [
          ["fw", { id: "vite:dev" }, "Vite dev"],
          "\n",
          ["fw", { id: "nuxt:dev" }, "Nuxt dev"],
          ["p", {}, "Outside"],
        ],
      },
    };

    const normalized = normalizeFrameworkPage(page, {
      framework: "nuxt",
      mode: "dev",
      renderMode: "all",
      tocMode: "current-selection",
    });

    expect(normalized?.body?.value?.[0]).toEqual([
      "fw-group",
      {
        items: [{ id: "vite:dev" }, { id: "nuxt:dev" }],
      },
      ["fw", { id: "vite:dev" }, "Vite dev"],
      ["fw", { id: "nuxt:dev" }, "Nuxt dev"],
    ]);
  });

  it("preserves blank lines inside fw block bodies when grouping AST nodes", () => {
    const page: NormalizedPage = {
      path: "/docs/nuxt/dummy",
      body: {
        toc: { links: [] },
        children: [
          {
            type: "element",
            tag: "fw",
            props: { id: "vite:dev" },
            children: [
              { type: "text", value: "\n" },
              {
                type: "element",
                tag: "h3",
                children: [{ type: "text", value: "Vite" }],
              },
              { type: "text", value: "\n" },
              {
                type: "element",
                tag: "p",
                children: [{ type: "text", value: "Use the local entry at src/server.ts." }],
              },
              { type: "text", value: "\n" },
            ],
          },
          {
            type: "element",
            tag: "fw",
            props: { id: "nuxt:dev" },
            children: [{ type: "text", value: "Nuxt dev" }],
          },
        ],
      },
    };

    const normalized = normalizeFrameworkPage(page, {
      framework: "nuxt",
      mode: "dev",
      renderMode: "all",
      tocMode: "current-selection",
    });

    expect(normalized?.body?.children?.[0]).toEqual({
      type: "element",
      tag: "fw-group",
      props: {
        items: [
          {
            id: "vite:dev",
            body: {
              type: "root",
              children: [
                { type: "text", value: "\n" },
                {
                  type: "element",
                  tag: "h3",
                  props: {},
                  children: [{ type: "text", value: "Vite" }],
                },
                { type: "text", value: "\n" },
                {
                  type: "element",
                  tag: "p",
                  props: {},
                  children: [{ type: "text", value: "Use the local entry at src/server.ts." }],
                },
                { type: "text", value: "\n" },
              ],
            },
          },
          {
            id: "nuxt:dev",
            body: {
              type: "root",
              children: [{ type: "text", value: "Nuxt dev" }],
            },
          },
        ],
      },
      children: [],
    });
  });

  it("expands shorthand framework props across usage modes", () => {
    expect(getFwVariantsFromProps({ ":nuxt": "true" })).toEqual([
      { framework: "nuxt", mode: "dev", id: "nuxt:dev" },
      { framework: "nuxt", mode: "build", id: "nuxt:build" },
    ]);
    expect(getFwVariantIdFromProps({ ":vite": "true", ":nitro": false })).toBe("vite:dev vite:build");
  });

  it("keeps shorthand fw blocks for the active framework", () => {
    const page: NormalizedPage = {
      path: "/docs/nuxt/providers/cloudflare",
      body: {
        toc: { links: [] },
        children: [
          {
            type: "element",
            tag: "fw",
            props: { ":vite": "true" },
            children: [{ type: "text", value: "Vite only" }],
          },
          {
            type: "element",
            tag: "fw",
            props: { ":nuxt": "true", ":nitro": "true" },
            children: [{ type: "text", value: "Nuxt and Nitro" }],
          },
        ],
      },
    };

    const normalized = normalizeFrameworkPage(page, {
      framework: "nuxt",
      mode: "build",
      renderMode: "single",
      tocMode: "current-selection",
    });

    expect(normalized?.body?.children).toEqual([
      {
        type: "element",
        tag: "fw",
        props: { ":nuxt": "true", ":nitro": "true" },
        children: [{ type: "text", value: "Nuxt and Nitro" }],
      },
    ]);
  });
});
