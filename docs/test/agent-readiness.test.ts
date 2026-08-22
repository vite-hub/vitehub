import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { viteHubOpenApi } from "../server/utils/openapi";
import {
  acceptsAgentFriendlyError,
  notFoundMarkdown,
  withVary,
} from "../server/utils/markdown-negotiation";

const docsRoot = resolve(import.meta.dirname, "..");
const trustPages = ["about", "contact", "privacy"];

describe("agent-ready HTTP contracts", () => {
  it("selects agent-friendly 404 responses from the Accept header", () => {
    expect(acceptsAgentFriendlyError(undefined)).toBe(true);
    expect(acceptsAgentFriendlyError("*/*")).toBe(true);
    expect(acceptsAgentFriendlyError("text/markdown")).toBe(true);
    expect(acceptsAgentFriendlyError("text/markdown;q=0, */*")).toBe(false);
    expect(acceptsAgentFriendlyError("text/html, */*")).toBe(false);
    expect(acceptsAgentFriendlyError("text/html;q=0, */*")).toBe(true);
    expect(acceptsAgentFriendlyError("application/json, */*")).toBe(false);
  });

  it("uses the Docus preview package for Markdown negotiation", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const workspace = readFileSync(resolve(docsRoot, "../pnpm-workspace.yaml"), "utf8");

    expect(workspace).toContain("docus: https://pkg.pr.new/docus@986a334");
    expect(config).not.toContain("routeRules:");
    expect(config).not.toContain("run_worker_first");
  });

  it("adds Accept to Vary once and gives missing routes recovery links", () => {
    expect(withVary(undefined, "Accept")).toBe("Accept");
    expect(withVary("Accept-Encoding", "Accept")).toBe("Accept-Encoding, Accept");
    expect(withVary("accept, Accept-Encoding", "Accept")).toBe("accept, Accept-Encoding");

    const markdown = notFoundMarkdown("/missing");
    expect(markdown).toContain("# ViteHub page not found");
    expect(markdown).toContain("https://vitehub.dev/docs");
    expect(markdown).toContain("https://vitehub.dev/llms.txt");
    expect(markdown).toContain("https://vitehub.dev/sitemap.xml");
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
    const errorHandler = readFileSync(resolve(docsRoot, "server/error-handler.ts"), "utf8");
    const module = readFileSync(resolve(docsRoot, "modules/vitehub-docs/index.ts"), "utf8");

    for (const page of trustPages) expect(footer).toContain(`to: "/${page}"`);
    expect(error).toContain("Documentation index");
    expect(error).toContain("llms.txt");
    expect(error).toContain("Sitemap");
    expect(errorHandler).toContain('"content-type": "text/markdown; charset=utf-8"');
    expect(errorHandler).toContain('"vary": vary');
    expect(errorHandler).toContain('withVary(getResponseHeader(event, "vary")?.toString(), "Accept")');
    expect(module).toContain('config.errorHandler = [agentErrorHandler, ...configuredHandlers]');
  });

  it("names the OpenAPI, skill, MCP, and npm CLI entry points", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const resources = readFileSync(resolve(docsRoot, "content/docs/ai-resources/index.md"), "utf8");
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
