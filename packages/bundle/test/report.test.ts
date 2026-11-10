import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { bundleCliContributor } from "../src/cli.ts"
import { collectEnvironmentReport } from "../src/collect.ts"
import { readEnvironmentReports, writeBundleReportRoot, writeEnvironmentReport } from "../src/files.ts"
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
  it.each([
    ["packages", "shared"],
    ["packages", "@consumer/shared"],
    ["packages", "@vite-hub/agent"],
    ["libs", "shared"],
    ["libs/nested", "@consumer/shared"],
  ])("uses the manifest name for a sibling workspace under %s named %s", (parent, name) => {
    const workspace = mkdtempSync(join(tmpdir(), "vitehub-bundle-workspace-"))
    try {
      const packageDir = join(workspace, parent, "shared")
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name }))
      const appRoot = join(workspace, "apps", "site")
      const raw = join(packageDir, "dist", "index.js")
      const report = collectEnvironmentReport({
        "entry.js": chunk("entry.js", "code", { [raw]: 1 }, { entry: raw }),
      }, { build: "b", environment: "client", side: "client", root: appRoot, outDir: join(appRoot, "dist"), getModuleInfo: graph({}, [raw]) })
      expect(report.chunks[0]!.modules[0]!.id).toBe(`node_modules/${name}/dist/index.js`)
      expect(createBundleReport([report])!.client!.groups).toMatchObject([{ name, kind: name.startsWith("@vite-hub/") ? "vitehub" : "dependency", bytes: 4 }])
      expect(explainBundle([report], name)[0]?.bytes).toBe(4)
    }
    finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("normalizes Windows app, dependency, workspace, and Nuxt template paths", () => {
    const windowsRoot = "C:\\repo\\app\\"
    expect(moduleId("C:/repo/app/server/api/hello.ts", windowsRoot)).toBe("server/api/hello.ts")
    expect(moduleId("C:\\repo\\app\\node_modules\\.pnpm\\zod@4\\node_modules\\zod\\index.js?x", windowsRoot)).toBe("node_modules/zod/index.js")
    expect(moduleId("C:/repo/packages/agent/dist/index.js", windowsRoot)).toBe("C:/repo/packages/agent/dist/index.js")
    expect(moduleId(`virtual:nuxt:${encodeURIComponent("C:/repo/app/.nuxt/routes.mjs")}`, windowsRoot)).toBe(".nuxt/routes.mjs")
    expect(moduleGroup(moduleId("C:/repo/app/server/api/hello.ts", windowsRoot))).toEqual({ name: "server/api", kind: "app" })
    expect(moduleGroup(moduleId("D:/shared/index.js", windowsRoot))).toEqual({ name: "outside the project", kind: "dependency" })
  })

  it("names pnpm packages, workspace packages, generated output, and app folders", () => {
    expect(moduleId(`${root}/node_modules/.pnpm/@libsql+client@0.15.0/node_modules/@libsql/client/web.js?x`, root)).toBe("node_modules/@libsql/client/web.js")
    expect(moduleId("/repo/packages/agent/dist/index.js", root)).toBe("/repo/packages/agent/dist/index.js")
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
  it("keeps zero-byte entry facades as roots for static and dynamic import chains", () => {
    const entry = `${root}/index.html`
    const main = `${root}/src/main.ts`
    const barrel = `${root}/src/barrel.ts`
    const dependency = `${root}/node_modules/zod/index.js`
    const lazy = `${root}/src/lazy.ts`
    const report = collectEnvironmentReport({
      "entry.js": chunk("entry.js", "x".repeat(10), { [entry]: 0, [barrel]: 0, [main]: 5, [dependency]: 5 }, { entry }),
      "lazy.js": chunk("lazy.js", "xxx", { [lazy]: 3 }),
    }, {
      build: "b", environment: "client", side: "client", root, outDir: `${root}/dist`,
      getModuleInfo: graph({ [entry]: [barrel], [barrel]: [main], [main]: [dependency] }, [entry], { [main]: [lazy] }),
    })
    expect(report.chunks[0]!.modules.find(module => module.id === "index.html")).toMatchObject({ bytes: 0, entry: true, imports: ["src/main.ts"] })
    expect(explainBundle([report], "zod")[0]!.chain.map(step => step.id)).toEqual(["index.html", "src/main.ts", "node_modules/zod/index.js"])
    expect(explainBundle([report], "src/lazy.ts")[0]).toMatchObject({ startup: false, chain: [{ id: "index.html" }, { id: "src/main.ts" }, { id: "src/lazy.ts" }] })
    expect(createBundleReport([report])!.client!.groups.reduce((sum, group) => sum + group.bytes, 0)).toBe(13)
  })

  it("normalizes Windows output folders so Nitro can place SSR modules", () => {
    const windowsRoot = "C:\\repo\\app"
    const ssr = collectEnvironmentReport({
      "server.mjs": chunk("server.mjs", "ssr", { "C:/repo/app/pages/index.vue": 3 }),
    }, { build: "b", environment: "ssr", side: "server", root: windowsRoot, outDir: `${windowsRoot}\\.nuxt\\dist\\server`, getModuleInfo: graph({}, []) })
    const nitro = collectEnvironmentReport({
      "index.mjs": chunk("index.mjs", "nitro", { "C:/repo/app/.nuxt/dist/server/server.mjs": 5 }),
    }, { build: "b", environment: "nitro", side: "server", root: windowsRoot, outDir: `${windowsRoot}\\.output\\server`, getModuleInfo: graph({}, []) })
    expect(ssr.outDir).toBe(".nuxt/dist/server")
    expect(createBundleReport([ssr, nitro])!.server).toMatchObject({ bytes: 5, groups: [{ name: "pages", kind: "app", bytes: 5 }] })
  })

  it("combines all page entries and counts shared startup files once", () => {
    const report = collectEnvironmentReport({
      "one.js": chunk("one.js", "x", { "/app/one.js": 1 }, { entry: "/app/one.js", imports: ["shared.js"] }),
      "two.js": chunk("two.js", "xx", { "/app/two.js": 2 }, { entry: "/app/two.js", imports: ["shared.js"] }),
      "shared.js": chunk("shared.js", "xxx", { "/app/shared.js": 3 }),
      "lazy.js": chunk("lazy.js", "xxxx", { "/app/lazy.js": 4 }),
    }, { build: "b", environment: "client", side: "client", root, outDir: `${root}/dist`, getModuleInfo: graph({}, ["/app/one.js", "/app/two.js"]) })
    expect(createBundleReport([report])!.client).toMatchObject({ bytes: 10, startup: { bytes: 6, chunks: 3 } })
  })

  it.each([2, 4])("preserves a %i-byte chunk when module shares need rounding", (bytes) => {
    const report = collectEnvironmentReport({
      "entry.js": chunk("entry.js", "x".repeat(bytes), { "/app/a.js": 1, "/app/b.js": 1, "/app/c.js": 1 }, { entry: "/app/a.js" }),
    }, { build: "b", environment: "client", side: "client", root, outDir: `${root}/dist`, getModuleInfo: graph({}, ["/app/a.js"]) })
    expect(report.chunks[0]!.modules.reduce((sum, module) => sum + module.bytes, 0)).toBe(bytes)
    expect(createBundleReport([report])!.client!.groups.reduce((sum, group) => sum + group.bytes, 0)).toBe(bytes)
  })

  it("keeps static and dynamic closures through cycles of dropped modules", () => {
    const first = "/app/first.js"
    const second = "/app/second.js"
    const a = "/app/a.js"
    const b = "/app/b.js"
    const target = "/app/node_modules/zod/index.js"
    const lazy = "/app/lazy.js"
    const report = collectEnvironmentReport({
      "first.js": chunk("first.js", "x", { [first]: 1 }, { entry: first }),
      "second.js": chunk("second.js", "xx", { [second]: 1, [target]: 1 }, { entry: second }),
      "lazy.js": chunk("lazy.js", "x", { [lazy]: 1 }),
    }, {
      build: "b", environment: "client", side: "client", root, outDir: `${root}/dist`,
      getModuleInfo: graph({ [first]: [a], [second]: [b], [a]: [b, target], [b]: [a] }, [first, second], { [a]: [lazy] }),
    })
    const secondModule = report.chunks.find(row => row.file === "second.js")!.modules.find(module => module.id === "second.js")!
    expect(secondModule.imports).toEqual(["node_modules/zod/index.js"])
    expect(secondModule.dynamicImports).toEqual(["lazy.js"])
    // Remove the first entry to prove that the later traversal also has a usable chain.
    const withoutFirst = { ...report, chunks: report.chunks.filter(row => row.file !== "first.js") }
    expect(explainBundle([withoutFirst], "zod")[0]!.chain.map(step => step.id)).toEqual(["second.js", "node_modules/zod/index.js"])
  })

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
  it("preserves Nitro's bytes when replacing an opaque SSR module", () => {
    const reports = nuxtBuild()
    const ssr = reports.find(report => report.environment === "ssr")!
    ssr.chunks[0]!.modules.forEach(module => { module.bytes = 1 })
    const server = createBundleReport(reports)!.server!
    expect(server.groups.reduce((sum, group) => sum + group.bytes, 0)).toBe(server.bytes)
    expect(server.groups.reduce((sum, group) => sum + group.startupBytes, 0)).toBe(server.startup.bytes)
  })

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

describe("why", () => {
  it("prefers the static chain that loads a module at startup over a shorter lazy one", () => {
    const entry = `${root}/server/index.ts`
    const usage = `${root}/server/routes/usage.ts`
    const chat = `${root}/server/routes/chat.ts`
    const drizzle = `${root}/node_modules/drizzle-orm/libsql/driver.js`
    const libsql = `${root}/node_modules/@libsql/client/web.js`
    const report = collectEnvironmentReport({
      "index.mjs": chunk("index.mjs", "i".repeat(400), { [entry]: 100, [chat]: 100, [drizzle]: 100, [libsql]: 100 }, { entry }),
      "usage.mjs": chunk("usage.mjs", "u".repeat(100), { [usage]: 100 }),
    }, {
      build: "b", environment: "nitro", side: "server", root, outDir: `${root}/.output/server`,
      getModuleInfo: graph({ [entry]: [chat], [chat]: [drizzle], [drizzle]: [libsql], [usage]: [libsql] }, [entry], { [entry]: [usage] }),
    })
    expect(explainBundle([report], "@libsql/client")[0]!.chain.map(step => step.id)).toEqual([
      "server/index.ts", "server/routes/chat.ts", "node_modules/drizzle-orm/libsql/driver.js", "node_modules/@libsql/client/web.js",
    ])
  })
})

describe("files and CLI", () => {
  function run(root: string, args: string[], cwd = root): { code: number | void, stdout: string, stderr: string } {
    let stdout = ""
    let stderr = ""
    const context = { cwd, env: {}, rootDir: root, spawn: async () => ({ exitCode: 0 }), stdout: { write: (text: string | Uint8Array) => { stdout += String(text) } }, stderr: { write: (text: string | Uint8Array) => { stderr += String(text) } } } as ViteHubCliContext
    const [namespace] = bundleCliContributor.namespaces
    const feature = namespace!.features.find(candidate => candidate.name === (args[0] === "why" ? "why" : "report"))!
    const code = feature.run(args[0] === "why" ? args.slice(1) : args, context) as number
    return { code, stdout, stderr }
  }

  it("keeps the root supplied by a CLI that loaded the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "vitehub-bundle-loaded-root-"))
    const app = join(dir, "web")
    try {
      mkdirSync(app)
      writeFileSync(join(app, "package.json"), '{"type":"module"}')
      for (const report of nuxtBuild("workspace-build")) writeEnvironmentReport(dir, report)
      for (const report of nuxtBuild("app-build")) writeEnvironmentReport(app, report)
      writeBundleReportRoot(app, dir)
      expect(JSON.parse(run(app, ["--json"], dir).stdout).build).toBe("app-build")
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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
    expect(summary.stdout).toContain("Combined startup across all page entries; shared files count once.")
    expect(JSON.parse(run(dir, ["--json"]).stdout)).toMatchObject({ schemaVersion: 1, client: { chunks: 3 } })
    const why = run(dir, ["why", "@libsql/client"])
    expect(why.stdout).toContain("Server: 400 B in @libsql/client, loads at startup.")
    expect(why.stdout).toContain("→ node_modules/@libsql/client/web.js")
    expect(run(dir, ["why"])).toMatchObject({ code: 1 })
    expect(readFileSync(join(dir, ".vitehub/bundle/nitro.json"), "utf8")).toContain("\"environment\":\"nitro\"")
  })
})
