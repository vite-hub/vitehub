import { createApp, defineEventHandler, getCookie, toWebHandler, toWebRequest } from "h3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import staticAssets, { shouldServePrerenderedAsset } from "../server/middleware/static-assets";

const fetchAsset = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(new Response("prerendered: hidden", {
  headers: { "Cache-Control": "public, max-age=3600", Vary: "Accept-Encoding" },
})));
// Matches the Workers asset binding, which is not a plain object.
class Fetcher {
  readonly [Symbol.toStringTag] = "Fetcher";
  fetch = fetchAsset;
}
vi.stubGlobal("useRuntimeConfig", () => ({ agentDiscovery: { userAgents: ["GPTBot"] } }));
const request = toWebHandler(createApp()
  .use(defineEventHandler((event) => {
    // Nitro's `cloudflare_module` preset passes the Worker request here.
    event.context.cloudflare = { env: { ASSETS: new Fetcher() }, request: toWebRequest(event) };
  }))
  .use(staticAssets)
  .use(defineEventHandler(event => getCookie(event, "vh-tutorial-navigation") === "true" ? "rendered: open" : "rendered: hidden")));

beforeEach(() => vi.clearAllMocks());
afterAll(() => vi.unstubAllGlobals());

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

  it.each(["GET", "HEAD"])("renders a tutorial with its saved open navigation for %s requests", async (method) => {
    const response = await request(new Request("https://vitehub.dev/docs/kv/get-started", {
      method,
      headers: { Accept: "text/html", Cookie: "vh-tutorial-navigation=true" },
    }));

    expect(fetchAsset).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    if (method === "GET") expect(await response.text()).toBe("rendered: open");
  });

  it.each([undefined, "vh-tutorial-navigation=false"])("keeps hidden tutorials prerendered with cookie %s", async (cookie) => {
    const headers = new Headers({ Accept: "text/html" });
    if (cookie) headers.set("Cookie", cookie);
    const response = await request(new Request("https://vitehub.dev/docs/kv/get-started", { headers }));

    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(fetchAsset.mock.calls[0]?.[0].url).toBe("https://vitehub.dev/docs/kv/get-started");
    expect(await response.text()).toBe("prerendered: hidden");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Accept, User-Agent, Cookie");
  });

  it("keeps ordinary docs prerendered when tutorial navigation was opened", async () => {
    const response = await request(new Request("https://vitehub.dev/docs/kv/agent-capability", {
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
});
