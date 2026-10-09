/**
 * Removed docs pages and the page that now owns their content.
 * Keep each entry: published package versions and external sites link to these URLs.
 * `/docs/reference/diagnostics` is also the `docsBase` of every package diagnostic catalog.
 */

/** Server Primitive pages that moved from `/docs/server-primitives/<id>` to their own product section. */
const movedServerPrimitives = [
  "auth",
  "blob",
  "browser",
  "channels",
  "connections",
  "content",
  "database",
  "email",
  "env",
  "kv",
  "queue",
  "rate-limit",
  "sandbox",
  "schedule",
  "shell",
  "source",
  "workflows",
  "workspace",
  "realtime",
];

/** Capability pages that now live inside the product section of the primitive they expose. */
const primitiveCapabilities = {
  "blob": "blob",
  "browser": "browser",
  "channel-delivery": "channels",
  "db": "database",
  "email": "email",
  "kv": "kv",
  "rate-limit": "rate-limit",
  "sandbox": "sandbox",
  "schedule": "schedule",
  "workspace-shell": "workspace",
} satisfies Record<string, string>;

/** Concept and AI resource pages that moved into the Start section as groups. */
const startGroups = {
  "ai-resources": ["agent-instructions-skills", "markdown-pages", "mcp-server"],
  "concepts": [
    "auth-users-and-agent-invokers",
    "definitions-and-discovery",
    "runtime-context",
    "runtime-helpers-and-stable-imports",
    "runtime-policy-approvals-and-traces",
    "vite-integrations-and-provider-output",
    "workspace-and-sources",
  ],
} satisfies Record<string, string[]>;

/** Capability pages that have no primitive and moved under the Agents section. */
const agentCapabilities = {
  "access": "access",
  "chat": "chat",
  "chat-summary": "chat-summary",
  "custom-capabilities": "custom",
  "diagnostics": "diagnostics",
  "fetch": "fetch",
  "git": "git",
  "gmail": "gmail",
  "input-commands": "input-commands",
  "llm-gate": "llm-gate",
  "llm-route": "llm-route",
  "mcp": "mcp",
  "memory": "memory",
  "official-capabilities": "official",
  "openapi": "openapi",
  "otlp": "otlp",
  "papercuts": "papercuts",
  "progress-summary": "progress-summary",
  "skills": "skills",
  "title": "title",
  "transcribe": "transcribe",
  "usage": "usage",
  "web-search": "web-search",
} satisfies Record<string, string>;

const movedLearningPages = new Map(Object.entries({
  "/docs/getting-started/built-for-vue": "/docs/ui/built-for-vue",
  "/docs/frameworks-hosts/migrate-from-nuxthub": "/docs/getting-started/migrate-from-nuxthub",
  "/docs/getting-started/concepts/workspace-and-sources": "/docs/workspace/concepts",
  "/docs/getting-started/concepts/auth-users-and-agent-invokers": "/docs/agents/invokers",
  "/docs/getting-started/concepts/runtime-policy-approvals-and-traces": "/docs/agents/runtime-policy",
  "/docs/getting-started/concepts/runtime-context": "/docs/reference/runtime-context",
  "/docs/getting-started/concepts/runtime-helpers-and-stable-imports": "/docs/reference/runtime-helpers",
  "/docs/getting-started/concepts/definitions-and-discovery": "/docs/development/definition-discovery",
  "/docs/getting-started/concepts/vite-integrations-and-provider-output": "/docs/development/integrations-and-output",
}));

