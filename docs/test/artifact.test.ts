import { readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

import { docsUi } from "../../packages/docs/src/theme";

import type { Unstable_RawConfig } from "wrangler";

const docsRoot = resolve(import.meta.dirname, "..");
const serverRoot = resolve(docsRoot, ".output/server");
const workerConfig: Unstable_RawConfig = JSON.parse(readFileSync(resolve(serverRoot, "wrangler.json"), "utf8"));
const server = createTestHarness({
  root: serverRoot,
  // Nitro 3 emits thousands of modules. Bundle them for the local runtime to avoid
  // Miniflare's slow serialization of the separate modules into its config.
  workers: [{ config: { ...workerConfig, no_bundle: false, rules: [] } }],
});

beforeAll(async () => {
  await server.listen();
});
afterAll(() => server.close());

describe("Cloudflare docs artifact", () => {
  it("excludes Worker sourcemaps from the deployment", () => {
    const serverDir = resolve(docsRoot, ".output/server");
    const config: unknown = JSON.parse(readFileSync(resolve(serverDir, "wrangler.json"), "utf8"));
    expect(config).toMatchObject({ upload_source_maps: false });
    // Zero maps keeps the upload below Cloudflare's 60 MiB encoded-sourcemap limit.
    // Wrangler's test harness writes its own maps under .wrangler after server.listen().
    expect(readdirSync(serverDir, { recursive: true }).filter(file => !file.startsWith(`.wrangler${sep}`) && file.endsWith(".map"))).toEqual([]);
  });

  it.each([
    { name: "HTML docs", path: "/docs", status: 200, type: "text/html", content: "<title", accept: "text/html" },
    { name: "raw Markdown", path: "/raw/docs/getting-started.md", status: 200, type: "text/markdown", content: "# Introduction", accept: "text/markdown" },
    { name: "sitemap", path: "/sitemap.xml", status: 200, type: "application/xml", content: "<urlset", accept: "*/*" },
    { name: "HTML 404", path: "/missing-docs-artifact-smoke", status: 404, type: "text/html", content: "Page not found", accept: "text/html" },
    { name: "static logo", path: "/vitehub-logo.svg", status: 200, type: "image/svg+xml", content: "<svg", accept: "*/*" },
    { name: "Markdown twin", path: "/docs/getting-started.md", status: 200, type: "text/markdown", content: "# Introduction", accept: "*/*" },
    // The home page has its own Markdown copy, `content/index.md`. llms.txt stays the index of every page.
    { name: "Markdown home", path: "/", status: 200, type: "text/markdown", content: "# The server layer for Vite apps", accept: "text/markdown" },
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

  it("server-renders the color mode button", async () => {
    const response = await server.fetch("/docs/getting-started", { headers: { accept: "text/html" } });
    expect(await response.text()).toContain(`aria-label="Switch to dark mode"`);
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

  it("server-renders Markdown with the prose components", async () => {
    const response = await server.fetch("/docs/getting-started", { headers: { accept: "text/html" } });
    const html = await response.text();
    const content = html.slice(html.indexOf(`class="comark-content"`), html.indexOf(`class="vh-product-footer`));
    // Nuxt UI's prose link, as the browser renders it after hydration.
    expect(content).toMatch(/<a href="\/docs\/[^"]+" class="[^"]*underline/);
  });

  it("serves a prerendered robots.txt before the Worker for AhrefsBot", async () => {
    const robots = readFileSync(resolve(docsRoot, ".output/public/robots.txt"), "utf8");
    const config: unknown = JSON.parse(readFileSync(resolve(docsRoot, ".output/server/wrangler.json"), "utf8"));
    expect(config).toMatchObject({ assets: { run_worker_first: expect.arrayContaining(["!/robots.txt"]) } });
    // nuxt-agent-discovery adds a Content-Signal line that allows search, AI input, and AI training.
    expect(robots).toMatch(/^User-agent: \*\s*\n(?:Content-Signal: [^\n]+\n)?Allow: \/\s*$/m);
    expect(robots).toMatch(/^Sitemap: https:\/\/vitehub\.dev\/sitemap\.xml\s*$/m);

    const response = await server.fetch("/robots.txt", {
      headers: { "user-agent": "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(robots);
  });

  it("builds the CSS of every class in the docs design", () => {
    const cssDir = resolve(docsRoot, ".output/public/_nuxt");
    const css = readdirSync(cssDir).filter(file => file.endsWith(".css")).map(file => readFileSync(resolve(cssDir, file), "utf8")).join("\n");
    const strings = (value: unknown): string[] => typeof value === "string"
      ? value.split(/\s+/)
      : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    // Utilities only: icon names and plain words such as `vertical` are not classes.
    const classes = new Set(strings(docsUi("ViteHub")).filter(name => /[-:[]/.test(name) && !name.startsWith("i-")));
    const selector = (name: string) => `.${name.replace(/[^\w-]/g, character => `\\${character}`)}`;
    expect([...classes].filter(name => !css.includes(selector(name)))).toEqual([]);
  });
});
