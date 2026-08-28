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

const optionalPeerExports = new Map<string, readonly string[]>([
  ["@vite-hub/agent", ["@vite-hub/workflow"]],
  ["@vite-hub/agent/eval", ["evalite", "vitest"]],
  ["@vite-hub/agent/runtime/workflow", ["@vite-hub/workflow"]],
  ["@vite-hub/auth/agent", ["@vite-hub/agent"]],
  ["@vite-hub/auth/nuxt", ["vite"]],
  ["@vite-hub/browser/controllers/playwright", ["playwright-core"]],
  ["@vite-hub/kv/runtime/upstash-driver", ["@upstash/redis"]],
  ["@vite-hub/source/client", ["vue"]],
  ["@vite-hub/source/content", ["comark-content"]],
  ["@vite-hub/source/content/client", ["comark-content"]],
  ["@vite-hub/ui/vite", ["@nuxt/ui"]],
  ["@vite-hub/workspace/collections/client", ["vue"]],
  ["@vite-hub/workflow/runtime/openworkflow", ["openworkflow"]],
  ["@vite-hub/workflow/runtime/openworkflow-worker", ["openworkflow"]],
  ["vite-hub", ["vite"]],
  ["vite-hub/agent/eval", ["evalite", "vitest"]],
  ["vite-hub/browser/controllers/playwright", ["playwright-core"]],
  ["vite-hub/nuxt", ["vite"]],
  ["vite-hub/source/client", ["vue"]],
  ["vite-hub/source/content", ["comark-content"]],
  ["vite-hub/source/content/client", ["comark-content"]],
  ["vite-hub/ui", ["vue"]],
  ["vite-hub/ui/headless", ["vue"]],
  ["vite-hub/ui/nuxt", ["vue"]],
  ["vite-hub/ui/vite", ["@nuxt/ui"]],
  ["vite-hub/workspace/collections/client", ["vue"]],
  ["vite-hub/workflow/runtime/openworkflow", ["openworkflow"]],
  ["vite-hub/workflow/runtime/openworkflow-worker", ["openworkflow"]],
])

const declarationOnlyPeerExports = new Map<string, readonly string[]>([
  ["@vite-hub/agent", ["@vite-hub/workflow"]],
  ["@vite-hub/agent/runtime/workflow", ["@vite-hub/workflow"]],
  ["@vite-hub/auth/vite", ["vite"]],
  ["@vite-hub/browser/controllers/playwright", ["playwright-core"]],
  ["@vite-hub/workflow/runtime/openworkflow", ["openworkflow"]],
  ["@vite-hub/workflow/runtime/openworkflow-worker", ["openworkflow"]],
  ["vite-hub/browser/controllers/playwright", ["playwright-core"]],
  ["vite-hub/ui/nuxt", ["vue"]],
])

function optionalDeclarationPeersForExport(specifier: string, subpath: string) {
  const peers = [...(optionalPeerExports.get(specifier) || [])]
  if (/(?:^|\/)vite$/.test(subpath)) peers.push("vite")
  if (/(?:^|\/)vue$/.test(subpath)) peers.push("vue")
  return peers
}

function exportTarget(rawTarget: string | Record<string, string>) {
  if (rawTarget instanceof Object) return rawTarget.import || rawTarget.default || rawTarget.types
  return rawTarget
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
    const optionalDeclarationPeers = optionalDeclarationPeersForExport(specifier, subpath)
    const declarationOnlyPeers = new Set(declarationOnlyPeerExports.get(specifier) || [])
    return {
      kind: exportKind(info.packageName, subpath, specifier, target),
      optionalDeclarationPeers,
      optionalRuntimePeers: optionalDeclarationPeers.filter(peer => !declarationOnlyPeers.has(peer)),
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
