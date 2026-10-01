/**
 * Removed docs pages and the page that now owns their content.
 * Keep each entry: published package versions and external sites link to these URLs.
 * `/docs/reference/diagnostics` is also the `docsBase` of every package diagnostic catalog.
 */
export const docsPageRedirects = {
  "/docs/concepts/agent-invocations": "/docs/agents/invocations",
  "/docs/concepts/bash": "/docs/capabilities/workspace-shell",
  "/docs/concepts/capabilities-api": "/docs/capabilities",
  "/docs/concepts/channels-api": "/docs/agents/channels",
  "/docs/concepts/server-primitives-for-any-host": "/docs/server-primitives",
  "/docs/console/usage": "/docs/development/console",
  "/docs/agents/evlog": "/docs/agents/observability",
  "/docs/reference/channels": "/docs/server-primitives/channels",
  "/docs/reference/diagnostics": "/docs/reference/errors-diagnostics",
} as const satisfies Record<string, string>;

function rawMarkdownPath(path: string) {
  return `/raw${path}.md`;
}

/** Permanent redirects for each removed HTML page and its raw Markdown copy. */
export function createDocsRedirectRouteRules(redirects: Record<string, string> = docsPageRedirects) {
  const routeRules: Record<string, { redirect: { statusCode: 301, to: string } }> = {};

  for (const [from, to] of Object.entries(redirects)) {
    routeRules[from] = { redirect: { statusCode: 301, to } };
    routeRules[rawMarkdownPath(from)] = { redirect: { statusCode: 301, to: rawMarkdownPath(to) } };
  }

  return routeRules;
}
