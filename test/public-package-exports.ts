import { packageInfos, readPackageManifest } from "./utils/repo"

export type PublicPackageExportKind
  = | "cli"
    | "framework-hook"
    | "node-import"
    | "provider-specific"
    | "static-asset"

export interface PublicPackageExportContract {
  kind: PublicPackageExportKind
  optionalDeclarationPeers: readonly string[]
  optionalRuntimePeers: readonly string[]
  packageName: string
  specifier: string
  subpath: string
  target: string
}

export interface PublicPackageBinContract {
  binName: string
  packageName: string
  target: string
}

type OptionalPeerUsage = "both" | "declaration" | "runtime"

const optionalPeerUsage = new Map<string, Readonly<Record<string, OptionalPeerUsage>>>([
  ["@vite-hub/agent", { "@vite-hub/workflow": "declaration" }],
  ["@vite-hub/agent/cli", { "vite": "both" }],
  ["@vite-hub/agent/observability", { "evlog": "both" }],
  ["@vite-hub/agent/observability/host", { "evlog": "both" }],
  ["@vite-hub/agent/observability/posthog", { "evlog": "both", "posthog-node": "both" }],
  ["@vite-hub/agent/eval", { "evalite": "both", "vitest": "both" }],
  // `getAgentInvocationsDatabase()` returns Drizzle types and loads drizzle-orm when it is called.
  ["@vite-hub/agent/invocations/drizzle", { "drizzle-orm": "both" }],
  ["@vite-hub/agent/invocations/database", { "@vite-hub/database": "both", "drizzle-orm": "both" }],
  ["@vite-hub/auth/agent", { "@vite-hub/agent": "both" }],
  ["@vite-hub/auth/mcp", { "@better-auth/oauth-provider": "both" }],
  ["@vite-hub/auth/nuxt", { "vite": "both" }],
  ["@vite-hub/browser/controllers/playwright", { "playwright-core": "declaration" }],
  ["@vite-hub/comments/vite", { "vite": "both" }],
  ["@vite-hub/cms/access", { "@vite-hub/comments": "declaration", "better-auth": "both" }],
  ["@vite-hub/connections/agent", { "drizzle-orm": "both" }],
  ["@vite-hub/content/database", { "drizzle-orm": "both" }],
  // The assistant preset is an Agent Definition on the ChatGPT gateway.
  ["@vite-hub/docs/assistant", { "@vite-hub/agent": "both", "@vite-hub/gateways": "runtime" }],
  // Content owns its parser and Tiptap dependencies; only optional ViteHub integrations remain peers.
  ["@vite-hub/content/editor", { "@vite-hub/realtime": "declaration" }],
  // Realtime loads the editor, and the Realtime and Workspace runtimes that hold the live document.
  ["@vite-hub/content/realtime", { "@vite-hub/realtime": "both", "@vite-hub/workspace": "runtime" }],
  ["@vite-hub/connections/server", { "drizzle-orm": "both" }],
  ["@vite-hub/env/cli", { "vite": "runtime" }],
  ["@vite-hub/env/database", { "drizzle-orm": "both" }],
  ["@vite-hub/forms/vue", { "@formisch/vue": "both" }],
  ["@vite-hub/gateways/ai-sdk", { "@ai-sdk/provider": "declaration" }],
  // The Nuxt module loads @nuxt/kit. Its declarations do not import it.
  ["@vite-hub/kit/nuxt", { "@nuxt/kit": "runtime" }],
  ["@vite-hub/kv/runtime/upstash-driver", { "@upstash/redis": "both" }],
  ["@vite-hub/source/client", { "vue": "both" }],
  ["@vite-hub/source/drizzle", { "drizzle-orm": "both" }],
  ["@vite-hub/source/mcp", { "@modelcontextprotocol/sdk": "runtime" }],
  ["@vite-hub/ui/markdown-editor", {
    "@nuxt/ui": "both",
    "@tiptap/core": "both",
    "@tiptap/extension-image": "both",
    "@tiptap/extension-list": "both",
    "@tiptap/extension-table": "both",
    "@tiptap/pm": "both",
    "@tiptap/starter-kit": "both",
    "@tiptap/vue-3": "both",
  }],
  ["@vite-hub/ui/vite", { "@nuxt/ui": "both" }],
  ["@vite-hub/workspace/blob-database", { "drizzle-orm": "both" }],
  ["@vite-hub/workflow/runtime/openworkflow", { "openworkflow": "declaration" }],
  ["@vite-hub/workflow/openworkflow", { "openworkflow": "declaration" }],
  ["vite-hub", { "vite": "both" }],
  ["vite-hub/agent/invocations/drizzle", { "drizzle-orm": "both" }],
  ["vite-hub/connections/server", { "drizzle-orm": "both" }],
  ["vite-hub/agent/invocations/database", { "@vite-hub/database": "both", "drizzle-orm": "both" }],
  ["vite-hub/agent/observability", { "evlog": "both" }],
  ["vite-hub/auth/mcp", { "@better-auth/oauth-provider": "both" }],
  // The Console keeps the Agent journal in libSQL.
  ["vite-hub/console/server", { "@libsql/client": "both", "@vite-hub/agent": "both", "drizzle-orm": "both" }],
  ["vite-hub/doctor", { "vite-doctor": "both" }],
  ["vite-hub/env/database", { "drizzle-orm": "both" }],
  ["vite-hub/browser/controllers/playwright", { "playwright-core": "declaration" }],
  ["vite-hub/gateways/ai-sdk", { "@ai-sdk/provider": "declaration" }],
  ["vite-hub/logs", { "evlog": "declaration" }],
  ["vite-hub/logs/memory", { "evlog": "declaration" }],
  ["vite-hub/nuxt", { "vite": "both" }],
  ["vite-hub/source/client", { "vue": "both" }],
  ["vite-hub/source/drizzle", { "drizzle-orm": "both" }],
  ["vite-hub/source/mcp", { "@modelcontextprotocol/sdk": "runtime" }],
  ["vite-hub/ui", { "vue": "both" }],
  ["vite-hub/ui/headless", { "vue": "both" }],
  ["vite-hub/console/ui", {
    "@json-render/core": "declaration",
    "@json-render/vue": "runtime",
    "@vite-hub/ui": "both",
    "@vueuse/core": "runtime",
    "vue": "both",
  }],
  ["vite-hub/ui/vite", { "@nuxt/ui": "both" }],
  ["vite-hub/workflow/runtime/openworkflow", { "openworkflow": "both" }],
  ["vite-hub/workflow/openworkflow", { "openworkflow": "declaration" }],
  ["@vite-hub/agent/vite", { "vite": "both" }],
  ["@vite-hub/auth/vite", { "vite": "both" }],
  ["@vite-hub/blob/vite", { "vite": "declaration" }],
  ["@vite-hub/browser/vite", { "vite": "declaration" }],
  // The plugin executes Vite at runtime and its public declarations import
  // Vite types, so both contract paths must be exercised with the peer.
  ["@vite-hub/channels/vite", { "vite": "both" }],
  ["@vite-hub/connections/vite", { "vite": "declaration" }],
  // These entries parse modules with Vite's oxc parser through the shared
  // build scanner (`@vite-hub/internal/build/scan-module`), so they import
  // Vite at runtime as well as in their declarations.
  ["@vite-hub/database/vite", { "vite": "both" }],
  ["@vite-hub/database/nuxt", { "vite": "both" }],
  // The config entry reaches Vite through the shared build helpers at runtime.
  ["@vite-hub/database/config", { "vite": "runtime" }],
  ["@vite-hub/kv/vite", { "vite": "declaration" }],
  ["@vite-hub/queue/vite", { "vite": "declaration" }],
  ["@vite-hub/queue/runtime/hosted", { "@vercel/functions": "runtime" }],
  ["@vite-hub/realtime/vite", { "vite": "declaration" }],
  ["@vite-hub/sandbox/task/vite", { "vite": "declaration" }],
  ["@vite-hub/schedule/vite", { "vite": "both" }],
  ["@vite-hub/workflow/vite", { "vite": "both" }],
  ["@vite-hub/workspace/vite", { "vite": "declaration" }],
  ["@vite-hub/schedule/runtime/kv", { "@vite-hub/kv": "runtime" }],
])

