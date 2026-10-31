import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

const docsRoot = resolve(import.meta.dirname, "..");
const server = createTestHarness({
  root: docsRoot,
  workers: [{ configPath: ".output/server/wrangler.json" }],
});

beforeAll(async () => {
  await server.listen();
});
afterAll(() => server.close());

describe("Cloudflare docs artifact", () => {
  it.each([
    { name: "HTML docs", path: "/docs", status: 200, type: "text/html", content: "<title", accept: "text/html" },
    { name: "raw Markdown", path: "/raw/docs/getting-started.md", status: 200, type: "text/markdown", content: "# Introduction", accept: "text/markdown" },
    { name: "sitemap", path: "/sitemap.xml", status: 200, type: "text/xml", content: "<urlset", accept: "*/*" },
    { name: "HTML 404", path: "/missing-docs-artifact-smoke", status: 404, type: "text/html", content: "Page not found", accept: "text/html" },
    { name: "static logo", path: "/vitehub-logo.svg", status: 200, type: "image/svg+xml", content: "<svg", accept: "*/*" },
    { name: "Markdown twin", path: "/docs/getting-started.md", status: 200, type: "text/markdown", content: "# Introduction", accept: "*/*" },
    { name: "Markdown home", path: "/", status: 200, type: "text/markdown", content: "> Portable Agents for Vite", accept: "text/markdown" },
    { name: "Markdown 404", path: "/missing-docs-artifact-smoke", status: 404, type: "text/markdown", content: "404", accept: "text/markdown" },
  ])("serves $name", async ({ path, status, type, content, accept }) => {
    const response = await server.fetch(path, { headers: { accept } });
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain(type);
    expect(await response.text()).toContain(content);
  });

  it("serves the OpenAPI document", async () => {
    const response = await server.fetch("/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ openapi: "3.1.0" });
  });

  it.each([
    ["text/markdown", "text/markdown"],
    ["text/html, text/markdown;q=0.5", "text/html"],
  ])("negotiates prerendered pages for %s", async (accept, contentType) => {
    const response = await server.fetch("/docs/getting-started", { headers: { accept } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(contentType);
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept");
    if (contentType === "text/markdown") expect(await response.text()).toMatch(/^# Introduction/);
  });

  it("serves a prerendered robots.txt before the Worker for AhrefsBot", async () => {
    const robots = readFileSync(resolve(docsRoot, ".output/public/robots.txt"), "utf8");
    const config: unknown = JSON.parse(readFileSync(resolve(docsRoot, ".output/server/wrangler.json"), "utf8"));
    expect(config).toMatchObject({ assets: { run_worker_first: expect.arrayContaining(["!/robots.txt"]) } });
    expect(robots).toMatch(/^User-agent: \*\s*\nAllow: \/\s*$/m);
    expect(robots).toMatch(/^Sitemap: https:\/\/vitehub\.dev\/sitemap\.xml\s*$/m);

    const response = await server.fetch("/robots.txt", {
      headers: { "user-agent": "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(robots);
  });
});
