import { defineEventHandler, getRequestURL, sendRedirect } from "h3";

const canonicalOrigin = "https://vitehub.dev";

/**
 * Returns the canonical location for a duplicate page URL, or nothing when the URL is canonical.
 * `www.vitehub.dev` moves to the apex host, and a trailing slash is removed.
 */
export function getCanonicalRedirect(input: { method: string, url: URL }) {
  if (input.method !== "GET" && input.method !== "HEAD") return;

  const isWww = input.url.hostname === "www.vitehub.dev";
  const pathname = input.url.pathname.length > 1 ? input.url.pathname.replace(/\/+$/, "") : input.url.pathname;
  if (!isWww && pathname === input.url.pathname) return;

  const location = `${pathname || "/"}${input.url.search}`;
  return isWww ? `${canonicalOrigin}${location}` : location;
}

// Runs before `static-assets.ts`, so prerendered pages also redirect.
export default defineEventHandler((event) => {
  const location = getCanonicalRedirect({ method: event.method, url: getRequestURL(event) });
  if (location) return sendRedirect(event, location, 301);
});
