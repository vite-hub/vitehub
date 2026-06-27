import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/build/esbuild.ts", () => ({
  bundleEsmEntry: vi.fn(async () => undefined),
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
      wranglerArrayMergeKeys: { kv_namespaces: "binding" },
      wranglerConfig: {
        kv_namespaces: [{ binding: "SETTINGS", id: "new-namespace" }],
      },
    })

    await expect(readFile(join(cloudflareDir, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      kv_namespaces: [
        { binding: "MANUAL", id: "manual-namespace" },
        { binding: "SETTINGS", id: "new-namespace" },
      ],
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
      functionFile,
      { format: "esm", minifyIdentifiers: true, platform: "node" },
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

    const config = await readFile(join(vercelDir, "config.json"), "utf8").then(JSON.parse) as { crons?: unknown, routes?: unknown, version?: unknown }
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
          bundleOutfileName: "worker.mjs",
          wranglerConfigKeys: ["workflows"],
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
