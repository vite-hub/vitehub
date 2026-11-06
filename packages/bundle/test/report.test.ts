import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { bundleCliContributor } from "../src/cli.ts"
import { collectEnvironmentReport } from "../src/collect.ts"
import { readEnvironmentReports, writeEnvironmentReport } from "../src/files.ts"
import { moduleGroup, moduleId } from "../src/groups.ts"
import { createBundleReport, explainBundle } from "../src/report.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ModuleInfoLike, OutputChunkLike } from "../src/collect.ts"

const root = "/app"

function chunk(fileName: string, code: string, modules: Record<string, number>, options: { entry?: string, imports?: string[] } = {}): OutputChunkLike {
  return {
    type: "chunk",
    fileName,
    code,
    isEntry: Boolean(options.entry),
    facadeModuleId: options.entry ?? null,
    imports: options.imports ?? [],
    modules: Object.fromEntries(Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }])),
  }
}

function graph(edges: Record<string, string[]>, entries: string[], dynamic: Record<string, string[]> = {}): (id: string) => ModuleInfoLike {
  return id => ({ importedIds: edges[id] ?? [], dynamicallyImportedIds: dynamic[id] ?? [], isEntry: entries.includes(id) })
}

/** Nuxt 5: Nitro bundles the SSR output from the buildDir under `node_modules/.cache`. */
function nuxtBuild(build = "2026-11-06T10:00:00.000Z") {
  const ssrOut = `${root}/node_modules/.cache/nuxt/.nuxt/dist/server`
  const ssr = collectEnvironmentReport({
    "server.mjs": chunk("server.mjs", "x".repeat(300), { [`${root}/app/app.vue`]: 100, [`${root}/app/pages/heavy.vue`]: 50, [`${root}/node_modules/.pnpm/zod@4.1.0/node_modules/zod/index.js`]: 150 }, { entry: `${root}/app/app.vue` }),
  }, {
    build, environment: "ssr", side: "server", root, outDir: ssrOut,
    getModuleInfo: graph({ [`${root}/app/app.vue`]: [`${root}/app/pages/heavy.vue`], [`${root}/app/pages/heavy.vue`]: [`${root}/node_modules/.pnpm/zod@4.1.0/node_modules/zod/index.js`] }, [`${root}/app/app.vue`]),
  })
  const nitro = collectEnvironmentReport({
    "index.mjs": chunk("index.mjs", "y".repeat(1000), { [`${root}/node_modules/nitro/dist/runtime.mjs`]: 400, [`${ssrOut}/server.mjs`]: 200, [`${root}/node_modules/.pnpm/@libsql+client@0.15.0/node_modules/@libsql/client/web.js`]: 400 }, { entry: `${root}/node_modules/nitro/dist/runtime.mjs` }),
    "chunks/lazy.mjs": chunk("chunks/lazy.mjs", "z".repeat(100), { [`${root}/server/api/hello.get.ts`]: 100 }),
  }, {
    build, environment: "nitro", side: "server", root, outDir: `${root}/.output/server`,
    getModuleInfo: graph(
      { [`${root}/node_modules/nitro/dist/runtime.mjs`]: [`${ssrOut}/server.mjs`, `${root}/node_modules/.pnpm/@libsql+client@0.15.0/node_modules/@libsql/client/web.js`] },
      [`${root}/node_modules/nitro/dist/runtime.mjs`],
      { [`${root}/node_modules/nitro/dist/runtime.mjs`]: [`${root}/server/api/hello.get.ts`] },
    ),
  })
  const client = collectEnvironmentReport({
    "entry.js": chunk("entry.js", "c".repeat(500), { [`${root}/node_modules/vue/dist/vue.mjs`]: 1000 }, { entry: `${root}/node_modules/vue/dist/vue.mjs`, imports: ["shared.js"] }),
    "shared.js": chunk("shared.js", "s".repeat(100), { [`${root}/app/composables/a.ts`]: 10 }),
    "heavy.js": chunk("heavy.js", "h".repeat(200), { [`${root}/app/pages/heavy.vue`]: 20, [`${root}/node_modules/zod/index.js`]: 180 }, { imports: ["shared.js"] }),
  }, { build, environment: "client", side: "client", root, outDir: `${root}/.output/public`, getModuleInfo: graph({}, [`${root}/node_modules/vue/dist/vue.mjs`]) })
  return [client, nitro, ssr]
}

