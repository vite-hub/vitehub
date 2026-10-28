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

const contentEditorTiptapPeers: Readonly<Record<string, OptionalPeerUsage>> = {
  "comark": "runtime",
  "comark-tiptap": "both",
  "@tiptap/core": "both",
  "@tiptap/extension-code-block": "runtime",
  "@tiptap/extension-image": "runtime",
  "@tiptap/extension-table": "runtime",
  "@tiptap/pm": "runtime",
  "@tiptap/starter-kit": "runtime",
}

const optionalPeerUsage = new Map<string, Readonly<Record<string, OptionalPeerUsage>>>([
  ["@vite-hub/agent", { "@vite-hub/workflow": "declaration" }],
  ["@vite-hub/agent/cli", { "vite": "both" }],
  ["@vite-hub/agent/observability", { "evlog": "both" }],
  ["@vite-hub/agent/observability/host", { "evlog": "both" }],
  ["@vite-hub/agent/observability/posthog", { "evlog": "both", "posthog-node": "both" }],
  ["@vite-hub/agent/eval", { "evalite": "both", "vitest": "both" }],
  ["@vite-hub/agent/runtime/workflow", { "@vite-hub/workflow": "declaration" }],
  ["@vite-hub/auth/agent", { "@vite-hub/agent": "both" }],
  ["@vite-hub/auth/nuxt", { "vite": "both" }],
  ["@vite-hub/browser/controllers/playwright", { "playwright-core": "declaration" }],
  ["@vite-hub/browser/internal/chromium", { "playwright-core": "declaration" }],
  ["@vite-hub/browser/internal/chromium.workerd", { "playwright-core": "declaration" }],
  ["@vite-hub/connections/agent", { "drizzle-orm": "both" }],
  ["@vite-hub/content/database", { "drizzle-orm": "both" }],
  // The editor renders through comark-tiptap, which imports these Tiptap packages. Content keeps all of them external.
  ["@vite-hub/content/editor", { ...contentEditorTiptapPeers, "@vite-hub/realtime": "declaration" }],
  // Realtime loads the editor, and the Realtime and Workspace runtimes that hold the live document.
  ["@vite-hub/content/realtime", { ...contentEditorTiptapPeers, "@vite-hub/realtime": "both", "@vite-hub/workspace": "runtime" }],
  ["@vite-hub/connections/server", { "drizzle-orm": "both" }],
  ["@vite-hub/env/cli", { "vite": "runtime" }],
  ["@vite-hub/env/database", { "drizzle-orm": "both" }],
  ["@vite-hub/kv/runtime/upstash-driver", { "@upstash/redis": "both" }],
  ["@vite-hub/source/client", { "vue": "both" }],
  ["@vite-hub/source/drizzle", { "drizzle-orm": "both" }],
  ["@vite-hub/ui/vite", { "@nuxt/ui": "both" }],
  ["@vite-hub/workspace/blob-database", { "drizzle-orm": "both" }],
  ["@vite-hub/workspace/nitro", { "vite": "declaration" }],
  ["@vite-hub/workflow/runtime/openworkflow", { "openworkflow": "declaration" }],
  ["@vite-hub/workflow/runtime/openworkflow-worker", { "openworkflow": "declaration" }],
  ["vite-hub", { "vite": "both" }],
  ["vite-hub/agent/observability", { "evlog": "both" }],
  ["vite-hub/agent/eval", { "evalite": "both", "vitest": "both" }],
  ["vite-hub/doctor", { "vite-doctor": "both" }],
  ["vite-hub/browser/controllers/playwright", { "playwright-core": "declaration" }],
  ["vite-hub/logs", { "evlog": "both" }],
  ["vite-hub/logs/memory", { "evlog": "declaration" }],
  ["vite-hub/nuxt", { "vite": "both" }],
  ["vite-hub/source/client", { "vue": "both" }],
  ["vite-hub/content", { "comark-content": "both" }],
  ["vite-hub/content/client", { "comark-content": "both" }],
  ["vite-hub/ui", { "vue": "both" }],
  ["vite-hub/ui/headless", { "vue": "both" }],
  ["vite-hub/ui/nuxt", { "vue": "declaration" }],
  // The Console renders its panels with @json-render/vue, which imports Vue.
  ["vite-hub/console/ui", { "vue": "both" }],
  ["vite-hub/ui/vite", { "@nuxt/ui": "both" }],
  ["vite-hub/workflow/runtime/openworkflow", { "openworkflow": "both" }],
  ["vite-hub/workflow/runtime/openworkflow-worker", { "openworkflow": "both" }],
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
  ["@vite-hub/database/runtime/postgres", { "postgres": "runtime" }],
  ["@vite-hub/kv/vite", { "vite": "declaration" }],
  ["@vite-hub/queue/vite", { "vite": "declaration" }],
  ["@vite-hub/realtime/vite", { "vite": "declaration" }],
  ["@vite-hub/sandbox/task/vite", { "vite": "declaration" }],
  ["@vite-hub/schedule/vite", { "vite": "both" }],
  ["@vite-hub/schedule/nuxt", { "vite": "both" }],
  ["@vite-hub/workflow/vite", { "vite": "both" }],
  ["@vite-hub/workspace/vite", { "vite": "declaration" }],
  ["@vite-hub/schedule/runtime/kv", { "@vite-hub/kv": "runtime" }],
])

function optionalPeersForExport(specifier: string, subpath: string) {
  const usage: Record<string, OptionalPeerUsage> = { ...optionalPeerUsage.get(specifier) }
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
  if (target.endsWith(".css") || target.endsWith(".json") || subpath === "./package.json" || subpath === "./tsconfig") {
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
