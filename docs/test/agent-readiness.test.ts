import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { viteHubOpenApi } from "../server/utils/openapi";
import { rawMarkdownUrl, rewriteLlmsRawLinks } from "../modules/vitehub-docs/runtime/utils/llms-links";
import { createCapabilityReferences } from "../modules/vitehub-docs/capability-references";

const docsRoot = resolve(import.meta.dirname, "..");
const trustPages = ["about", "contact", "privacy"];

describe("agent-ready HTTP contracts", () => {
  it("negotiates Markdown through nuxt-agent-discovery from Docus", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const workspace = readFileSync(resolve(docsRoot, "../pnpm-workspace.yaml"), "utf8");

    // Docus main includes nuxt-agent-discovery (nuxt-content/docus#1435), which is not released yet.
    expect(workspace).toContain("docus: https://pkg.pr.new/docus@c229a86");
    // Local patch until nuxt-agent-discovery routes negotiated pages through the Cloudflare Worker.
    expect(workspace).toContain("nuxt-agent-discovery@0.7.0: patches/nuxt-agent-discovery@0.7.0.patch");
    expect(config).toContain('routes: ["/", "/docs", "/docs/**", "/about", "/contact", "/privacy"]');
    expect(config).not.toContain("routeRules:");
    expect(config).not.toContain("run_worker_first");
    expect(config).toContain("contentRawMarkdown: false");
  });

  it("serves ViteHub-owned raw Markdown artifacts", () => {
    const module = readFileSync(resolve(docsRoot, "modules/vitehub-docs/index.ts"), "utf8");

    expect(module).toContain('baseURL: "/raw"');
    expect(module).toContain('dir: resolve(outputDir, "raw")');
    expect(module).toContain('config.serverAssets.push({ baseName: "vitehub-raw", dir: resolve(outputDir, "raw") })');
    expect(module).toContain("config.plugins.push(llmsRawLinksPlugin)");
    expect(module).toContain("const manifest = writeDocsArtifacts({ capabilityReferences, docsRoot, outputDir });");
    expect(module).toContain("const capabilityReferences = await createCapabilityReferences();");
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

  it("keeps the compact index routed to raw Markdown", () => {
    expect(rawMarkdownUrl("https://vitehub.dev/docs", "https://vitehub.dev")).toBe("https://vitehub.dev/raw/docs.md");
    expect(rawMarkdownUrl("https://vitehub.dev/docs/", "https://vitehub.dev")).toBe("https://vitehub.dev/raw/docs.md");
    expect(rawMarkdownUrl("/docs/kv#runtime", "https://vitehub.dev")).toBe(
      "https://vitehub.dev/raw/docs/kv.md#runtime",
    );
    expect(rawMarkdownUrl("/guides", "https://vitehub.dev")).toBe("/guides");
    expect(rawMarkdownUrl("https://vitehub.dev/privacy?source=llms", "https://vitehub.dev")).toBe(
      "https://vitehub.dev/raw/privacy.md?source=llms",
    );
    expect(rawMarkdownUrl("/blog", "https://vitehub.dev")).toBe("/blog");
    expect(rawMarkdownUrl("/pricing", "https://vitehub.dev")).toBe("/pricing");
    expect(rawMarkdownUrl("https://example.com/docs", "https://vitehub.dev")).toBe("https://example.com/docs");

    const options = {
      domain: "https://vitehub.dev",
      sections: [{ links: [
        { href: "https://vitehub.dev/docs/agents" },
        { href: "https://vitehub.dev/guides" },
        { href: "https://vitehub.dev/about" },
        { href: "https://vitehub.dev/contact" },
        { href: "https://vitehub.dev/privacy" },
        { href: "https://vitehub.dev/" },
        { href: "https://www.npmjs.com/package/vite-hub" },
      ] }],
    };
    rewriteLlmsRawLinks(options);
    expect(options.sections[0]?.links).toEqual([
      { href: "https://vitehub.dev/raw/docs/agents.md" },
      { href: "https://vitehub.dev/guides" },
      { href: "https://vitehub.dev/raw/about.md" },
      { href: "https://vitehub.dev/raw/contact.md" },
      { href: "https://vitehub.dev/raw/privacy.md" },
      { href: "https://vitehub.dev/" },
      { href: "https://www.npmjs.com/package/vite-hub" },
    ]);
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
      const source = readFileSync(resolve(docsRoot, `content/trust/${page}.md`), "utf8");
      expect(source.length, page).toBeGreaterThan(500);
      expect(source, page).toContain(`# ${page === "privacy" ? "ViteHub privacy" : `${page[0]!.toUpperCase()}${page.slice(1)} ViteHub`}`);
    }
  });

  it("links trust pages from the shared footer and the 404 page", () => {
    const footer = readFileSync(resolve(docsRoot, "app/components/AppFooter.vue"), "utf8");
    const error = readFileSync(resolve(docsRoot, "app/error.vue"), "utf8");

    for (const page of trustPages) expect(footer).toContain(`to: "/${page}"`);
    expect(error).toContain("Documentation index");
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
