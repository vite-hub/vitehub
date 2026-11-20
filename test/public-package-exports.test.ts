import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { parse } from "valibot"

import { publicPackageBinContracts, publicPackageExportContracts } from "./public-package-exports"
import { listWorkspacePackageInfos } from "../packages/internal/src/workspace-inventory.ts"
import { packageDir, packageInfos, packageManifestSchema, readPackageManifest, repoRoot, toRepoPath, walkFiles } from "./utils/repo"

describe("public package export contracts", () => {
  it("limits the OAuth Provider peer to the MCP Auth subpaths", () => {
    for (const specifier of ["@vite-hub/auth/mcp", "vite-hub/auth/mcp"]) {
      const contract = publicPackageExportContracts.find(entry => entry.specifier === specifier)
      expect(contract?.optionalRuntimePeers).toContain("@better-auth/oauth-provider")
      expect(contract?.optionalDeclarationPeers).toContain("@better-auth/oauth-provider")
    }
    for (const specifier of ["@vite-hub/auth", "@vite-hub/auth/server", "vite-hub/auth", "vite-hub/auth/server"]) {
      const contract = publicPackageExportContracts.find(entry => entry.specifier === specifier)
      expect(contract?.optionalRuntimePeers).not.toContain("@better-auth/oauth-provider")
      expect(contract?.optionalDeclarationPeers).not.toContain("@better-auth/oauth-provider")
    }
  })

  it("keeps Source handler declarations independent from H3", () => {
    const server = readFileSync(join(packageDir("source"), "src/server.ts"), "utf8")
    const content = readFileSync(join(packageDir("content"), "src/index.ts"), "utf8")

    expect(server).toContain("): CollectionHandler")
    expect(content).toContain("): ContentHandler")
    expect(server).toContain("fetch(request: Request): Promise<Response>")
    expect(content).toContain("fetch(request: Request): Promise<Response>")
    expect(server).not.toContain('from "h3"')
    expect(server).not.toContain("): ReturnType<typeof defineEventHandler>")
    expect(content).not.toContain("): ReturnType<typeof defineEventHandler>")
    expect(content).not.toContain('from "h3"')
  })

  it("publishes exactly the checked-in subpaths of each package", () => {
    for (const info of packageInfos) {
      const path = `packages/${info.name}/package.json`
      const subpaths = Object.keys(readPackageManifest(info.name).exports || {})
      const checkedIn = parse(packageManifestSchema, JSON.parse(execFileSync("git", ["show", `:${path}`], { cwd: repoRoot, encoding: "utf8" })))
      expect(subpaths, `the build rewrote the exports of ${path}`).toEqual(Object.keys(checkedIn.exports || {}))
      expect(subpaths.filter(subpath => subpath.includes("*")), `${path} exports a wildcard`).toEqual([])
      expect(subpaths.filter(subpath => /(?:^|\/)_internal(?:\/|$)/.test(subpath)), `${path} exports an _internal subpath`).toEqual([])
    }
    expect(Object.keys(readPackageManifest("vite-hub").exports || {}).filter(subpath => /^\.\/internal(?:\/|$)/.test(subpath))).toEqual([])
  })

  it("classifies every public root and subpath exactly once", () => {
    const expected = packageInfos.flatMap((info) => {
      const manifest = readPackageManifest(info.name)
      return Object.keys(manifest.exports || {}).map(subpath => `${info.packageName}:${subpath}`)
    }).sort()
    const actual = publicPackageExportContracts
      .map(contract => `${contract.packageName}:${contract.subpath}`)
      .sort()

    expect(new Set(actual).size).toBe(actual.length)
    expect(actual).toEqual(expected)
    expect(new Set(publicPackageExportContracts.map(contract => contract.kind))).toEqual(new Set([
      "cli",
      "framework-hook",
      "node-import",
      "provider-specific",
      "static-asset",
    ]))
  })

  it("marks eager exports as optional-peer consumers", () => {
    const eagerPeerExports = new Map<string, string>([
      ["@vite-hub/agent/observability/host", "evlog"],
      ["@vite-hub/agent/observability/posthog", "posthog-node"],
      ["@vite-hub/auth/agent", "@vite-hub/agent"],
      ["@vite-hub/auth/nuxt", "vite"],
      ["@vite-hub/database/nuxt", "vite"],
      ["@vite-hub/database/vite", "vite"],
      ["@vite-hub/schedule/runtime/kv", "@vite-hub/kv"],
      ["@vite-hub/schedule/vite", "vite"],
      ["@vite-hub/source/client", "vue"],
      ["@vite-hub/source/mcp", "@modelcontextprotocol/sdk"],
      ["@vite-hub/ui/vite", "vite"],
      ["@vite-hub/workflow/vite", "vite"],
      ["vite-hub", "vite"],
      ["vite-hub/console/ui", "vue"],
      ["vite-hub/forge", "@vite-hub/forge"],
      ["vite-hub/i18n", "@vite-hub/i18n"],
      ["vite-hub/i18n/runtime", "@vite-hub/i18n"],
      ["vite-hub/i18n/server", "@vite-hub/i18n"],
      ["vite-hub/i18n/vue", "@vite-hub/i18n"],
      ["vite-hub/nuxt", "vite"],
      ["vite-hub/source/client", "vue"],
      ["vite-hub/source/mcp", "@modelcontextprotocol/sdk"],
      ["vite-hub/ui", "vue"],
      ["vite-hub/ui/headless", "vue"],
      ["vite-hub/ui/vite", "vite"],
    ])

    for (const [specifier, peer] of eagerPeerExports) {
      expect(publicPackageExportContracts.find(contract => contract.specifier === specifier)?.optionalRuntimePeers)
        .toContain(peer)
    }
  })

  it("keeps Comments database peers required and classifies its optional Vite peer", () => {
    const manifest = readPackageManifest("comments")
    expect(manifest.dependencies?.["drizzle-orm"]).toBeUndefined()
    expect(manifest.peerDependencies?.["drizzle-orm"]).toEqual(expect.any(String))
    expect(manifest.peerDependenciesMeta?.["drizzle-orm"]?.optional).not.toBe(true)
    expect(manifest.peerDependencies?.["@vite-hub/database"]).toEqual(expect.any(String))
    expect(manifest.peerDependenciesMeta?.["@vite-hub/database"]?.optional).not.toBe(true)
    for (const subpath of ["database", "database/postgres", "server"]) {
      const contract = publicPackageExportContracts.find(contract => contract.specifier === `@vite-hub/comments/${subpath}`)
      expect(contract?.optionalRuntimePeers).toEqual([])
      expect(contract?.optionalDeclarationPeers).toEqual([])
    }
    for (const subpath of ["", "/client", "/rpc", "/testing"]) {
      const contract = publicPackageExportContracts.find(contract => contract.specifier === `@vite-hub/comments${subpath}`)
      expect(contract?.optionalRuntimePeers).toEqual([])
      expect(contract?.optionalDeclarationPeers).toEqual([])
    }
    const plugin = publicPackageExportContracts.find(contract => contract.specifier === "@vite-hub/comments/vite")
    expect(plugin?.optionalRuntimePeers).toEqual(["vite"])
    expect(plugin?.optionalDeclarationPeers).toEqual(["vite"])
  })

  it("classifies MarkdownEditor's eager editor peers", () => {
    const manifest = readPackageManifest("ui")
    const contract = publicPackageExportContracts.find(contract => contract.specifier === "@vite-hub/ui/markdown-editor")
    for (const peer of Object.keys(manifest.peerDependencies || {}).filter(name => name === "@nuxt/ui" || name.startsWith("@tiptap/"))) {
      if (peer === "@tiptap/extension-drag-handle" || peer === "@tiptap/extension-drag-handle-vue-3") {
        expect(contract?.optionalRuntimePeers).not.toContain(peer)
      } else {
        expect(contract?.optionalRuntimePeers, `${peer} is needed to import the editor`).toContain(peer)
      }
      expect(contract?.optionalDeclarationPeers, `${peer} is needed to typecheck the editor`).toContain(peer)
    }
  })

  it("keeps Schedule KV adapter declarations independent from its runtime peer", () => {
    const adapter = publicPackageExportContracts.find(contract => contract.specifier === "@vite-hub/schedule/runtime/kv")
    expect(adapter?.optionalDeclarationPeers).toEqual([])
    expect(adapter?.optionalRuntimePeers).toEqual(["@vite-hub/kv"])
  })

  it("classifies the optional CMS access runtime and declaration peers", () => {
    const manifest = readPackageManifest("cms")
    expect(manifest.peerDependenciesMeta?.["better-auth"]?.optional).toBe(true)
    const access = publicPackageExportContracts.find(contract => contract.specifier === "@vite-hub/cms/access")
    expect(access?.optionalRuntimePeers).toEqual(["better-auth"])
    expect(access?.optionalDeclarationPeers).toEqual(["@vite-hub/comments", "better-auth"])
    const root = publicPackageExportContracts.find(contract => contract.specifier === "@vite-hub/cms")
    expect(root?.optionalRuntimePeers).toEqual([])
    expect(root?.optionalDeclarationPeers).toEqual([])
  })

  it("classifies the Logs Evlog boundary for isolated consumers", () => {
    for (const [specifier, declarations, runtime] of [
      ["vite-hub/logs", ["evlog"], []],
      ["vite-hub/logs/memory", ["evlog"], []],
      ["vite-hub/logs/source", [], []],
      ["vite-hub/logs/host", [], []],
    ] as const) {
      const contract = publicPackageExportContracts.find(contract => contract.specifier === specifier)
      expect(contract?.optionalDeclarationPeers, specifier).toEqual(declarations)
      expect(contract?.optionalRuntimePeers, specifier).toEqual(runtime)
    }
  })

  it("keeps lazy optional peer exports runnable without their declaration peers", () => {
    const lazyPeerExports = new Map<string, string>([
      ["@vite-hub/agent", "@vite-hub/workflow"],
      ["@vite-hub/blob/vite", "vite"],
      ["@vite-hub/browser/controllers/playwright", "playwright-core"],
      ["@vite-hub/browser/vite", "vite"],
      ["@vite-hub/kv/vite", "vite"],
      ["@vite-hub/queue/vite", "vite"],
      ["@vite-hub/realtime/vite", "vite"],
      ["@vite-hub/sandbox/task/vite", "vite"],
      ["@vite-hub/workspace/vite", "vite"],
      ["vite-hub/browser/controllers/playwright", "playwright-core"],
    ])

    for (const [specifier, peer] of lazyPeerExports) {
      const contract = publicPackageExportContracts.find(contract => contract.specifier === specifier)
      expect(contract?.optionalRuntimePeers).not.toContain(peer)
      expect(contract?.optionalDeclarationPeers).toContain(peer)
    }
  })

  it("classifies the AI SDK model exports as declaration-only peer consumers", () => {
    for (const specifier of ["@vite-hub/gateways/ai-sdk", "vite-hub/gateways/ai-sdk"]) {
      const contract = publicPackageExportContracts.find(contract => contract.specifier === specifier)
      expect(contract?.optionalDeclarationPeers).toEqual(["@ai-sdk/provider"])
      expect(contract?.optionalRuntimePeers).toEqual([])
    }
  })

  it("publishes declaration dependencies where isolated consumers can resolve them", () => {
    for (const packageName of ["agent", "auth"]) {
      const manifest = readPackageManifest(packageName)
      for (const dependency of ["@types/json-schema", "@types/mdast"]) {
        expect(manifest.peerDependencies?.[dependency], `${packageName} should expose ${dependency}`).toEqual(expect.any(String))
        expect(manifest.peerDependenciesMeta?.[dependency]?.optional, `${packageName} should require ${dependency}`).not.toBe(true)
      }
    }

    const realtimeManifest = readPackageManifest("realtime")
    expect(realtimeManifest.peerDependencies?.["@types/json-schema"], "realtime should expose @types/json-schema").toEqual(expect.any(String))
    expect(realtimeManifest.peerDependenciesMeta?.["@types/json-schema"]?.optional, "realtime should require @types/json-schema").not.toBe(true)
  })

  it("publishes Realtime's shared Tiptap dependencies in its runtime closure", () => {
    const manifest = readPackageManifest("realtime")
    const packConfig = readFileSync(join(packageDir("realtime"), "vite.config.ts"), "utf8")

    for (const dependency of ["@tiptap/core", "@tiptap/pm", "yjs"]) {
      expect(manifest.peerDependencies?.[dependency], `realtime should take ${dependency} from the app`).toEqual(expect.any(String))
      expect(manifest.dependencies?.[dependency]).toBeUndefined()
    }
    for (const dependency of ["@tiptap/extension-collaboration", "@tiptap/y-tiptap"]) {
      expect(manifest.dependencies?.[dependency], `realtime should install ${dependency}`).toEqual(expect.any(String))
      expect(manifest.devDependencies?.[dependency]).toBeUndefined()
    }
    expect(packConfig).toContain("/^@tiptap\\/(?:extension-collaboration|y-tiptap)/")
    expect(packConfig).toContain("prosemirror-(?:model|state|transform|view)")
  })

  it("publishes Better Auth host declarations in its dependency closure", () => {
    const manifest = readPackageManifest("auth")
    expect(manifest.dependencies?.["@types/node"], "auth should install @types/node").toEqual(expect.any(String))
    for (const dependency of ["@cloudflare/workers-types", "bun-types"]) {
      expect(manifest.dependencies?.[dependency], `auth should not install ${dependency}`).toBeUndefined()
    }
    const hostDeclarations = readFileSync(join(packageDir("auth"), "src/host-declarations.d.ts"), "utf8")
    expect(hostDeclarations).toContain('/// <reference path="./bun-sqlite.d.ts" />')
    expect(hostDeclarations).toContain("interface Timer")
    expect(hostDeclarations).not.toMatch(/interface Timer extends NodeJS\.Timer/)
  })

  it("keeps Cloudflare Worker declarations out of the vite-hub install", () => {
    const manifest = readPackageManifest("vite-hub")
    expect(manifest.dependencies?.["@cloudflare/workers-types"], "vite-hub should not install @cloudflare/workers-types").toBeUndefined()
    expect(manifest.peerDependencies?.["@cloudflare/workers-types"]).toBe(">=4")
    expect(manifest.peerDependenciesMeta?.["@cloudflare/workers-types"]?.optional).toBe(true)
  })

  it("declares H3 for Blob serve authorization callbacks", () => {
    const source = readFileSync(join(packageDir("blob"), "src/types.ts"), "utf8")
    expect(readPackageManifest("blob").dependencies?.h3).toBeDefined()
    expect(source).toContain("export type BlobServeAuthorize = AccessAuthorize<H3Event>")
    expect(source).toContain("export type BlobServeAnonymousAuthorize = AnonymousAccessAuthorize<H3Event>")
  })

  it("keeps Realtime's public handler contract independent from H3 host declarations", () => {
    const source = readFileSync(join(packageDir("realtime"), "src/server.ts"), "utf8")
    expect(source).toMatch(/createRealtimeHandler\(registry: RealtimeRegistry, options: RealtimeHandlerOptions = \{\}\): RealtimeHandler/)
    expect(source).toMatch(/fetch\(input: Request \| URL \| string\): Promise<Response>/)
  })

  it("reads Sandbox Task payloads through Standard Context", () => {
    const source = readFileSync(join(packageDir("sandbox"), "src/task/internal/shared/request-payload.ts"), "utf8")
    expect(source).toMatch(/event: ViteHubContext/)
    expect(source).toContain("getStandardContext(event).req.json()")
  })

  it("bundles private workspace packages into every published dist", () => {
    const privateNames = listWorkspacePackageInfos(repoRoot).filter(info => info.private).map(info => info.packageName.replace("/", "\\/"))
    const privateImport = new RegExp(`(?:\\bfrom|\\bimport|\\brequire\\s*\\()\\s*["'](${privateNames.join("|")})(?:\\/[^"']*)?["']`, "g")
    const found = packageInfos.flatMap(info => walkFiles(join(packageDir(info.name), "dist"), { extensions: new Set(["cjs", "js", "mjs", "ts", "mts", "cts", "vue"]) })
      .flatMap(file => [...readFileSync(file, "utf8").matchAll(privateImport)].map(match => `${toRepoPath(file)} imports ${match[1]}`)))

    expect(found).toEqual([])
  })

  it("points every contract at a built artifact", () => {
    for (const contract of publicPackageExportContracts) {
      const info = packageInfos.find(info => info.packageName === contract.packageName)!
      const target = join(packageDir(info.name), contract.target.replace(/^\.\//, ""))

      expect(existsSync(target), `${contract.specifier} should publish ${contract.target}`).toBe(true)
    }
  })

  it("declares every optional peer used by an export contract", () => {
    for (const contract of publicPackageExportContracts) {
      const info = packageInfos.find(info => info.packageName === contract.packageName)!
      const manifest = readPackageManifest(info.name)
      for (const peer of new Set([...contract.optionalDeclarationPeers, ...contract.optionalRuntimePeers])) {
        expect(manifest.peerDependencies?.[peer], `${contract.specifier} should declare ${peer}`).toEqual(expect.any(String))
        expect(manifest.peerDependenciesMeta?.[peer]?.optional, `${contract.specifier} should keep ${peer} optional`).toBe(true)
      }
    }
  })

  it("classifies every executable and keeps its built target runnable", () => {
    const expected = packageInfos.flatMap((info) => {
      const manifest = readPackageManifest(info.name)
      return Object.entries(manifest.bin || {}).map(([binName, target]) => `${info.packageName}:${binName}:${target}`)
    }).sort()
    const actual = publicPackageBinContracts
      .map(contract => `${contract.packageName}:${contract.binName}:${contract.target}`)
      .sort()

    expect(actual).toEqual(expected)
    for (const contract of publicPackageBinContracts) {
      const info = packageInfos.find(info => info.packageName === contract.packageName)!
      const target = join(packageDir(info.name), contract.target.replace(/^\.\//, ""))
      expect(readFileSync(target, "utf8")).toMatch(/^#!\/usr\/bin\/env node/)
      expect(statSync(target).mode & 0o111, `${contract.packageName} ${contract.binName} should be executable`).not.toBe(0)
    }
  })
})