export const docsPageRedirects = {
  "/blog/agents": "/docs/getting-started/first-agent",
  "/blog/server-primitives": "/docs/getting-started/server-primitives",
  "/docs/agents/evlog": "/docs/agents/observability",
  "/docs/ai-resources": "/docs/getting-started/ai-resources",
  "/docs/concepts": "/docs/getting-started/concepts",
  "/docs/capabilities": "/docs/agents/capabilities",
  "/docs/concepts/agent-invocations": "/docs/agents/invocations",
  "/docs/concepts/bash": "/docs/workspace/agent-capability",
  "/docs/concepts/capabilities-api": "/docs/agents/capabilities",
  "/docs/concepts/channels-api": "/docs/agents/channels",
  "/docs/concepts/server-primitives-for-any-host": "/docs/getting-started/server-primitives",
  "/docs/console/usage": "/docs/development/console",
  "/docs/reference/channels": "/docs/channels",
  "/docs/reference/diagnostics": "/docs/reference/errors-diagnostics",
  "/docs/reference/realtime": "/docs/realtime",
  "/docs/server-primitives": "/docs/getting-started/server-primitives",
  "/docs/server-primitives/env-bridge": "/docs/env/bridge",
  ...Object.fromEntries(movedServerPrimitives.map(id => [`/docs/server-primitives/${id}`, `/docs/${id}`])),
  ...Object.fromEntries(Object.entries(primitiveCapabilities).map(([id, section]) => [`/docs/capabilities/${id}`, `/docs/${section}/agent-capability`])),
  ...Object.fromEntries(Object.entries(agentCapabilities).map(([id, page]) => [`/docs/capabilities/${id}`, `/docs/agents/capabilities/${page}`])),
  ...Object.fromEntries(Object.entries(startGroups).flatMap(([dir, pages]) => pages.map(page => [`/docs/${dir}/${page}`, movedLearningPages.get(`/docs/getting-started/${dir}/${page}`) || `/docs/getting-started/${dir}/${page}`]))),
  ...Object.fromEntries(movedLearningPages),
} satisfies Record<string, string>;

/** Fragments that moved with the Blob page split. The old overview redirect keeps the hash. */
export const docsLegacyFragmentRedirects = {
  "/docs/blob": {
    "quick-start": "/docs/blob/get-started",
    install: "/docs/blob/get-started",
    configure: "/docs/blob/get-started",
    "start-using-it": "/docs/blob/get-started",
    "public-imports": "/docs/blob/server-api",
    "store-configuration": "/docs/blob/configure",
    "protect-served-objects": "/docs/blob/configure",
    "provider-options": "/docs/blob/configure",
    "local-filesystem": "/docs/blob/configure",
    "cloudflare-r2": "/docs/blob/configure",
    "vercel-blob": "/docs/blob/configure",
    "netlify-blobs": "/docs/blob/configure",
    "s3-and-s3-compatible-providers": "/docs/blob/configure",
    "google-cloud-storage": "/docs/blob/configure",
    "azure-blob-storage": "/docs/blob/configure",
    "supabase-storage": "/docs/blob/configure",
    uploadthing: "/docs/blob/configure",
    "google-drive": "/docs/blob/configure",
    onedrive: "/docs/blob/configure",
    dropbox: "/docs/blob/configure",
    box: "/docs/blob/configure",
    "use-it-at-runtime": "/docs/blob/server-api",
    "serve-blob-backed-assets": "/docs/blob/configure",
    "runtime-helper": "/docs/blob/server-api",
    "write-options": "/docs/blob/server-api",
    "upload-files": "/docs/blob/server-api",
    "multipart-uploads": "/docs/blob/server-api",
    "signed-requests": "/docs/blob/server-api",
    "ensureblob-blob-options": "/docs/blob/server-api",
    "provider-output": "/docs/blob/hosts",
    "read-and-write-blobs-during-development": "/docs/blob/hosts",
    "production-checks": "/docs/blob/server-api",
    "cloudflare-r2-bucket": "/docs/blob/hosts",
    "s3-compatible-object-storage": "/docs/blob/hosts",
    "minio-object-storage": "/docs/blob/hosts",
    "connect-blob-to-agents": "/docs/blob/agent-capability",
    "next-steps": "/docs/blob",
  },
} satisfies Record<string, Record<string, string>>;

function rawMarkdownPath(path: string) {
  return `/raw${path}.md`;
}

/** Permanent redirects for each removed HTML page, its trailing-slash form, and its raw Markdown copy. */
export function createDocsRedirectRouteRules(redirects: Record<string, string> = docsPageRedirects) {
  const routeRules: Record<string, { redirect: { statusCode: 301, to: string } }> = {};

  for (const [from, to] of Object.entries(redirects)) {
    routeRules[from] = { redirect: { statusCode: 301, to } };
    routeRules[`${from}/`] = { redirect: { statusCode: 301, to } };
    routeRules[rawMarkdownPath(from)] = { redirect: { statusCode: 301, to: rawMarkdownPath(to) } };
  }

  for (const [from, to] of Object.entries({ "/databases": "/database", "/rate-limits": "/rate-limit", "/blog": "/guides" })) {
    routeRules[from] = { redirect: { statusCode: 301, to } };
    routeRules[`${from}/`] = { redirect: { statusCode: 301, to } };
  }

  return routeRules;
}
