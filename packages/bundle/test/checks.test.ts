import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { bundleCliContributor } from "../src/cli.ts"
import { collectEnvironmentReport } from "../src/collect.ts"
import { bundleDiagnostics, cloudflareWorkerSizeLimit } from "../src/diagnostics.ts"
import { readEnvironmentReports, writeEnvironmentReport } from "../src/files.ts"
import { createBundleReport } from "../src/report.ts"
import { hubBundle } from "../src/vite.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { OutputChunkLike } from "../src/collect.ts"
import type { BundleEnvironmentReport, BundleStartupRule } from "../src/types.ts"

const root = "/app"
const entry = `${root}/node_modules/nitro/dist/runtime.mjs`
const route = `${root}/.vitehub/agent/chat-webhook-route.ts`
const drizzle = `${root}/node_modules/@vite-hub/database/dist/drizzle.js`
const libsql = `${root}/node_modules/.pnpm/@libsql+client@0.15.0/node_modules/@libsql/client/lib-esm/web.js`
const hrana = `${root}/node_modules/.pnpm/@libsql+hrana-client@0.7.0/node_modules/@libsql/hrana-client/lib-esm/index.js`

const libsqlRule: BundleStartupRule = {
  owner: "@vite-hub/database",
  packages: ["@libsql/client", "@libsql/hrana-client"],
  why: "This Worker uses D1 for every Database.",
  fix: "Update `vite-hub`.",
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function chunk(fileName: string, modules: Record<string, number>, options: { entry?: string, imports?: string[] } = {}): OutputChunkLike {
  const size = Object.values(modules).reduce((sum, bytes) => sum + bytes, 0)
  return {
    type: "chunk",
    fileName,
    code: "x".repeat(size),
    isEntry: Boolean(options.entry),
    facadeModuleId: options.entry ?? null,
    imports: options.imports ?? [],
    modules: Object.fromEntries(Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }])),
  }
}

/** The Cloudflare D1 app before #3573: the Agent route imports the Database runtime, which imports libSQL statically. */
function workerBuild(options: { lazyLibsql?: boolean, host?: string, rules?: BundleStartupRule[] } = {}): BundleEnvironmentReport {
  const lazy = options.lazyLibsql
  const report = collectEnvironmentReport({
    "index.mjs": chunk("index.mjs", { [entry]: 300, [route]: 100, [drizzle]: 200 }, { entry, imports: lazy ? [] : ["_libs/libsql.mjs"] }),
    "_libs/libsql.mjs": chunk("_libs/libsql.mjs", { [libsql]: 900, [hrana]: 400 }),
  }, {
    build: "2026-11-07T10:00:00.000Z",
    environment: "nitro",
    side: "server",
    root,
    outDir: `${root}/.output/server`,
    getModuleInfo: id => ({
      importedIds: id === entry ? [route] : id === route ? [drizzle] : id === drizzle && !lazy ? [libsql] : id === libsql ? [hrana] : [],
      dynamicallyImportedIds: id === drizzle && lazy ? [libsql] : [],
      isEntry: id === entry,
    }),
  })
  return { ...report, host: options.host ?? "cloudflare-module", ...(options.rules ? { rules: options.rules } : { rules: [libsqlRule] }) }
}

function run(dir: string, args: string[]): { code: number, stdout: string } {
  let stdout = ""
  const context = { cwd: dir, env: {}, rootDir: dir, spawn: async () => ({ exitCode: 0 }), stdout: { write: (text: string | Uint8Array) => { stdout += String(text) } }, stderr: { write: () => true } } as ViteHubCliContext
  const feature = bundleCliContributor.namespaces[0]!.features.find(candidate => candidate.name === "report")!
  return { code: feature.run(args, context) as number, stdout }
}

