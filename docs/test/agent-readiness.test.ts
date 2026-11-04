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
  it("negotiates Markdown through nuxt-agent-discovery from @vite-hub/docs", () => {
    const source = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const workspace = readFileSync(resolve(docsRoot, "../pnpm-workspace.yaml"), "utf8");
    const docsPackage = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

    expect(config.modules?.[0]).toBe("@vite-hub/docs/nuxt");
    // The docs module installs nuxt-llms and nuxt-agent-discovery, so the site does not list them.
    expect(Object.keys(docsPackage.dependencies)).toEqual(expect.arrayContaining(["nuxt-agent-discovery", "nuxt-llms"]));
    // Local patch until nuxt-agent-discovery routes negotiated pages through the Cloudflare Worker.
    expect(workspace).toContain("nuxt-agent-discovery@0.7.0: patches/nuxt-agent-discovery@0.7.0.patch");
    expect(workspace).not.toContain("docus");
    // The docs module negotiates the root, the docs base, and every page outside it, so the site lists no routes.
    expect(Reflect.get(config, "agentDiscovery")).not.toHaveProperty("routes");
    const manifest = createDocsManifest({ dir: resolve(docsRoot, "content"), base: "/docs" });
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

  it("serves raw Markdown copies from the docs package", () => {
    const docsModule = readFileSync(resolve(packageRoot, "src/nuxt.ts"), "utf8");

    expect(docsModule).toContain('addServerHandler({ route: "/raw/**", method: "get", handler: resolver.resolve("./runtime/server/raw.js") })');
    expect(docsModule).toContain('{ baseName: "docs-raw", dir: rawDir }');
    expect(docsModule).toContain("toRawMarkdown(options.rawMarkdown ? await options.rawMarkdown(source, page) : source, { siteUrl: `${config.site.url}${config.appBase.replace(/\\/+$/, \"\")}`, pagePath: page.path })");
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

  it("routes the llms.txt links on vitehub.dev to raw Markdown or machine resources", () => {
    const source = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const manifest = createDocsManifest({ dir: resolve(docsRoot, "content"), base: "/docs" });
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

  it("pins the patched Nuxt toolchain and disables DevTools", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const lockfile = readFileSync(resolve(docsRoot, "../pnpm-lock.yaml"), "utf8");
    const workspace = readFileSync(resolve(docsRoot, "../pnpm-workspace.yaml"), "utf8");
    const cliPackage = JSON.parse(readFileSync(resolve(docsRoot, "../packages/cli/package.json"), "utf8"));

    expect(workspace).toContain("nuxt: ^4.5.2");
    expect(lockfile).toContain("nuxt@4.5.2:");
    expect(lockfile).toContain("'@nuxt/devtools@3.4.2':");
    expect(lockfile).not.toContain("nuxt@4.4.8:");
    expect(lockfile).not.toContain("'@nuxt/devtools@3.2.4':");
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

describe("trust and developer discovery content", () => {
  it("publishes substantive About, Contact, and Privacy source pages", () => {
    for (const page of trustPages) {
      const source = readFileSync(resolve(docsRoot, `content/${page}.md`), "utf8");
      expect(source.length, page).toBeGreaterThan(500);
      expect(source, page).toContain(`title: ${page === "privacy" ? "ViteHub privacy" : `${page[0]!.toUpperCase()}${page.slice(1)} ViteHub`}`);
      // The page header renders the title as the only H1.
      expect(source, page).not.toMatch(/^# /m);
    }
  });

  it("renders no site footer and keeps recovery links on the 404 page", () => {
    const app = readFileSync(resolve(packageRoot, "runtime/app/app.vue"), "utf8");
    const error = readFileSync(resolve(docsRoot, "app/error.vue"), "utf8");

    expect(app).not.toMatch(/<(?:AppFooter|UFooter)\b/);
    expect(error).not.toMatch(/<(?:AppFooter|UFooter)\b/);
    expect(error).toContain("label: \"Docs\", to: \"/docs\"");
    expect(error).toContain("<AppSearch");
    expect(error).toContain("llms.txt");
    expect(error).toContain("Sitemap");
  });

  it("names the OpenAPI, skill, MCP, and npm CLI entry points", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const resources = readFileSync(resolve(docsRoot, "content/docs/getting-started/ai-resources/index.md"), "utf8");
    const combined = `${config}\n${resources}`;

    expect(combined).toContain("When to use ViteHub");
    expect(combined).toContain("ViteHub OpenAPI");
    expect(combined).toContain("ViteHub Agent Skill");
    expect(combined).toContain("ViteHub MCP server");
    expect(combined).toContain("https://www.npmjs.com/package/vite-hub");
  });

  it("uses Nuxt Schema.org for truthful product and project identities", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const landing = readFileSync(resolve(docsRoot, "app/pages/index.vue"), "utf8");

    expect(config).toContain('"nuxt-schema-org"');
    expect(landing).toContain("defineOrganization({");
    expect(landing).toContain("defineSoftwareApp({");
    expect(landing).toContain('applicationCategory: "DeveloperApplication"');
    expect(landing).not.toMatch(/telephone|postalCode|streetAddress/);
  });
});
