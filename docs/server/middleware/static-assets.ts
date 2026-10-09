import { defineEventHandler, getRequestHeader } from "h3";

type CloudflareAssets = {
  fetch: (request: Request) => Promise<Response>;
};

type CloudflareContext = {
  env?: { ASSETS?: CloudflareAssets };
  request?: Request;
};

function acceptsMarkdown(accept: string | undefined) {
  if (!accept) return false;

  const entries = accept.toLowerCase().split(",").map((entry) => {
    const [type, ...parameters] = entry.trim().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="))?.trim().slice(2);
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
  return configured.some((value): value is string => typeof value === "string" && haystack.includes(value.toLowerCase()));
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
  const cloudflare = event.context.cloudflare as CloudflareContext | undefined;
  const assets = cloudflare?.env?.ASSETS;
  const config = useRuntimeConfig(event).agentDiscovery as { userAgents?: unknown } | undefined;
  if (!assets || !cloudflare.request || !shouldServePrerenderedAsset({
    accept: getRequestHeader(event, "accept"),
    method: event.method,
    userAgent: getRequestHeader(event, "user-agent"),
    userAgents: config?.userAgents,
  })) return;

  const response = await assets.fetch(cloudflare.request);
  if (response.status !== 404) return response;
});