// `vite-hub` declares the owner packages of opt-in features as optional peers. Its subpaths of such a feature, such as
// `vite-hub/agent`, need the owner package.
const optionalFrameworkOwners = new Set(["agent", "auth", "cms", "comments", "content", "database", "docs", "forge", "forms", "i18n", "mcp", "presets", "realtime", "schedule", "shell", "ui", "web-container", "workspace"])

function optionalPeersForExport(specifier: string, subpath: string) {
  const usage: Record<string, OptionalPeerUsage> = { ...optionalPeerUsage.get(specifier) }
  const feature = subpath.replace(/^\.\//, "").split("/")[0]
  if (specifier.startsWith("vite-hub/") && feature && optionalFrameworkOwners.has(feature)) usage[`@vite-hub/${feature}`] ??= "both"
  if (/(?:^|\/)vite$/.test(subpath)) usage.vite ??= "both"
  if (/(?:^|\/)vue$/.test(subpath)) usage.vue ??= "both"
  if (specifier === "vite-hub/ui" || specifier.startsWith("vite-hub/ui/")) usage.vue ??= "both"
  const entries = Object.entries(usage)
  return {
    optionalDeclarationPeers: entries.filter(([, mode]) => mode !== "runtime").map(([peer]) => peer),
    optionalRuntimePeers: entries.filter(([, mode]) => mode !== "declaration").map(([peer]) => peer),
  }
}

function exportTarget(rawTarget: NonNullable<ReturnType<typeof readPackageManifest>["exports"]>[string]) {
  if (typeof rawTarget === "string") return rawTarget
  const target = rawTarget.import || rawTarget.default || rawTarget.types
  return typeof target === "string" ? target : target?.import || target?.default || target?.node
}

function exportSpecifier(packageName: string, subpath: string) {
  return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`
}

function exportKind(packageName: string, subpath: string, specifier: string, target: string): PublicPackageExportKind {
  // A `.iife.js` target is a classic script that pages embed as text; it has no module exports or declarations.
  if (target.endsWith(".css") || target.endsWith(".json") || target.endsWith(".iife.js") || subpath === "./package.json" || subpath === "./tsconfig") {
    return "static-asset"
  }
  if (packageName === "@vite-hub/cli" && subpath === ".") return "cli"
  if (/(?:^|\/)(?:cloudflare|vercel|netlify|upstash|drivers?|providers?|hosted)(?:\/|-|$)/.test(subpath)) {
    return "provider-specific"
  }
  if (/(?:^|\/)(?:nuxt|vite|vue)$/.test(subpath)) return "framework-hook"
  return "node-import"
}

export const publicPackageExportContracts: readonly PublicPackageExportContract[] = packageInfos.flatMap((info) => {
  const manifest = readPackageManifest(info.name)
  return Object.entries(manifest.exports || {}).map(([subpath, rawTarget]) => {
    const target = exportTarget(rawTarget)
    if (!target) throw new Error(`${info.packageName} ${subpath} has no import, default, or types target`)
    const specifier = exportSpecifier(info.packageName, subpath)
    const optionalPeers = optionalPeersForExport(specifier, subpath)
    return {
      kind: exportKind(info.packageName, subpath, specifier, target),
      ...optionalPeers,
      packageName: info.packageName,
      specifier,
      subpath,
      target,
    }
  })
})

export const publicPackageBinContracts: readonly PublicPackageBinContract[] = packageInfos.flatMap((info) => {
  const manifest = readPackageManifest(info.name)
  return Object.entries(manifest.bin || {}).map(([binName, target]) => ({
    binName,
    packageName: info.packageName,
    target,
  }))
})
