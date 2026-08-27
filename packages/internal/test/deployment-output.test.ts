import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"

import { bundleEsmEntry } from "../src/build/esbuild.ts"

vi.mock("../src/build/esbuild.ts", () => ({
  bundleEsmEntry: vi.fn(async (_entry: string, outfile: string) => {
    await mkdir(dirname(outfile), { recursive: true })
    await writeFile(outfile, "export default {}\n", "utf8")
  }),
}))

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-internal-deployment-output-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writePackage(rootDir: string, name: string, packageJson: Record<string, unknown> = {}) {
  const packageDir = join(rootDir, "node_modules", ...name.split("/"))
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, "index.js"), "export default {}\n", "utf8")
  await writeFile(join(packageDir, "package.json"), `${JSON.stringify({
    name,
    version: "1.0.0",
    ...packageJson,
  }, null, 2)}\n`, "utf8")
  return packageDir
}

afterEach(async () => {
  vi.mocked(bundleEsmEntry).mockReset().mockImplementation(async (_entry, outfile) => {
    await mkdir(dirname(outfile), { recursive: true })
    await writeFile(outfile, "export default {}\n", "utf8")
  })
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("provider deployment outputs", () => {
  it("preserves default output roots for omitted providers", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const vercelDir = createDefaultVercelOutputRoot(rootDir)
    await mkdir(cloudflareDir, { recursive: true })
    await mkdir(vercelDir, { recursive: true })
    await writeFile(join(cloudflareDir, "wrangler.json"), "{}")
    await writeFile(join(vercelDir, "config.json"), "{}")

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
      },
    })

    expect(existsSync(cloudflareDir)).toBe(true)
    expect(existsSync(vercelDir)).toBe(true)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      cloudflare: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        wranglerConfig: {},
      },
      rootDir,
    })

    expect(existsSync(cloudflareDir)).toBe(true)
    expect(existsSync(vercelDir)).toBe(true)
  })

  it("preserves sibling Cloudflare output files and config keys", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const siblingFile = join(cloudflareDir, "schedule-worker.js")
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(siblingFile, "export default {}")
    await writeFile(join(cloudflareDir, "wrangler.json"), `${JSON.stringify({
      main: "index.js",
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      cloudflare: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        wranglerConfig: {
          compatibility_date: "2026-01-01",
          main: "index.js",
        },
      },
      rootDir,
    })

    await expect(readFile(siblingFile, "utf8")).resolves.toBe("export default {}")
    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      compatibility_date: "2026-01-01",
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("does not copy client output for config-only Cloudflare output", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html>\n")

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist",
      cloudflare: {
        wranglerConfig: {
          kv_namespaces: [{ binding: "SETTINGS", id: "namespace-id" }],
        },
        wranglerConfigKeys: ["kv_namespaces"],
      },
      rootDir,
    })

    expect(existsSync(join(rootDir, "dist", "client"))).toBe(false)
    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      kv_namespaces: [{ binding: "SETTINGS", id: "namespace-id" }],
    })
  })

  it("excludes nested Cloudflare output from every Vercel static copy", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const clientDir = join(rootDir, "dist")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const vercelStaticDir = join(createDefaultVercelOutputRoot(rootDir), "static")
    const copiedCloudflareDir = join(vercelStaticDir, relative(clientDir, cloudflareDir))
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(join(clientDir, "index.html"), "<!doctype html>\n")
    await writeFile(join(cloudflareDir, "wrangler.json"), "{}\n")

    const writeVercelOutput = () => writeProviderDeploymentOutputs({
      clientOutDir: "dist",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
      },
    })

    await writeVercelOutput()
    expect(existsSync(join(vercelStaticDir, "index.html"))).toBe(true)
    expect(existsSync(copiedCloudflareDir)).toBe(false)

    await writeVercelOutput()
    expect(existsSync(join(cloudflareDir, "wrangler.json"))).toBe(true)
    expect(existsSync(copiedCloudflareDir)).toBe(false)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        staticOutputDir: clientDir,
      },
    })
    expect(existsSync(join(cloudflareDir, "wrangler.json"))).toBe(true)
  })

  it("forwards keyed array ownership through composed Cloudflare output", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(join(cloudflareDir, "wrangler.json"), `${JSON.stringify({
      ratelimits: [
        { name: "MANUAL", namespace_id: "1", simple: { limit: 1, period: 10 } },
        { name: "UPLOADS", namespace_id: "2", simple: { limit: 5, period: 60 } },
      ],
    }, null, 2)}\n`)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      cloudflare: {
        wranglerConfig: {
          ratelimits: [{ name: "UPLOADS", namespace_id: "3", simple: { limit: 10, period: 60 } }],
        },
        wranglerConfigOwnership: {
          arrays: { ratelimits: { key: "name", values: ["UPLOADS"] } },
        },
      },
      rootDir,
    })

    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      ratelimits: [
        { name: "MANUAL", namespace_id: "1", simple: { limit: 1, period: 10 } },
        { name: "UPLOADS", namespace_id: "3", simple: { limit: 10, period: 60 } },
      ],
    })
  })

  it.each([
    ["a top-level undefined value", { main: undefined }],
    ["a nested undefined value", { assets: { directory: undefined } }],
    ["a non-finite number", { limit: Number.POSITIVE_INFINITY }],
    ["a bigint", { limit: 1n }],
    ["a symbol", { binding: Symbol("binding") }],
    ["a function", { resolve: () => undefined }],
    ["a Date", new Date("2026-01-01")],
    ["a Map", new Map([["binding", "SETTINGS"]])],
    ["a class instance", new class ProviderConfig { binding = "SETTINGS" }()],
    ["a nested non-plain object", { binding: new Date("2026-01-01") }],
  ])("rejects provider config containing %s", async (_label, wranglerConfig) => {
    const rootDir = await createTempProject()
    const { writeCloudflareWranglerConfig } = await import("../src/build/cloudflare.ts")

    await expect(writeCloudflareWranglerConfig({ rootDir, wranglerConfig })).rejects.toThrow(
      "[vitehub] Provider output config must be a JSON object.",
    )
  })

  it("accepts provider config with ordinary and null-prototype records", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeCloudflareWranglerConfig,
    } = await import("../src/build/cloudflare.ts")
    const nested = Object.assign(Object.create(null), { enabled: true })
    const wranglerConfig = Object.assign(Object.create(null), { nested })

    await writeCloudflareWranglerConfig({ rootDir, wranglerConfig })

    const configFile = join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toEqual({
      nested: { enabled: true },
    })
  })

  it("does not create Cloudflare output while cleaning absent owned config", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeCloudflareWranglerConfig,
    } = await import("../src/build/cloudflare.ts")

    await writeCloudflareWranglerConfig({
      rootDir,
      wranglerConfigOwnership: {
        arrays: { kv_namespaces: { key: "binding", values: ["SETTINGS"] } },
      },
    })

    expect(existsSync(createDefaultCloudflareOutputRoot(rootDir))).toBe(false)
  })

  it("merges keyed Cloudflare config arrays without dropping unrelated entries", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeCloudflareWranglerConfig,
    } = await import("../src/build/cloudflare.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(join(cloudflareDir, "wrangler.json"), `${JSON.stringify({
      kv_namespaces: [
        { binding: "MANUAL", id: "manual-namespace" },
        { binding: "SETTINGS", id: "old-namespace" },
      ],
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`)

    await writeCloudflareWranglerConfig({
      rootDir,
      wranglerConfig: {
        kv_namespaces: [{ binding: "SETTINGS", id: "new-namespace" }],
      },
      wranglerConfigOwnership: {
        arrays: { kv_namespaces: { key: "binding" } },
      },
    })

    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      kv_namespaces: [
        { binding: "MANUAL", id: "manual-namespace" },
        { binding: "SETTINGS", id: "new-namespace" },
      ],
      triggers: { crons: ["0 0 * * *"] },
    })

    await writeCloudflareWranglerConfig({
      rootDir,
      wranglerConfigOwnership: {
        arrays: { kv_namespaces: { key: "binding", values: ["SETTINGS"] } },
      },
    })

    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      kv_namespaces: [{ binding: "MANUAL", id: "manual-namespace" }],
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("removes empty owned Cloudflare config arrays and output roots", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const configFile = join(cloudflareDir, "wrangler.json")
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(configFile, "{\"kv_namespaces\":[]}\n")

    await writeProviderDeploymentOutputs({
      cleanup: {
        cloudflare: {
          wranglerConfigOwnership: {
            arrays: { kv_namespaces: { key: "binding", values: ["SETTINGS"] } },
          },
        },
      },
      clientOutDir: "dist/client",
      rootDir,
    })

    expect(existsSync(configFile)).toBe(false)
    expect(existsSync(cloudflareDir)).toBe(false)
  })

  it("removes empty owned Cloudflare config arrays independently of unrelated keys", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const configFile = join(cloudflareDir, "wrangler.json")
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(configFile, `${JSON.stringify({
      kv_namespaces: [],
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`)

    await writeProviderDeploymentOutputs({
      cleanup: {
        cloudflare: {
          wranglerConfigOwnership: {
            arrays: { kv_namespaces: { key: "binding", values: ["SETTINGS"] } },
          },
        },
      },
      clientOutDir: "dist/client",
      rootDir,
    })

    expect(existsSync(cloudflareDir)).toBe(true)
    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toEqual({
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("preserves sibling Vercel functions and config keys", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const vercelDir = createDefaultVercelOutputRoot(rootDir)
    const queueFunctionDir = join(vercelDir, "functions/api/vitehub/queues/vercel/email/email.func")
    const queueFunctionFile = join(queueFunctionDir, "index.mjs")
    await mkdir(queueFunctionDir, { recursive: true })
    await writeFile(queueFunctionFile, "export default {}")
    await writeFile(join(vercelDir, "config.json"), `${JSON.stringify({
      crons: [{ path: "/api/vitehub/schedules/vercel/daily", schedule: "0 0 * * *" }],
      routes: [{ handle: "filesystem" }],
      version: 3,
    }, null, 2)}\n`)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
      },
    })

    await expect(readFile(queueFunctionFile, "utf8")).resolves.toBe("export default {}")
    await expect(readFile(join(vercelDir, "config.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      crons: [{ path: "/api/vitehub/schedules/vercel/daily", schedule: "0 0 * * *" }],
      version: 3,
    })
  })

  it("preserves host Vercel config when writing an isolated function", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const outputRoot = createDefaultVercelOutputRoot(rootDir)
    const config = {
      routes: [{ dest: "/__server", src: "/(.*)" }],
      version: 3,
    }
    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        function: { kind: "isolated", name: "__blob.func" },
      },
    })

    await expect(readFile(join(outputRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual(config)
    expect(existsSync(join(outputRoot, "functions", "__blob.func", ".vc-config.json"))).toBe(true)
  })

  it("replaces owned Vercel function config", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const outputRoot = createDefaultVercelOutputRoot(rootDir)
    const functionDir = join(outputRoot, "functions", "__blob.func")
    await mkdir(functionDir, { recursive: true })
    await writeFile(join(functionDir, ".vc-config.json"), '{"stale":true}\n', "utf8")

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        function: { kind: "isolated", name: "__blob.func" },
        functionConfig: { runtime: "nodejs22.x" },
      },
    })

    await expect(readFile(join(functionDir, ".vc-config.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      runtime: "nodejs22.x",
    })
  })

  it("serializes concurrent writes to shared provider config files", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")

    await Promise.all([
      writeProviderDeploymentOutputs({
        clientOutDir: "dist/client",
        cloudflare: {
          bundleEntry: join(rootDir, "blob.mjs"),
          bundleOptions: {},
          bundleOutfileName: "blob.js",
          wranglerConfig: {
            main: "blob.js",
            r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }],
          },
          wranglerConfigKeys: ["r2_buckets"],
        },
        rootDir,
        vercel: {
          bundleEntry: join(rootDir, "blob.mjs"),
          bundleOptions: {},
          config: {
            routes: [{ dest: "/blob", src: "/blob" }],
            version: 3,
          },
          configKeys: ["routes"],
          function: { kind: "isolated", name: "blob.func" },
        },
      }),
      writeProviderDeploymentOutputs({
        clientOutDir: "dist/client",
        cloudflare: {
          bundleEntry: join(rootDir, "database.mjs"),
          bundleOptions: {},
          bundleOutfileName: "database.js",
          wranglerConfig: {
            d1_databases: [{ binding: "DB", database_id: "database-id", database_name: "database" }],
            main: "database.js",
          },
          wranglerConfigKeys: ["d1_databases"],
        },
        rootDir,
        vercel: {
          bundleEntry: join(rootDir, "database.mjs"),
          bundleOptions: {},
          config: {
            crons: [{ path: "/database", schedule: "0 0 * * *" }],
            version: 3,
          },
          configKeys: ["crons"],
          function: { kind: "isolated", name: "database.func" },
        },
      }),
    ])

    await expect(readFile(join(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      d1_databases: [{ binding: "DB", database_id: "database-id", database_name: "database" }],
      r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }],
    })
    await expect(readFile(join(createDefaultVercelOutputRoot(rootDir), "config.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      crons: [{ path: "/database", schedule: "0 0 * * *" }],
      routes: [{ dest: "/blob", src: "/blob" }],
    })
  })

  it("writes Netlify functions with static config and preserves shared config keys", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultNetlifyOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    const netlifyDir = createDefaultNetlifyOutputRoot(rootDir)
    const siblingFunction = join(netlifyDir, "functions", "other.mjs")
    vi.mocked(bundleEsmEntry).mockClear()
    vi.mocked(bundleEsmEntry).mockImplementationOnce(async (_entryFile, outfile) => {
      await writeFile(outfile, "export default async function handler() {}\n", "utf8")
    })
    await mkdir(join(netlifyDir, "functions"), { recursive: true })
    await writeFile(siblingFunction, "export default {}")
    await writeFile(join(netlifyDir, "config.json"), `${JSON.stringify({
      headers: [{ for: "/old", values: { "x-old": "1" } }],
      images: { remote_images: ["https://images.example.com/.*"] },
      redirects: [{ from: "/old", status: 301, to: "/new" }],
    }, null, 2)}\n`)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      netlify: {
        config: {
          edge_functions: [{ function: "vitehub-edge", path: "/edge" }],
          headers: [{ for: "/api/*", values: { "x-vitehub": "1" } }],
          redirects: [{ from: "/docs", status: 200, to: "/docs/index.html" }],
        },
        configKeys: ["edge_functions", "headers", "redirects"],
        functions: [{
          bundleEntry: join(rootDir, "agent.mjs"),
          bundleOptions: { format: "esm", platform: "node" },
          config: {
            name: "vitehub-agent",
            nodeBundler: "esbuild",
            path: ["/api/_vitehub/agents/:agent/chat", "/api/_vitehub/agents/:agent/webhooks/:webhook"],
          },
          functionName: "vitehub-agent",
        }],
      },
      rootDir,
    })

    const functionFile = join(netlifyDir, "functions", "vitehub-agent.mjs")
    await expect(readFile(siblingFunction, "utf8")).resolves.toBe("export default {}")
    await expect(readFile(functionFile, "utf8")).resolves.toContain("export const config = {")
    await expect(readFile(functionFile, "utf8")).resolves.toContain("\"nodeBundler\": \"esbuild\"")
    expect(vi.mocked(bundleEsmEntry)).toHaveBeenCalledWith(
      join(rootDir, "agent.mjs"),
      `${functionFile}.pending`,
      { format: "esm", minifyIdentifiers: true, platform: "node", rootDir, signal: undefined },
    )
    await expect(readFile(join(netlifyDir, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      edge_functions: [{ function: "vitehub-edge", path: "/edge" }],
      headers: [{ for: "/api/*", values: { "x-vitehub": "1" } }],
      images: { remote_images: ["https://images.example.com/.*"] },
      redirects: [{ from: "/docs", status: 200, to: "/docs/index.html" }],
    })
  })

  it("removes owned Cloudflare config keys before merging new output", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(join(cloudflareDir, "wrangler.json"), `${JSON.stringify({
      d1_databases: [{ binding: "DB", database_id: "old" }],
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      cloudflare: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        wranglerConfig: {
          compatibility_date: "2026-01-01",
          main: "index.js",
        },
        wranglerConfigKeys: ["d1_databases"],
      },
      rootDir,
    })

    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      compatibility_date: "2026-01-01",
      main: "index.js",
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("removes owned Vercel config keys before merging new output", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const vercelDir = createDefaultVercelOutputRoot(rootDir)
    await mkdir(vercelDir, { recursive: true })
    await writeFile(join(vercelDir, "config.json"), `${JSON.stringify({
      crons: [{ path: "/api/vitehub/schedules/vercel/daily", schedule: "0 0 * * *" }],
      version: 3,
    }, null, 2)}\n`)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        configKeys: ["crons"],
      },
    })

    const parsedConfig: unknown = JSON.parse(await readFile(join(vercelDir, "config.json"), "utf8"))
    // SAFETY: writeProviderDeploymentOutputs writes a JSON object, whose owned properties are asserted below.
    const config = parsedConfig as { crons?: unknown, routes?: unknown, version?: unknown }
    expect(config.crons).toBeUndefined()
    expect(config.routes).toEqual([{ handle: "filesystem" }, { dest: "/__server", src: "/(.*)" }])
    expect(config.version).toBe(3)
  })

  it("cleans omitted provider-owned artifacts and config keys", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const workerFile = join(cloudflareDir, "worker.mjs")
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(workerFile, "export default {}")
    await writeFile(join(cloudflareDir, "wrangler.json"), `${JSON.stringify({
      triggers: { crons: ["0 0 * * *"] },
      workflows: [{ binding: "WORKFLOW", class_name: "Workflow", name: "workflow" }],
    }, null, 2)}\n`)

    await writeProviderDeploymentOutputs({
      cleanup: {
        cloudflare: {
          fileNames: ["worker.mjs"],
          wranglerConfigOwnership: { keys: ["workflows"] },
        },
      },
      clientOutDir: "dist/client",
      rootDir,
    })

    expect(existsSync(workerFile)).toBe(false)
    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("removes empty Cloudflare output roots after cleanup", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(join(cloudflareDir, "index.js"), "export default {}")
    await writeFile(join(cloudflareDir, "wrangler.json"), "{\"main\":\"index.js\"}\n")

    await writeProviderDeploymentOutputs({
      cleanup: {
        cloudflare: {
          fileNames: ["index.js"],
          wranglerConfigOwnership: { keys: ["main"] },
        },
      },
      clientOutDir: "dist/client",
      rootDir,
    })

    expect(existsSync(cloudflareDir)).toBe(false)
  })

  it("preserves previous provider output when replacement output fails", async () => {
    vi.mocked(bundleEsmEntry).mockRejectedValueOnce(new Error("bundle failed"))
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const workerFile = join(cloudflareDir, "worker.mjs")
    await mkdir(cloudflareDir, { recursive: true })
    await writeFile(workerFile, "export default {}")
    await writeFile(join(cloudflareDir, "wrangler.json"), "{\"main\":\"worker.mjs\"}\n")

    await expect(writeProviderDeploymentOutputs({
      cleanup: {
        cloudflare: {
          fileNames: ["worker.mjs"],
          wranglerConfigOwnership: { keys: ["main"] },
        },
      },
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "missing-entry.mjs"),
        bundleOptions: {},
        function: { kind: "isolated", name: "workflow.func" },
      },
    })).rejects.toThrow()

    await expect(readFile(workerFile, "utf8")).resolves.toBe("export default {}")
    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({ main: "worker.mjs" })
  })

  it("preserves the previous Vercel function when replacement bundling is cancelled", async () => {
    let bundlingStarted!: () => void
    const started = new Promise<void>(resolve => bundlingStarted = resolve)
    vi.mocked(bundleEsmEntry).mockImplementationOnce(async (_entry, outfile, options) => {
      await writeFile(outfile, "incomplete replacement")
      bundlingStarted()
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })
      })
    })
    const rootDir = await createTempProject()
    const {
      contributeProviderDeploymentOutput,
      createDefaultVercelOutputRoot,
      createProviderOutputCatalog,
      finalizeProviderDeploymentOutputs,
      resetProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const serverDir = join(createDefaultVercelOutputRoot(rootDir), "functions", "__server.func")
    const serverEntry = join(serverDir, "index.mjs")
    await mkdir(serverDir, { recursive: true })
    await writeFile(serverEntry, "valid function")
    await writeFile(join(serverDir, ".vc-config.json"), "{\"runtime\":\"nodejs22.x\"}\n")
    const catalog = createProviderOutputCatalog()
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => await write({
        clientOutDir: "dist/client",
        rootDir,
        vercel: {
          bundleEntry: join(rootDir, "entry.mjs"),
          bundleOptions: {},
        },
      }),
    })

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await started
    await resetProviderDeploymentOutputs(catalog)
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")

    await expect(readFile(serverEntry, "utf8")).resolves.toBe("valid function")
    await expect(readFile(join(serverDir, ".vc-config.json"), "utf8")).resolves.toBe("{\"runtime\":\"nodejs22.x\"}\n")
    expect(existsSync(`${serverDir}.pending`)).toBe(false)
    expect(existsSync(`${serverDir}.previous`)).toBe(false)
  })

  it("restores the previous Vercel function when companion output fails", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const serverDir = join(createDefaultVercelOutputRoot(rootDir), "functions", "__server.func")
    const outputRoot = createDefaultVercelOutputRoot(rootDir)
    const staticDir = join(outputRoot, "static")
    const serverEntry = join(serverDir, "index.mjs")
    await mkdir(serverDir, { recursive: true })
    await mkdir(staticDir, { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(serverEntry, "valid function")
    await writeFile(join(serverDir, ".vc-config.json"), "{\"runtime\":\"nodejs22.x\"}\n")
    await writeFile(join(outputRoot, "config.json"), "{\"version\":2}\n")
    await writeFile(join(staticDir, "index.html"), "old static")
    await writeFile(join(rootDir, "dist", "client", "index.html"), "new static")

    await expect(writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        config: new Date() as never,
      },
    })).rejects.toThrow("Provider output config must be a JSON object")

    await expect(readFile(serverEntry, "utf8")).resolves.toBe("valid function")
    await expect(readFile(join(serverDir, ".vc-config.json"), "utf8")).resolves.toBe("{\"runtime\":\"nodejs22.x\"}\n")
    await expect(readFile(join(outputRoot, "config.json"), "utf8")).resolves.toBe("{\"version\":2}\n")
    await expect(readFile(join(staticDir, "index.html"), "utf8")).resolves.toBe("old static")
    expect(existsSync(`${outputRoot}.pending`)).toBe(false)
    expect(existsSync(`${outputRoot}.previous`)).toBe(false)
  })

  it("restores all Vercel output when cancellation begins during companion writes", async () => {
    const rootDir = await createTempProject()
    const {
      contributeProviderDeploymentOutput,
      createDefaultVercelOutputRoot,
      createProviderOutputCatalog,
      finalizeProviderDeploymentOutputs,
      resetProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const outputRoot = createDefaultVercelOutputRoot(rootDir)
    const serverDir = join(outputRoot, "functions", "__server.func")
    const staticDir = join(outputRoot, "static")
    await mkdir(serverDir, { recursive: true })
    await mkdir(staticDir, { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(serverDir, "index.mjs"), "valid function")
    await writeFile(join(outputRoot, "config.json"), "{\"version\":2}\n")
    await writeFile(join(staticDir, "index.html"), "old static")
    await writeFile(join(rootDir, "dist", "client", "index.html"), "new static")
    const catalog = createProviderOutputCatalog()
    let reset: Promise<void> | undefined
    const config = new Proxy({ routes: [] }, {
      get(target, property, receiver) {
        if (property === "routes") reset = resetProviderDeploymentOutputs(catalog)
        return Reflect.get(target, property, receiver)
      },
    })
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => await write({
        clientOutDir: "dist/client",
        rootDir,
        vercel: {
          bundleEntry: join(rootDir, "entry.mjs"),
          bundleOptions: {},
          config,
        },
      }),
    })

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")
    await reset

    await expect(readFile(join(serverDir, "index.mjs"), "utf8")).resolves.toBe("valid function")
    await expect(readFile(join(outputRoot, "config.json"), "utf8")).resolves.toBe("{\"version\":2}\n")
    await expect(readFile(join(staticDir, "index.html"), "utf8")).resolves.toBe("old static")
    expect(existsSync(`${outputRoot}.pending`)).toBe(false)
    expect(existsSync(`${outputRoot}.previous`)).toBe(false)
  })

  it("restores all Cloudflare output when cancellation begins during companion writes", async () => {
    const rootDir = await createTempProject()
    const {
      contributeProviderDeploymentOutput,
      createDefaultCloudflareOutputRoot,
      createProviderOutputCatalog,
      finalizeProviderDeploymentOutputs,
      resetProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
    const clientDir = join(rootDir, "dist", "client")
    const staticDir = join(rootDir, "public")
    await mkdir(outputRoot, { recursive: true })
    await mkdir(clientDir, { recursive: true })
    await mkdir(staticDir, { recursive: true })
    await writeFile(join(outputRoot, "index.js"), "valid worker")
    await writeFile(join(outputRoot, "wrangler.json"), "{\"main\":\"index.js\",\"name\":\"old\"}\n")
    await writeFile(join(outputRoot, "metadata.json"), "old metadata")
    await writeFile(join(staticDir, "index.html"), "old static")
    await writeFile(join(clientDir, "index.html"), "new static")
    const catalog = createProviderOutputCatalog()
    let reset: Promise<void> | undefined
    const wranglerConfig = new Proxy({ main: "index.js", name: "new" }, {
      ownKeys(target) {
        reset = resetProviderDeploymentOutputs(catalog)
        return Reflect.ownKeys(target)
      },
    })
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => await write({
        clientOutDir: "dist/client",
        cloudflare: {
          bundleEntry: join(rootDir, "entry.mjs"),
          bundleOptions: {},
          files: { "metadata.json": "new metadata" },
          staticOutputDir: staticDir,
          wranglerConfig,
        },
        rootDir,
      }),
    })

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")
    await reset

    await expect(readFile(join(outputRoot, "index.js"), "utf8")).resolves.toBe("valid worker")
    await expect(readFile(join(outputRoot, "wrangler.json"), "utf8")).resolves.toBe("{\"main\":\"index.js\",\"name\":\"old\"}\n")
    await expect(readFile(join(outputRoot, "metadata.json"), "utf8")).resolves.toBe("old metadata")
    await expect(readFile(join(staticDir, "index.html"), "utf8")).resolves.toBe("old static")
    expect(existsSync(`${outputRoot}.previous`)).toBe(false)
  })

  it("settles every started provider write before rejecting", async () => {
    let finishVercelWrite: (() => void) | undefined
    vi.mocked(bundleEsmEntry).mockImplementation(async (_entry, outfile) => {
      if (outfile.endsWith("index.js.pending")) throw new Error("cloudflare failed")
      await new Promise<void>((resolve) => {
        finishVercelWrite = resolve
      })
    })
    const rootDir = await createTempProject()
    const { writeProviderDeploymentOutputs } = await import("../src/build/deployment-output.ts")
    let rejected = false

    const output = writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      cloudflare: {
        bundleEntry: join(rootDir, "cloudflare-entry.mjs"),
        bundleOptions: {},
        wranglerConfig: {},
      },
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "vercel-entry.mjs"),
        bundleOptions: {},
      },
    })
    const failure = output.then(() => undefined, (error: unknown) => {
      rejected = true
      return error
    })

    await vi.waitFor(() => expect(finishVercelWrite).toBeTypeOf("function"))
    expect(rejected).toBe(false)
    finishVercelWrite?.()
    await expect(failure).resolves.toEqual(new Error("cloudflare failed"))
  })

  it("resolves cleanup ownership after preceding provider writes", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const providerWrite = writeProviderDeploymentOutputs({
      cloudflare: {
        files: { "index.js": "export default {}\n" },
        wranglerConfig: { main: "index.js" },
      },
      clientOutDir: "dist/client",
      rootDir,
    })
    let observedConfig: string | undefined
    let observedWrapper: string | undefined
    const cleanup = writeProviderDeploymentOutputs({
      cleanup: {
        cloudflare: async () => {
          observedConfig = await readFile(join(cloudflareDir, "wrangler.json"), "utf8")
          observedWrapper = await readFile(join(cloudflareDir, "index.js"), "utf8")
          return { fileNames: ["index.js"], wranglerConfigOwnership: { keys: ["main"] } }
        },
      },
      clientOutDir: "dist/client",
      rootDir,
    })

    await Promise.all([providerWrite, cleanup])

    expect(observedConfig && JSON.parse(observedConfig)).toEqual({ main: "index.js" })
    expect(observedWrapper).toBe("export default {}\n")
    expect(existsSync(cloudflareDir)).toBe(false)
  })

  it("resolves Vercel cleanup ownership after preceding provider writes", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const functionDir = join(createDefaultVercelOutputRoot(rootDir), "functions", "blob.func")
    const providerWrite = writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "blob.mjs"),
        bundleOptions: {},
        function: { kind: "isolated", name: "blob.func" },
      },
    })
    let observedFunction = false
    const cleanup = writeProviderDeploymentOutputs({
      cleanup: {
        vercel: async () => {
          observedFunction = existsSync(functionDir)
          return [{ serverFunctionName: "blob.func" }]
        },
      },
      clientOutDir: "dist/client",
      rootDir,
    })

    await Promise.all([providerWrite, cleanup])

    expect(observedFunction).toBe(true)
    expect(existsSync(functionDir)).toBe(false)
  })

  it("rejects Cloudflare companion files that conflict with the bundle outfile", async () => {
    const rootDir = await createTempProject()
    const { writeProviderDeploymentOutputs } = await import("../src/build/deployment-output.ts")

    await expect(writeProviderDeploymentOutputs({
      cloudflare: {
        bundleEntry: join(rootDir, "worker.ts"),
        bundleOptions: {},
        files: { "index.js": "export default {}\n" },
        wranglerConfig: {},
      },
      clientOutDir: "dist/client",
      rootDir,
    })).rejects.toThrow("Cloudflare output file conflicts with bundle outfile")
  })

  it("copies Vercel function runtime package dependency closures", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
    } = await import("../src/build/deployment-output.ts")
    const { copyVercelFunctionRuntimePackages } = await import("../src/build/vercel-runtime-packages.ts")
    const outputRoot = createDefaultVercelOutputRoot(rootDir)
    const serverDir = join(outputRoot, "functions", "__server.func")
    const runtimePackageDir = await writePackage(rootDir, "@scope/runtime", {
      dependencies: { "runtime-dependency": "1.0.0" },
      exports: { ".": "./index.js" },
      peerDependencies: {
        "optional-peer": "1.0.0",
        "runtime-peer": "1.0.0",
      },
      peerDependenciesMeta: {
        "optional-peer": { optional: true },
      },
    })
    await writePackage(rootDir, "runtime-dependency", {
      peerDependencies: { "transitive-peer": "1.0.0" },
    })
    await writePackage(rootDir, "runtime-peer")
    await writePackage(rootDir, "transitive-peer")
    await writePackage(rootDir, "optional-peer")
    await writePackage(runtimePackageDir, "nested-ignored")
    await writeFile(join(runtimePackageDir, "index.js"), "import './runtime-file.js'\nexport default {}\n", "utf8")
    await writeFile(join(runtimePackageDir, "runtime-file.js"), "export const runtime = true\n", "utf8")
    await writeFile(join(runtimePackageDir, "unused-file.js"), "export const unused = true\n", "utf8")
    await mkdir(serverDir, { recursive: true })

    await copyVercelFunctionRuntimePackages({
      packages: [{ includePeerDependencies: true, name: "@scope/runtime" }],
      rootDir,
    })

    await expect(readFile(join(serverDir, "node_modules", "@scope", "runtime", "package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      name: "@scope/runtime",
    })
    expect(existsSync(join(serverDir, "node_modules", "@scope", "runtime", "runtime-file.js"))).toBe(true)
    expect(existsSync(join(serverDir, "node_modules", "@scope", "runtime", "unused-file.js"))).toBe(false)
    expect(existsSync(join(serverDir, "node_modules", "@scope", "runtime", "node_modules", "nested-ignored"))).toBe(false)
    expect(existsSync(join(serverDir, "node_modules", "runtime-dependency", "package.json"))).toBe(true)
    expect(existsSync(join(serverDir, "node_modules", "runtime-peer", "package.json"))).toBe(true)
    expect(existsSync(join(serverDir, "node_modules", "transitive-peer", "package.json"))).toBe(true)
    expect(existsSync(join(serverDir, "node_modules", "optional-peer", "package.json"))).toBe(false)
  })

  it("preserves Vercel runtime packages when cancellation interrupts their replacement", async () => {
    vi.resetModules()
    let releaseTrace: (() => void) | undefined
    const traceStarted = Promise.withResolvers<void>()
    vi.doMock("@vercel/nft", () => ({
      nodeFileTrace: vi.fn(async () => {
        traceStarted.resolve()
        await new Promise<void>((resolve) => {
          releaseTrace = resolve
        })
        return { fileList: new Set(["index.js"]) }
      }),
    }))

    try {
      const rootDir = await createTempProject()
      const { createDefaultVercelOutputRoot } = await import("../src/build/deployment-output.ts")
      const { copyVercelFunctionRuntimePackages } = await import("../src/build/vercel-runtime-packages.ts")
      const serverDir = join(createDefaultVercelOutputRoot(rootDir), "functions", "__server.func")
      const existingPackage = join(serverDir, "node_modules", "runtime-package")
      await writePackage(rootDir, "runtime-package", { exports: { ".": "./index.js" } })
      await writeFile(join(rootDir, "node_modules", "runtime-package", "index.js"), "export const version = 'new'\n", "utf8")
      await mkdir(existingPackage, { recursive: true })
      await writeFile(join(existingPackage, "index.js"), "export const version = 'old'\n", "utf8")
      const controller = new AbortController()

      const copying = copyVercelFunctionRuntimePackages({
        packages: [{ name: "runtime-package" }],
        rootDir,
        signal: controller.signal,
      })
      await traceStarted.promise
      controller.abort()
      releaseTrace?.()

      await expect(copying).rejects.toHaveProperty("name", "AbortError")
      await expect(readFile(join(existingPackage, "index.js"), "utf8")).resolves.toBe("export const version = 'old'\n")
    }
    finally {
      vi.doUnmock("@vercel/nft")
      vi.resetModules()
    }
  })

  it("rolls back Vercel runtime packages when cancellation follows the live swap", async () => {
    const rootDir = await createTempProject()
    const { createDefaultVercelOutputRoot } = await import("../src/build/deployment-output.ts")
    const { copyVercelFunctionRuntimePackages } = await import("../src/build/vercel-runtime-packages.ts")
    const serverDir = join(createDefaultVercelOutputRoot(rootDir), "functions", "__server.func")
    const existingPackage = join(serverDir, "node_modules", "runtime-package")
    await writePackage(rootDir, "runtime-package")
    await writeFile(join(rootDir, "node_modules", "runtime-package", "index.js"), "export const version = 'new'\n", "utf8")
    await mkdir(existingPackage, { recursive: true })
    await writeFile(join(existingPackage, "index.js"), "export const version = 'old'\n", "utf8")
    let checks = 0
    const signal = {
      throwIfAborted() {
        checks += 1
        if (checks === 3) throw new DOMException("cancelled", "AbortError")
      },
    } as AbortSignal

    await expect(copyVercelFunctionRuntimePackages({
      packages: [{ name: "runtime-package" }],
      rootDir,
      signal,
    })).rejects.toHaveProperty("name", "AbortError")

    await expect(readFile(join(existingPackage, "index.js"), "utf8")).resolves.toBe("export const version = 'old'\n")
  })

  it("copies runtime packages into an explicit Node output", async () => {
    const rootDir = await createTempProject()
    const outputNodeModules = join(rootDir, ".output", "server", "node_modules")
    const runtimePackageDir = await writePackage(rootDir, "runtime-package", {
      dependencies: { "runtime-dependency": "1.0.0" },
      exports: { ".": "./index.js" },
      type: "module",
    })
    await writePackage(rootDir, "runtime-dependency")
    await writeFile(join(runtimePackageDir, "index.js"), "import 'runtime-dependency'\nconsole.log('runtime-ready')\n", "utf8")
    const { copyNodeRuntimePackages } = await import("../src/build/vercel-runtime-packages.ts")

    await copyNodeRuntimePackages({
      outputNodeModules,
      packages: [{ name: "runtime-package" }],
      rootDir,
    })

    expect(existsSync(join(outputNodeModules, "runtime-package", "index.js"))).toBe(true)
    expect(existsSync(join(outputNodeModules, "runtime-dependency", "package.json"))).toBe(true)
    expect(spawnSync(process.execPath, [join(outputNodeModules, "runtime-package", "index.js")], { encoding: "utf8" })).toMatchObject({
      status: 0,
      stdout: "runtime-ready\n",
    })
  })

  it("preserves nested dependency versions in copied Vercel runtime packages", async () => {
    const rootDir = await createTempProject()
    const { createDefaultVercelOutputRoot } = await import("../src/build/deployment-output.ts")
    const { copyVercelFunctionRuntimePackageDirectories } = await import("../src/build/vercel-runtime-package-copy.ts")
    const serverDir = join(createDefaultVercelOutputRoot(rootDir), "functions", "__server.func")
    const firstDir = await writePackage(rootDir, "first-runtime", { dependencies: { shared: "1.0.0" } })
    await writePackage(rootDir, "shared", { version: "2.0.0" })
    await writePackage(firstDir, "shared", { version: "1.0.0" })
    await mkdir(serverDir, { recursive: true })

    await copyVercelFunctionRuntimePackageDirectories({
      packages: [{ name: "first-runtime" }, { name: "shared" }],
      rootDir,
    })

    await expect(readFile(join(serverDir, "node_modules", "first-runtime", "node_modules", "shared", "package.json"), "utf8").then(JSON.parse)).resolves.toHaveProperty("version", "1.0.0")
    await expect(readFile(join(serverDir, "node_modules", "shared", "package.json"), "utf8").then(JSON.parse)).resolves.toHaveProperty("version", "2.0.0")
  })

  it("resolves import-only Vercel runtime packages from an explicit package location", async () => {
    const rootDir = await createTempProject()
    const packageRoot = await createTempProject()
    const sourceRoot = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
    } = await import("../src/build/deployment-output.ts")
    const { copyVercelFunctionRuntimePackages } = await import("../src/build/vercel-runtime-packages.ts")
    const serverDir = join(createDefaultVercelOutputRoot(rootDir), "functions", "__server.func")
    const sourcePackageDir = await writePackage(sourceRoot, "import-only-runtime", {
      exports: { ".": { import: "./index.js" } },
    })
    await mkdir(join(packageRoot, "node_modules"), { recursive: true })
    await symlink(sourcePackageDir, join(packageRoot, "node_modules", "import-only-runtime"), "dir")
    await mkdir(serverDir, { recursive: true })

    await copyVercelFunctionRuntimePackages({
      packages: [{ name: "import-only-runtime", resolveFrom: join(packageRoot, "package.json") }],
      rootDir,
    })

    expect(existsSync(join(serverDir, "node_modules", "import-only-runtime", "index.js"))).toBe(true)
  })

  it("ignores traced Vercel runtime package directory entries", async () => {
    vi.resetModules()
    vi.doMock("@vercel/nft", () => ({
      nodeFileTrace: vi.fn(async () => ({ fileList: new Set([".", "index.js"]) })),
    }))

    try {
      const rootDir = await createTempProject()
      const {
        createDefaultVercelOutputRoot,
      } = await import("../src/build/deployment-output.ts")
      const { copyVercelFunctionRuntimePackages } = await import("../src/build/vercel-runtime-packages.ts")
      const outputRoot = createDefaultVercelOutputRoot(rootDir)
      const serverDir = join(outputRoot, "functions", "__server.func")
      await writePackage(rootDir, "runtime-with-directory-entry", {
        exports: { ".": "./index.js" },
      })
      await mkdir(serverDir, { recursive: true })

      await copyVercelFunctionRuntimePackages({
        packages: [{ name: "runtime-with-directory-entry" }],
        rootDir,
      })

      expect(existsSync(join(serverDir, "node_modules", "runtime-with-directory-entry", "index.js"))).toBe(true)
    }
    finally {
      vi.doUnmock("@vercel/nft")
    }
  })

  it("skips optional Vercel function runtime packages when they are not installed", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultVercelOutputRoot,
    } = await import("../src/build/deployment-output.ts")
    const { copyVercelFunctionRuntimePackages } = await import("../src/build/vercel-runtime-packages.ts")
    await mkdir(join(createDefaultVercelOutputRoot(rootDir), "functions", "__server.func"), { recursive: true })

    await expect(copyVercelFunctionRuntimePackages({
      packages: [{ name: "missing-runtime", optional: true }],
      rootDir,
    })).resolves.toBeUndefined()
  })
})
