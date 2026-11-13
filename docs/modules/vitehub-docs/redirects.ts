/**
 * Removed docs pages and the page that now owns their content.
 * Keep each entry: published package versions and external sites link to these URLs.
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
  "chat-summary": "official",
  "custom-capabilities": "custom",
  "diagnostics": "diagnostics",
  "fetch": "fetch",
  "git": "git",
  "gmail": "gmail",
  "input-commands": "input-commands",
  "llm-gate": "official",
  "llm-route": "official",
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
  "/docs/ui/built-for-vue": "/docs/getting-started/built-for-vue",
  "/docs/frameworks-hosts/migrate-from-nuxthub": "/docs/getting-started/migrate-from-nuxthub",
  "/docs/getting-started/concepts/workspace-and-sources": "/docs/workspace/concepts",
  "/docs/getting-started/concepts/auth-users-and-agent-invokers": "/docs/agents/invokers",
  "/docs/getting-started/concepts/runtime-policy-approvals-and-traces": "/docs/agents/runtime-policy",
  "/docs/getting-started/concepts/runtime-context": "/docs/reference/runtime-context",
  "/docs/getting-started/concepts/runtime-helpers-and-stable-imports": "/docs/reference/runtime-helpers",
  "/docs/getting-started/concepts/definitions-and-discovery": "/docs/development/definition-discovery",
  "/docs/getting-started/concepts/vite-integrations-and-provider-output": "/docs/development/integrations-and-output",
}));

/** Diagnostic code pages that moved with their package to its own section. Published packages link to the old pages. */
const movedDiagnostics = {
  gateways: { from: "agents", codes: Array.from({ length: 12 }, (_, index) => `gateways_r${String(index + 1).padStart(4, "0")}`) },
  forge: {
    from: "agents",
    codes: [
      "forge_app_not_installed",
      "forge_request_failed",
      "forge_missing_env",
      "forge_invalid_env",
      "forge_missing_installation",
      "forge_not_app",
      "forge_r0001",
      "forge_r0002",
      "forge_r0003",
      "forge_r0004",
      "forge_r0005",
      "forge_r0006",
      "forge_r0007",
      "forge_r0009",
    ],
  },
  mcp: { from: "development", codes: ["mcp_b0001", "mcp_b0002"] },
} satisfies Record<string, { from: string, codes: string[] }>;

export const docsPageRedirects = {
  "/blog/agents": "/docs/getting-started/first-agent",
  "/blog/build-ai-chatbot": "/docs/agents/build-a-chat-app",
  "/blog/introducing-vitehub": "/docs/getting-started",
  "/blog/server-primitives": "/docs/getting-started/server-primitives",
  "/docs/agents/capabilities/chat-summary": "/docs/agents/capabilities/official",
  "/docs/agents/capabilities/code-host": "/docs/agents/capabilities/forge",
  "/docs/agents/capabilities/llm-gate": "/docs/agents/capabilities/official",
  "/docs/agents/capabilities/llm-route": "/docs/agents/capabilities/official",
  "/docs/agents/code-host-channels": "/docs/agents/forge-channels",
  "/docs/agents/actors": "/docs/agents/trusted-invokers",
  "/docs/agents/ai-gateways": "/docs/gateways",
  "/docs/agents/evlog": "/docs/agents/observability",
  "/docs/guides/forge": "/docs/forge/server-api",
  "/docs/ai-resources": "/docs/getting-started/ai-resources",
  "/docs/concepts": "/docs/getting-started/concepts",
  "/docs/capabilities": "/docs/agents/capabilities",
  "/docs/content/cms-preset": "/docs/cms",
  "/docs/concepts/agent-invocations": "/docs/agents/invocations",
  "/docs/concepts/bash": "/docs/workspace/agent-capability",
  "/docs/concepts/capabilities-api": "/docs/agents/capabilities",
  "/docs/concepts/channels-api": "/docs/agents/channels",
  "/docs/concepts/server-primitives-for-any-host": "/docs/getting-started/server-primitives",
  "/docs/console/usage": "/docs/development/console",
  "/docs/development/app-mcp": "/docs/mcp",
  "/docs/reference/channels": "/docs/channels",
  "/docs/reference/realtime": "/docs/realtime",
  "/docs/server-primitives": "/docs/getting-started/server-primitives",
  "/docs/agents/box-tutorial": "/docs/agents/sandbox-tutorial",
  "/docs/agents/boxes": "/docs/agents/sandboxes",
  "/docs/reference/github-inbox-waits": "/docs/agents/babysitter",
  "/docs/schedule/agent-capability": "/docs/schedule",

  "/docs/server-primitives/env-bridge": "/docs/env/bridge",
  "/docs/ui/chat-prompt": "/docs/ui/prompt-input",
  "/docs/ui/session": "/docs/ui/chat-session",
  // The Agent Invocation views moved from @vite-hub/ui into the Console.
  ...Object.fromEntries(["capability-inspector", "invocation", "invocation-inspector", "invocation-list", "timeline", "blocks/invocation-dashboard"].map(page => [`/docs/ui/${page}`, "/docs/development/console"])),
  ...Object.fromEntries(movedServerPrimitives.map(id => [`/docs/server-primitives/${id}`, `/docs/${id}`])),
  ...Object.fromEntries(Object.entries(primitiveCapabilities).map(([id, section]) => [`/docs/capabilities/${id}`, id === "schedule" ? "/docs/schedule" : `/docs/${section}/agent-capability`])),
  ...Object.fromEntries(Object.entries(agentCapabilities).map(([id, page]) => [`/docs/capabilities/${id}`, `/docs/agents/capabilities/${page}`])),
  ...Object.fromEntries(Object.entries(startGroups).flatMap(([dir, pages]) => pages.map(page => [`/docs/${dir}/${page}`, movedLearningPages.get(`/docs/getting-started/${dir}/${page}`) || `/docs/getting-started/${dir}/${page}`]))),
  ...Object.fromEntries(movedLearningPages),
  ...Object.fromEntries(Object.entries(movedDiagnostics).flatMap(([section, { from, codes }]) => codes.map(code => [`/docs/${from}/diagnostics/${code}`, `/docs/${section}/diagnostics/${code}`]))),
} satisfies Record<string, string>;