describe("module ids and groups", () => {
  it("names pnpm packages, workspace packages, generated output, and app folders", () => {
    expect(moduleId(`${root}/node_modules/.pnpm/@libsql+client@0.15.0/node_modules/@libsql/client/web.js?x`, root)).toBe("node_modules/@libsql/client/web.js")
    expect(moduleId("/repo/packages/agent/dist/index.js", root)).toBe("node_modules/@vite-hub/agent/dist/index.js")
    expect(moduleId(`${root}/node_modules/.cache/nuxt/.nuxt/dist/server/server.mjs`, root)).toBe("node_modules/.cache/nuxt/.nuxt/dist/server/server.mjs")
    expect(moduleGroup("node_modules/vite-hub/dist/console/runtime/server/mcp.js")).toEqual({ name: "vite-hub/console", kind: "vitehub" })
    expect(moduleGroup("node_modules/vite-hub/dist/usage-index-DINxJnhe.js")).toEqual({ name: "vite-hub/usage-index", kind: "vitehub" })
    expect(moduleGroup("node_modules/@vite-hub/agent/dist/index.js")).toEqual({ name: "@vite-hub/agent", kind: "vitehub" })
    expect(moduleGroup("node_modules/h3/dist/index.mjs").kind).toBe("framework")
    expect(moduleGroup("node_modules/.cache/nuxt/.nuxt/x.mjs")).toEqual({ name: ".nuxt", kind: "generated" })
    expect(moduleGroup("node_modules/.cache/vite/deps/x.js")).toEqual({ name: "node_modules/.cache", kind: "generated" })
    expect(moduleId("\0virtual:nuxt:node_modules%2F.cache%2Fnuxt%2F.nuxt%2Froutes.mjs", root)).toBe("node_modules/.cache/nuxt/.nuxt/routes.mjs")
    expect(moduleId(`virtual:nuxt:${encodeURIComponent(`${root}/.nuxt/app.config.mjs`)}`, root)).toBe(".nuxt/app.config.mjs")
    expect(moduleGroup(".vitehub/nitro/plugin.mjs")).toEqual({ name: ".vitehub", kind: "generated" })
    expect(moduleGroup("#nitro/virtual/handlers")).toEqual({ name: "#nitro/virtual", kind: "generated" })
    expect(moduleGroup("virtual:vitehub-routes")).toEqual({ name: "virtual:vitehub-routes", kind: "generated" })
    expect(moduleGroup("server/api/hello.get.ts")).toEqual({ name: "server/api", kind: "app" })
  })
})

describe("environment reports", () => {
  it("marks the static closure of the entry as startup and gives each module its share of the file", () => {
    const [client] = nuxtBuild()
    expect(client!.chunks.map(row => [row.file, row.startup])).toEqual([["entry.js", true], ["heavy.js", false], ["shared.js", true]])
    const heavy = client!.chunks.find(row => row.file === "heavy.js")!
    expect(heavy.modules.map(module => [module.id, module.bytes])).toEqual([["node_modules/zod/index.js", 180], ["app/pages/heavy.vue", 20]])
  })

  it("follows imports through modules that left no code, and merges the parts of one file", () => {
    const routes = `${root}/.nuxt/routes.mjs`
    const page = `${root}/app/pages/heavy.vue`
    const script = `${page}?vue&type=script&setup=true&lang.ts`
    const zodIndex = `${root}/node_modules/zod/index.js`
    const zodCore = `${root}/node_modules/zod/v4/core.js`
    const report = collectEnvironmentReport({
      "entry.js": chunk("entry.js", "e".repeat(100), { [routes]: 100 }, { entry: routes }),
      "heavy.js": chunk("heavy.js", "h".repeat(300), { [page]: 50, [script]: 50, [zodIndex]: 0, [zodCore]: 200 }),
    }, {
      build: "b", environment: "client", side: "client", root, outDir: `${root}/dist`,
      getModuleInfo: graph({ [page]: [script], [script]: [zodIndex], [zodIndex]: [zodCore] }, [routes], { [routes]: [page] }),
    })
    const heavy = report.chunks.find(row => row.file === "heavy.js")!
    expect(heavy.modules).toEqual([
      { id: "node_modules/zod/v4/core.js", bytes: 200, imports: [], dynamicImports: [], entry: false },
      { id: "app/pages/heavy.vue", bytes: 100, imports: ["node_modules/zod/v4/core.js"], dynamicImports: [], entry: false },
    ])
    expect(explainBundle([report], "zod")[0]!.chain.map(step => step.id)).toEqual([".nuxt/routes.mjs", "app/pages/heavy.vue", "node_modules/zod/v4/core.js"])
  })
})

