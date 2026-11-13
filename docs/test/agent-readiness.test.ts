import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findDocsPage } from "@vite-hub/docs";
import { createDocsManifest } from "@vite-hub/docs/server";
import { viteHubOpenApi } from "../server/utils/openapi";
import { createCapabilityReferences } from "../modules/vitehub-docs/capability-references";
import config from "../nuxt.config";

const docsRoot = resolve(import.meta.dirname, "..");
const packageRoot = resolve(docsRoot, "../packages/docs");
const trustPages = ["about", "contact", "privacy"];

describe("agent-ready HTTP contracts", () => {
  it("negotiates Markdown through nuxt-agent-discovery from @vite-hub/docs", async () => {
    const source = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const workspace = readFileSync(resolve(docsRoot, "../pnpm-workspace.yaml"), "utf8");
    const docsPackage = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

    const modules = config.modules ?? [];
    const diagnostics = modules.indexOf("./modules/diagnostics");
    expect(diagnostics).toBeGreaterThanOrEqual(0);
    expect(modules.indexOf("@vite-hub/docs/nuxt")).toBeGreaterThan(diagnostics);
    // The docs module installs nuxt-llms and nuxt-agent-discovery, so the site does not list them.
    expect(Object.keys(docsPackage.dependencies)).toEqual(expect.arrayContaining(["nuxt-agent-discovery", "nuxt-llms"]));
    // Local patch until nuxt-agent-discovery routes negotiated pages through the Cloudflare Worker.
    expect(workspace).toContain("nuxt-agent-discovery@0.8.2: patches/nuxt-agent-discovery@0.8.2.patch");
    expect(workspace).not.toContain("docus");
    // The docs module negotiates the root, the docs base, and every page outside it, so the site lists no routes.
    expect(Reflect.get(config, "agentDiscovery")).not.toHaveProperty("routes");
    const manifest = await createDocsManifest({ dir: resolve(docsRoot, "content"), base: "/docs" });
    expect(manifest.pages.map(page => page.path).filter(path => path !== "/")).toEqual(trustPages.map(page => `/${page}`));
    expect(source).not.toContain("routeRules:");
    expect(source).toContain('{ href: "/openapi.json", rel: "service-desc", type: "application/vnd.oai.openapi+json"');
  });

  it("configures the ViteHub site through the docs options", () => {
    expect(config.docs?.site).toMatchObject({ name: "ViteHub", url: "https://vitehub.dev", logo: "/vitehub-mark.svg" });
    expect(config.docs?.github).toEqual({ repo: "vite-hub/vitehub", dir: "docs/content" });
    expect(config.docs?.mcp).toMatchObject({ name: "vitehub" });
    expect(config.docs?.sitemap).toEqual(["/learn", "/playground", "/examples", "/projects", "/templates"]);
    expect(typeof config.docs?.rawMarkdown).toBe("function");
  });

  it("derives Capability references from the real model-facing tools", async () => {
    const references = await createCapabilityReferences();

    expect(references["papercuts.default"]?.tools).toEqual([
      expect.objectContaining({
        description: expect.stringContaining("Never include secrets or customer data"),
        inputSchema: expect.objectContaining({ required: ["message"], type: "object" }),
        name: "report_papercut",
      }),
    ]);
    expect(references["db.write"]?.tools.map(tool => tool.name)).toEqual([
      "db_exec",
      "db_query",
      "db_schema",
    ]);
    expect(references["gmail.read"]?.tools.map(tool => tool.name)).toEqual(["gmail_read", "gmail_search"]);
    expect(references["gmail.draft"]?.tools.map(tool => tool.name)).toEqual(["gmail_draft", "gmail_read", "gmail_search"]);
  });

  it("routes the llms.txt links on vitehub.dev to raw Markdown or machine resources", async () => {
    const source = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const manifest = await createDocsManifest({ dir: resolve(docsRoot, "content"), base: "/docs" });
    const links = [...source.matchAll(/href: "https:\/\/vitehub\.dev(\/[^"]*)"/g)].map(match => match[1]!);
    const machineResources = ["/openapi.json", "/.well-known/skills/vitehub/SKILL.md", "/mcp"];

    expect(links.length).toBeGreaterThan(0);
    for (const link of links.filter(link => !machineResources.includes(link))) {
      expect(link).toMatch(/^\/raw\/.+\.md$/);
      // Each raw link names a page that the build writes a raw copy for.
      expect(findDocsPage(manifest, link.replace(/^\/raw/, "").replace(/\.md$/, "")), link).not.toBeNull();
    }
  });

  it("documents only the llms indexes that the docs host serves", () => {
    const resources = readFileSync(resolve(docsRoot, "content/docs/getting-started/ai-resources/index.md"), "utf8");
    const documented = [...new Set([...resources.matchAll(/https:\/\/vitehub\.dev(\/llms[^\s)`]*\.txt)/g)].map(match => match[1]))];

    expect(documented.sort()).toEqual(["/llms-full.txt", "/llms.txt"]);
  });

  it("pins the Nuxt 5 toolchain and disables DevTools", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const lockfile = readFileSync(resolve(docsRoot, "../pnpm-lock.yaml"), "utf8");
    const workspace = readFileSync(resolve(docsRoot, "../pnpm-workspace.yaml"), "utf8");
    const cliPackage = JSON.parse(readFileSync(resolve(docsRoot, "../packages/cli/package.json"), "utf8"));

    expect(workspace).toContain("nuxt: npm:nuxt-nightly@5.0.0-2611052317-a04317f");
    expect(workspace).toContain('nuxt: ">=5.0.0-0"');
    expect(lockfile).toContain("nuxt-nightly@5.0.0-2611052317-a04317f:");
    expect(lockfile).toContain("nitro@3.0.261103-rc:");
    expect(lockfile).toContain("'@nuxt/devtools@3.4.4':");
    expect(config).toMatch(/devtools:\s*{\s*enabled:\s*false/);
    expect(cliPackage.peerDependencies.nuxt).toBe("catalog:nuxt-compat");
    expect(cliPackage.peerDependenciesMeta.nuxt).toEqual({ optional: true });
  });
});

describe("ViteHub OpenAPI document", () => {
  it("publishes a complete, function-call-friendly operation contract", () => {
    expect(viteHubOpenApi.openapi).toBe("3.1.0");
    expect(viteHubOpenApi.info.title).toContain("ViteHub");
    expect(viteHubOpenApi.security).toEqual([]);

    const operations = Object.values(viteHubOpenApi.paths).map(path => path.get);
    const operationIds = operations.map(operation => operation.operationId);

    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operations.length).toBeGreaterThanOrEqual(6);

    for (const operation of operations) {
      expect(operation.operationId.length).toBeGreaterThan(5);
      expect(operation.description.length).toBeGreaterThan(20);
      expect(operation.responses["200"]).toBeDefined();
      expect(operation.responses["404"]).toBeDefined();

      for (const parameter of "parameters" in operation ? operation.parameters : []) {
        expect(parameter.description.length).toBeGreaterThan(10);
        expect(parameter.schema.type).toBe("string");
      }
    }
  });

  it("types success and error response bodies", () => {
    for (const path of Object.values(viteHubOpenApi.paths)) {
      for (const response of Object.values(path.get.responses)) {
        for (const media of Object.values(response.content || {})) {
          expect(media.schema).toBeDefined();
        }
      }
    }
  });
});