/**
 * Fragments that moved with the Blob page split, with the CMS move to its own section, and with the moves of packages to their own sections.
 * The old page redirect keeps the hash, so `/docs/content/cms-preset#github-store` lands on `/docs/cms#github-store`.
 */
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
  "/docs/gateways": {
    install: "/docs/gateways/get-started#install-the-packages",
    "use-a-model-with-the-ai-sdk": "/docs/gateways/server-api#use-a-model-with-the-ai-sdk",
    "ask-your-first-question": "/docs/gateways/get-started#ask-your-first-question",
    "ask-with-any-model": "/docs/gateways/server-api#ask-with-any-model",
    presets: "/docs/gateways/configure#presets",
    credentials: "/docs/gateways/configure#credentials",
    "use-with-agents": "/docs/gateways/agents#route-provider-drivers",
    "cloudflare-ai-gateway": "/docs/gateways/configure#cloudflare-ai-gateway",
    "typesafe-through-cloudflare-ai-gateway": "/docs/gateways/configure#typesafe-through-cloudflare-ai-gateway",
    "custom-gateways": "/docs/gateways/server-api#custom-gateways",
    errors: "/docs/gateways/limits-and-errors#errors",
  },
  "/docs/forge/server-api": {
    install: "/docs/forge/get-started#install-forge",
    "set-the-env": "/docs/forge/configure#set-the-env",
    errors: "/docs/forge/limits-and-errors#errors",
    "runtime-errors": "/docs/forge/limits-and-errors#runtime-errors",
    "configuration-errors": "/docs/forge/limits-and-errors#configuration-errors",
    forge_app_not_installed: "/docs/forge/limits-and-errors",
    forge_request_failed: "/docs/forge/limits-and-errors",
    forge_missing_env: "/docs/forge/limits-and-errors",
    forge_invalid_env: "/docs/forge/limits-and-errors",
    forge_missing_installation: "/docs/forge/limits-and-errors",
    forge_not_app: "/docs/forge/limits-and-errors",
  },
  "/docs/mcp": {
    "turn-it-on": "/docs/mcp/get-started#turn-it-on",
    "write-a-tool": "/docs/mcp/get-started#write-a-tool",
    "sign-in-with-mcp-oauth": "/docs/mcp/configure#sign-in-with-mcp-oauth",
    "connect-an-agent": "/docs/mcp/get-started#connect-an-agent",
    "inspect-the-tools": "/docs/mcp/get-started#inspect-the-tools",
  },
  "/docs/cms": {
    "set-up": "/docs/cms/get-started#install-and-turn-on-vitehub",
    "define-the-collections": "/docs/cms/get-started",
    "create-the-tables-and-resources": "/docs/cms/get-started#create-the-tables",
    "what-the-preset-adds": "/docs/cms/configure",
    options: "/docs/cms/configure",
    "github-store": "/docs/cms/configure",
    "what-is-stored-where": "/docs/cms/configure",
    "commit-mode": "/docs/cms/configure",
    "pull-request-mode": "/docs/cms/configure",
    "take-over-the-database": "/docs/cms/configure",
    "migrate-from-manual-wiring": "/docs/cms/configure",
    hosts: "/docs/cms/hosts",
    limits: "/docs/cms/limits-and-errors",
    errors: "/docs/cms/limits-and-errors",
  },
} satisfies Record<string, Record<string, string>>;

function rawMarkdownPath(path: string) {
  return `/raw${path}.md`;
}

/** Permanent redirects for each removed HTML page, its trailing-slash form, and its raw Markdown copy. */
export function createDocsRedirectRouteRules(redirects: Record<string, string> = docsPageRedirects) {
  const routeRules: Record<string, { redirect: { status: 301, to: string } }> = {};

  for (const [from, to] of Object.entries(redirects)) {
    routeRules[from] = { redirect: { status: 301, to } };
    routeRules[`${from}/`] = { redirect: { status: 301, to } };
    routeRules[rawMarkdownPath(from)] = { redirect: { status: 301, to: rawMarkdownPath(to) } };
  }

  for (const [from, to] of Object.entries({
    "/databases": "/database",
    "/rate-limits": "/rate-limit",
    "/blog": "/learn",
    "/guides": "/learn",
  })) {
    routeRules[from] = { redirect: { status: 301, to } };
    routeRules[`${from}/`] = { redirect: { status: 301, to } };
  }

  return routeRules;
}
