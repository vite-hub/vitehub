import { appendResponseHeader, defineEventHandler, getCookie, getRequestHeader, getRequestURL, setResponseHeader } from "h3";
import { docsSidebarCollapses, docsTutorialNavigationCookie, findDocsPage } from "@vite-hub/docs";
import { getRouteRules, useRuntimeConfig } from "nuxt/server";
import manifest from "#docs/manifest";

type CloudflareAssets = {
  fetch: (request: Request) => Promise<Response>;
};

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

// The Workers binding is a `Fetcher`, not a plain object.
function isCloudflareAssets(value: unknown): value is CloudflareAssets {
  return typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function";
}

// Nitro 3 attaches Worker bindings to the incoming request runtime.
function getCloudflareAssets(value: unknown) {
  if (!isRecord(value) || !isRecord(value.env)) return;
  const assets = value.env.ASSETS;
  return isCloudflareAssets(assets) ? assets : undefined;
}

function acceptsMarkdown(accept: string | undefined) {
  if (!accept) return false;

  const entries = accept.split(",").map((entry) => {
    const [rawType, ...parameters] = entry.trim().split(";");
    const type = rawType.trim().toLowerCase();
    const quality = parameters.find((parameter) => parameter.trim().toLowerCase().startsWith("q="))?.trim().slice(2);
    const parsedQuality = quality === undefined ? 1 : Number(quality);
    return { type, quality: Number.isFinite(parsedQuality) ? Math.min(Math.max(parsedQuality, 0), 1) : 0 };
  });
  const explicitMarkdown = entries.filter((entry) => entry.type === "text/markdown").reduce((max, entry) => Math.max(max, entry.quality), 0);
  const markdown = entries.filter((entry) => entry.type === "text/markdown" || entry.type === "text/*" || entry.type === "*/*").reduce((max, entry) => Math.max(max, entry.quality), 0);
  const html = entries.filter((entry) => entry.type === "text/html" || entry.type === "text/*" || entry.type === "*/*").reduce((max, entry) => Math.max(max, entry.quality), 0);
  return explicitMarkdown > 0 ? explicitMarkdown >= html : html === 0 && markdown > 0;
}

function isAgentUserAgent(userAgent: string | undefined, configured: unknown) {
  if (!userAgent || !Array.isArray(configured)) return false;
  const haystack = userAgent.toLowerCase();
  return configured.some((value): value is string => isString(value) && haystack.includes(value.toLowerCase()));
}

export function shouldServePrerenderedAsset(input: {
  accept?: string;
  method: string;
  userAgent?: string;
  userAgents?: unknown;
}) {
  return (input.method === "GET" || input.method === "HEAD")
    && !acceptsMarkdown(input.accept)
    && !isAgentUserAgent(input.userAgent, input.userAgents);
}

// Agent discovery sends negotiated pages through the Worker. Let the asset
// binding answer ordinary HTML requests before Nitro renders the same page.
// This keeps Markdown negotiation and avoids slow server rendering of pages
// that Nitro already prerendered.
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname.replace(/\/+$/, "");
  const page = findDocsPage(manifest, path)?.page;
  // These app pages opt in through definePageMeta, so they are absent from the content manifest.
  const collapses = path === "/playground" || /^\/learn\/[^/]+$/.test(path) || (!!page && docsSidebarCollapses(page));
  if (collapses) {
    // The browser must request the layout again after the navigation cookie changes.
    setResponseHeader(event, "Cache-Control", "private, no-store");
    appendResponseHeader(event, "Vary", "Cookie");
    // Prerendered pages show the collapsed sidebar. Render saved open layouts with the
    // request cookie so the server and client agree before hydration.
    if (getCookie(event, docsTutorialNavigationCookie) === "true") return;
  }

  const assets = getCloudflareAssets(event.req.runtime?.cloudflare);
  const agentDiscovery = useRuntimeConfig(event).agentDiscovery;
  const userAgents = isRecord(agentDiscovery) ? agentDiscovery.userAgents : undefined;
  if (!assets || !shouldServePrerenderedAsset({
    accept: getRequestHeader(event, "accept"),
    method: event.method,
    userAgent: getRequestHeader(event, "user-agent"),
    userAgents,
  })) return;

  const response = await assets.fetch(event.req);
  if (response.status !== 404) {
    const headers = new Headers(response.headers);
    // Same as the Vary that Markdown negotiation sends, since this choice also reads both headers.
    // `_headers` already sets it for some pages.
    const vary = new Set((headers.get("Vary") ?? "").split(",").map(value => value.trim()).filter(Boolean));
    headers.set("Vary", [...vary.add("Accept").add("User-Agent")].join(", "));
    // The asset response must carry the route rule headers too, such as
    // the cross-origin isolation of `/learn/**`.
    for (const [name, value] of Object.entries(getRouteRules(event).headers ?? {})) headers.set(name, value);
    if (collapses) {
      headers.set("Cache-Control", "private, no-store");
      headers.append("Vary", "Cookie");
      // H3 applies staged headers to returned Responses. Keep the asset's full Vary value.
      setResponseHeader(event, "Vary", headers.get("Vary")!);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
});
