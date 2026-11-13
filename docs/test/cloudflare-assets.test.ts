import { resolve } from "node:path";
import { H3, getCookie } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import staticAssets, { shouldServePrerenderedAsset } from "../server/middleware/static-assets";

// Nitro builds `#docs/manifest` from the content folder. The test reads the same folder.
vi.mock("#docs/manifest", async () => {
  const { createDocsManifest } = await import("@vite-hub/docs/server");
  return { default: await createDocsManifest({ dir: resolve(import.meta.dirname, "../content"), base: "/docs" }) };
});

const fetchAsset = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(new Response("prerendered: hidden", {
  headers: { "Cache-Control": "public, max-age=3600", Vary: "Accept-Encoding" },
})));
// Matches the Workers asset binding, which is not a plain object.
class Fetcher {
  readonly [Symbol.toStringTag] = "Fetcher";
  fetch = fetchAsset;
}
vi.mock("nuxt/server", () => ({
  useRuntimeConfig: () => ({ agentDiscovery: { userAgents: ["GPTBot"] } }),
  // Nitro matches the route rules of nuxt.config.ts. The Learn rule is the only one with headers.
  getRouteRules: (event: { path: string }) => event.path.startsWith("/learn")
    ? { headers: { "Cross-Origin-Embedder-Policy": "credentialless", "Cross-Origin-Opener-Policy": "same-origin" } }
    : {},
}));
const app = new H3()
  .use(staticAssets)
  .use(event => getCookie(event, "vh-tutorial-navigation") === "true" ? "rendered: open" : "rendered: hidden");
// Nitro's Worker entry decorates the Request before passing it to H3.
const request = (input: Request) => app.fetch(Object.assign(input, {
  runtime: { cloudflare: { env: { ASSETS: new Fetcher() }, context: {} } },
}));

beforeEach(() => vi.clearAllMocks());

describe("Cloudflare prerendered page middleware", () => {
  const input = { method: "GET", userAgents: ["GPTBot"] };

  it("serves ordinary HTML requests from the asset binding", () => {
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/html,application/xhtml+xml" })).toBe(true);
    expect(shouldServePrerenderedAsset({ ...input, accept: "*/*" })).toBe(true);
  });

  it("leaves Markdown negotiation in Nitro", () => {
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/markdown" })).toBe(false);
    expect(shouldServePrerenderedAsset({ ...input, userAgent: "GPTBot" })).toBe(false);
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/markdown;q=0.1,text/html;q=1" })).toBe(true);
  });

  it("normalizes media types and quality parameter names", () => {
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/markdown;Q=0,*/*;q=1" })).toBe(true);
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/markdown ; q=1,text/html;q=0" })).toBe(false);
  });

  it.each([
    { Accept: "text/markdown", "User-Agent": "" },
    { Accept: "text/html", "User-Agent": "GPTBot" },
  ])("leaves negotiated requests in Nitro with headers %j", async (headers) => {
    const response = await request(new Request("https://vitehub.dev/learn/first-agent", { headers }));

    expect(fetchAsset).not.toHaveBeenCalled();
    expect(await response.text()).toBe("rendered: hidden");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });

  it.each([
    "/docs/kv/get-started",
    "/playground",
    "/playground/?template=kv",
    "/learn/first-agent",
    "/learn/first-agent/",
  ])("renders %s with its saved open navigation", async (path) => {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(new Request(`https://vitehub.dev${path}`, {
        method,
        headers: { Accept: "text/html", Cookie: "vh-tutorial-navigation=true" },
      }));

      expect(fetchAsset).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toContain("Cookie");
      if (method === "GET") expect(await response.text()).toBe("rendered: open");
    }
  });

  it.each([undefined, "vh-tutorial-navigation=false"])("keeps hidden tutorials prerendered with cookie %s", async (cookie) => {
    const headers = new Headers({ Accept: "text/html" });
    if (cookie) headers.set("Cookie", cookie);
    const input = new Request("https://vitehub.dev/docs/kv/get-started", { headers });
    const response = await request(input);

    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(fetchAsset).toHaveBeenCalledWith(input);
    expect(await response.text()).toBe("prerendered: hidden");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Accept, User-Agent, Cookie");
  });

  it.each(["/playground", "/learn/first-agent"])("keeps collapsed app page %s prerendered", async (path) => {
    const response = await request(new Request(`https://vitehub.dev${path}`, { headers: { Accept: "text/html" } }));

    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("prerendered: hidden");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });

  it.each(["/docs/kv/agent-capability", "/learn", "/learn/not/a/lesson", "/playground-info"])("keeps ordinary page %s prerendered when tutorial navigation was opened", async (path) => {
    const response = await request(new Request(`https://vitehub.dev${path}`, {
      headers: { Accept: "text/html", Cookie: "vh-tutorial-navigation=true" },
    }));

    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("does not repeat Vary values that the asset already sends", async () => {
    fetchAsset.mockResolvedValueOnce(new Response("prerendered: home", { headers: { Vary: "Accept, User-Agent" } }));
    const response = await request(new Request("https://vitehub.dev/", { headers: { Accept: "text/html" } }));

    expect(await response.text()).toBe("prerendered: home");
    expect(response.headers.get("vary")).toBe("Accept, User-Agent");
  });

  it("keeps the cross-origin isolation of prerendered tutorials and adds it nowhere else", async () => {
    const tutorial = await request(new Request("https://vitehub.dev/learn/first-agent", { headers: { Accept: "text/html" } }));
    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(tutorial.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(tutorial.headers.get("cross-origin-embedder-policy")).toBe("credentialless");

    const docs = await request(new Request("https://vitehub.dev/docs/kv/agent-capability", { headers: { Accept: "text/html" } }));
    expect(docs.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(docs.headers.get("cross-origin-embedder-policy")).toBeNull();
  });
});