describe("app report", () => {
  it("joins the SSR output into the server and scales it to the bytes Nitro wrote", () => {
    const report = createBundleReport(nuxtBuild())!
    expect(report.server!.environments).toEqual(["nitro", "ssr"])
    expect(report.server!.bytes).toBe(1100)
    expect(report.server!.startup).toMatchObject({ bytes: 1000, chunks: 1 })
    const groups = Object.fromEntries(report.server!.groups.map(group => [group.name, group]))
    // 400 of 1000 rendered bytes in a 1000 B file, and the 200 B SSR module split 67/33/100.
    expect(groups["@libsql/client"]).toMatchObject({ bytes: 400, startupBytes: 400, kind: "dependency" })
    expect(groups.zod).toMatchObject({ bytes: 100, startupBytes: 100 })
    expect(groups.app).toMatchObject({ bytes: 67 })
    expect(groups["server/api"]).toMatchObject({ bytes: 100, startupBytes: 0 })
    expect(groups["node_modules/.cache"]).toBeUndefined()
    expect(report.client).toMatchObject({ bytes: 800, chunks: 3, startup: { bytes: 600, chunks: 2 } })
  })

  it("reads only the newest build", () => {
    const old = nuxtBuild("2026-11-05T10:00:00.000Z").filter(report => report.environment === "ssr").map(report => ({ ...report, environment: "old-ssr" }))
    expect(createBundleReport([...old, ...nuxtBuild()])!.server!.environments).toEqual(["nitro", "ssr"])
  })

  it("explains a package through Nitro and on into the SSR build", () => {
    const [client, server] = explainBundle(nuxtBuild(), "zod")
    expect(client).toMatchObject({ side: "client", bytes: 180, startup: false })
    expect(server).toMatchObject({ side: "server", group: "zod", bytes: 100, startup: true })
    expect(server!.chain).toEqual([
      { environment: "nitro", id: "node_modules/nitro/dist/runtime.mjs" },
      { environment: "nitro", id: "node_modules/.cache/nuxt/.nuxt/dist/server/server.mjs" },
      { environment: "ssr", id: "app/app.vue" },
      { environment: "ssr", id: "app/pages/heavy.vue" },
      { environment: "ssr", id: "node_modules/zod/index.js" },
    ])
    expect(explainBundle(nuxtBuild(), "server/api/hello.get.ts")[0]).toMatchObject({ side: "server", startup: false, chain: [{ id: "node_modules/nitro/dist/runtime.mjs" }, { id: "server/api/hello.get.ts" }] })
    expect(explainBundle(nuxtBuild(), "left-pad")).toEqual([])
  })
})

describe("files and CLI", () => {
  function run(root: string, args: string[]): { code: number | void, stdout: string, stderr: string } {
    let stdout = ""
    let stderr = ""
    const context = { cwd: root, env: {}, rootDir: root, spawn: async () => ({ exitCode: 0 }), stdout: { write: (text: string | Uint8Array) => { stdout += String(text) } }, stderr: { write: (text: string | Uint8Array) => { stderr += String(text) } } } as ViteHubCliContext
    const [namespace] = bundleCliContributor.namespaces
    const feature = namespace!.features.find(candidate => candidate.name === (args[0] === "why" ? "why" : "report"))!
    const code = feature.run(args[0] === "why" ? args.slice(1) : args, context) as number
    return { code, stdout, stderr }
  }

  it("writes one file per environment, removes older builds, and prints the report", () => {
    const dir = mkdtempSync(join(tmpdir(), "vitehub-bundle-"))
    expect(run(dir, [])).toMatchObject({ code: 1, stderr: expect.stringContaining("bundle: true") })
    for (const report of nuxtBuild("2026-11-05T10:00:00.000Z")) writeEnvironmentReport(dir, report)
    for (const report of nuxtBuild().filter(report => report.environment !== "ssr")) writeEnvironmentReport(dir, report)
    expect(readEnvironmentReports(dir).map(report => report.environment).sort()).toEqual(["client", "nitro"])
    writeFileSync(join(dir, ".vitehub/bundle/broken.json"), "{")
    const summary = run(dir, [])
    expect(summary.code).toBe(0)
    expect(summary.stdout).toContain("Server: 1.1 kB of JavaScript in 2 files")
    expect(summary.stdout).toContain("@libsql/client (dependency)")
    expect(JSON.parse(run(dir, ["--json"]).stdout)).toMatchObject({ schemaVersion: 1, client: { chunks: 3 } })
    const why = run(dir, ["why", "@libsql/client"])
    expect(why.stdout).toContain("Server: 400 B in @libsql/client, loads at startup.")
    expect(why.stdout).toContain("→ node_modules/@libsql/client/web.js")
    expect(run(dir, ["why"])).toMatchObject({ code: 1 })
    expect(readFileSync(join(dir, ".vitehub/bundle/nitro.json"), "utf8")).toContain("\"environment\":\"nitro\"")
  })
})