function projectWith(...reports: BundleEnvironmentReport[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vitehub-bundle-checks-"))
  dirs.push(dir)
  for (const report of reports) writeEnvironmentReport(dir, report)
  return dir
}

describe("startup rules", () => {
  it("reports a package that the build never runs at startup, with the chain that loads it", () => {
    const report = createBundleReport([workerBuild()])!
    expect(report.host).toBe("cloudflare-module")
    expect(report.findings).toHaveLength(1)
    const [finding] = report.findings
    expect(finding).toMatchObject({
      code: "BUNDLE_STARTUP_UNUSED",
      severity: "warning",
      side: "server",
      bytes: 1300,
      docs: "https://vitehub.dev/docs/reference/errors-diagnostics#bundle_startup_unused",
    })
    expect(finding!.why).toBe("`@libsql/client` (900 B), `@libsql/hrana-client` (400 B) load at server startup. This Worker uses D1 for every Database.")
    expect(finding!.fix).toBe("Update `vite-hub`. Run `vitehub bundle why @libsql/client` for the import chain.")
    expect(finding!.chain.map(step => step.id)).toEqual([
      "node_modules/nitro/dist/runtime.mjs",
      ".vitehub/agent/chat-webhook-route.ts",
      "node_modules/@vite-hub/database/dist/drizzle.js",
      "node_modules/@libsql/client/lib-esm/web.js",
    ])
  })

  it("stays quiet when the package loads on demand", () => {
    expect(createBundleReport([workerBuild({ lazyLibsql: true })])!.findings).toEqual([])
  })

  it("stays quiet when no feature declares a rule", () => {
    expect(createBundleReport([workerBuild({ host: "node-server", rules: [] })])!.findings).toEqual([])
  })

  it("prints a warning and keeps exit code 0", () => {
    const dir = projectWith(workerBuild())
    const text = run(dir, [])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain("Bundle of the build from 2026-11-07T10:00:00.000Z for cloudflare-module")
    expect(text.stdout).toContain("Checks: 1 finding.")
    expect(text.stdout).toContain("warning BUNDLE_STARTUP_UNUSED (server): `@libsql/client` (900 B)")
    expect(text.stdout).toContain("Chain: node_modules/nitro/dist/runtime.mjs → .vitehub/agent/chat-webhook-route.ts → node_modules/@vite-hub/database/dist/drizzle.js → node_modules/@libsql/client/lib-esm/web.js")
    const json = run(dir, ["--json"])
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout).findings).toMatchObject([{ code: "BUNDLE_STARTUP_UNUSED", chain: expect.any(Array) }])
    expect(run(projectWith(workerBuild({ lazyLibsql: true })), []).stdout).toContain("Checks: no findings.")
  })
})

describe("host size limit", () => {
  function bigWorker(host: string, bytes: number): BundleEnvironmentReport {
    return {
      schemaVersion: 1,
      build: "2026-11-07T10:00:00.000Z",
      environment: "nitro",
      side: "server",
      outDir: ".output/server",
      host,
      chunks: [{
        file: "index.mjs",
        bytes,
        gzip: Math.round(bytes / 5),
        entry: true,
        startup: true,
        modules: [{ id: "node_modules/@huge/data/index.js", bytes, imports: [], dynamicImports: [], entry: true }],
      }],
    }
  }

  it("fails a Cloudflare Worker over 64 MiB before compression", () => {
    const dir = projectWith(bigWorker("cloudflare-module", cloudflareWorkerSizeLimit + 1))
    const [finding] = createBundleReport(readEnvironmentReports(dir))!.findings
    expect(finding).toMatchObject({ code: "BUNDLE_HOST_SIZE_LIMIT", severity: "error", bytes: cloudflareWorkerSizeLimit + 1 })
    expect(finding!.why).toContain("Cloudflare rejects a Worker over 67.11 MB (64 MiB)")
    expect(finding!.chain.map(step => step.id)).toEqual(["node_modules/@huge/data/index.js"])
    expect(run(dir, []).code).toBe(1)
    expect(run(dir, ["--json"]).code).toBe(1)
  })

  it("accepts a Worker at the limit and any size on other hosts", () => {
    expect(createBundleReport([bigWorker("cloudflare-module", cloudflareWorkerSizeLimit)])!.findings).toEqual([])
    expect(createBundleReport([bigWorker("node-server", cloudflareWorkerSizeLimit * 2)])!.findings).toEqual([])
  })
})

describe("rules from the Nitro build", () => {
  it("records the Nitro preset and the rules that features add in the vitehub:bundle:rules hook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vitehub-bundle-nitro-"))
    dirs.push(dir)
    const plugin = hubBundle()
    let buildConfig: ((nitro: unknown, config: { rolldown?: { plugins?: unknown } }) => void) | undefined
    plugin.nitro.setup({
      hooks: {
        hook: (_name, callback) => { buildConfig = callback },
        callHook: async (_name, rules) => { rules.push(libsqlRule) },
      },
      options: { dev: false, preset: "cloudflare-module", rootDir: dir },
    })
    const config: { rolldown?: { plugins?: unknown } } = { rolldown: { plugins: [] } }
    buildConfig!(undefined, config)
    const [reportPlugin] = config.rolldown!.plugins as Array<{ writeBundle: (this: { getModuleInfo: () => null }, output: { dir: string }, bundle: Record<string, unknown>) => Promise<void> }>
    await reportPlugin!.writeBundle.call({ getModuleInfo: () => null }, { dir: join(dir, ".output/server") }, {
      "index.mjs": chunk("index.mjs", { [join(dir, "server.ts")]: 10 }, { entry: join(dir, "server.ts") }),
    })
    expect(readEnvironmentReports(dir)).toMatchObject([{ environment: "nitro", host: "cloudflare-module", rules: [libsqlRule] }])
  })
})

it("documents each bundle check with a docs heading", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/reference/errors-diagnostics.md", import.meta.url), "utf8")
  for (const code of Object.keys(bundleDiagnostics)) expect(page, code).toContain(`\n### ${code}\n`)
})
