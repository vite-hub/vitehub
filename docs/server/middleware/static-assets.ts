import { appendResponseHeader, defineEventHandler, getCookie, getRequestHeader, getRequestURL, setResponseHeader } from "h3";
import { getDocsPageByPath } from "../../modules/vitehub-docs/runtime/utils/docs";

type CloudflareAssets = {
  fetch: (request: Request) => Promise<Response>;
};

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isCloudflareAssets(value: unknown): value is CloudflareAssets {
  return isRecord(value) && Object.prototype.toString.call(value.fetch) === "[object Function]";
}

function getAssets(value: unknown): CloudflareAssets | undefined {
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
  const isTutorial = getDocsPageByPath(getRequestURL(event).pathname)?.codePanel === true;
  if (isTutorial) {
    // The browser must request the layout again after the navigation cookie changes.
    setResponseHeader(event, "Cache-Control", "private, no-store");
    appendResponseHeader(event, "Vary", "Cookie");
    // Prerendered tutorials have no navigation. Render saved open layouts with the
    // request cookie so the server and client agree before hydration.
    if (getCookie(event, "vh-tutorial-navigation") === "true") return;
  }

  const assets = getAssets(event.context.cloudflare);
  const agentDiscovery = useRuntimeConfig(event).agentDiscovery;
  const userAgents = isRecord(agentDiscovery) ? agentDiscovery.userAgents : undefined;
  if (!assets || !shouldServePrerenderedAsset({
    accept: getRequestHeader(event, "accept"),
    method: event.method,
    userAgent: getRequestHeader(event, "user-agent"),
    userAgents,
  })) return;

  const response = await assets.fetch(event.request);
  if (response.status !== 404) {
    const headers = new Headers(response.headers);
    headers.set("Vary", headers.get("Vary") ? `${headers.get("Vary")}, Accept` : "Accept");
    if (isTutorial) {
      headers.set("Cache-Control", "private, no-store");
      headers.append("Vary", "Cookie");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
});
