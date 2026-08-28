import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"
import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/cloudflare"

const tempDirs: string[] = []
const execFileAsync = promisify(execFile)
const kvBindingsFile = ".vitehub-kv-bindings.json"

async function createConsumerRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-kv-vite-"))
  tempDirs.push(rootDir)

  await mkdir(join(rootDir, "node_modules", "@vite-hub"), { recursive: true })
  await symlink(resolve(import.meta.dirname, ".."), join(rootDir, "node_modules", "@vite-hub", "kv"), "dir")
  await mkdir(join(rootDir, "node_modules", "preserved-external"), { recursive: true })
  await writeFile(join(rootDir, "node_modules", "preserved-external", "package.json"), JSON.stringify({
    exports: "./index.js",
    name: "preserved-external",
    type: "module",
  }))
  await writeFile(join(rootDir, "node_modules", "preserved-external", "index.js"), "")
  await mkdir(join(rootDir, "src"), { recursive: true })
  await writeFile(join(rootDir, "package.json"), JSON.stringify({
    name: "vitehub-kv-vite-fixture",
    private: true,
    type: "module",
  }, null, 2))
  await writeFile(join(rootDir, "src", "worker.ts"), [
    `import { kv } from "@vite-hub/kv"`,
    ``,
    `export default {`,
    `  async fetch() {`,
    `    const [writeError] = await kv.set("settings", { ok: true })`,
    `    if (writeError) throw writeError`,
    `    const [readError, settings] = await kv.get("settings")`,
    `    if (readError) throw readError`,
    `    return Response.json(settings)`,
    `  },`,
    `}`,
    ``,
  ].join("\n"))

  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function readOutput(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
  return (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n")
}

describe("KV Vite output", () => {
  it("runs an fs-lite server bundle without the optional Upstash peer", async () => {
    const rootDir = await createConsumerRoot()
    const entry = join(rootDir, "src", "worker.ts")
    const [{ build }, { hubKv }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])
    await writeFile(entry, [
      `import "preserved-external"`,
      `import { kv } from "@vite-hub/kv"`,
      `export default async () => {`,
      `  const [error, value] = await kv.get("proof")`,
      `  if (error) throw error`,
      `  return value`,
      `}`,
      ``,
    ].join("\n"))

    await build({
      appType: "custom",
      build: {
        outDir: "dist",
        rollupOptions: {
          external: ["preserved-external"],
          input: entry,
          output: { entryFileNames: "worker.js" },
        },
        ssr: entry,
      },
      configFile: false,
      kv: { base: join(rootDir, ".data", "kv"), driver: "fs-lite" },
      logLevel: "silent",
      plugins: [
        hubKv(),
        {
          name: "missing-upstash-peer",
          resolveId(id) {
            if (id === "@upstash/redis") return "\0missing-upstash-peer"
          },
          load(id) {
            if (id === "\0missing-upstash-peer") return "export default {}"
          },
        },
      ],
      root: rootDir,
    })

    const output = await readOutput(join(rootDir, "dist"))
    const worker = await import(pathToFileURL(join(rootDir, "dist", "worker.js")).href) as {
      default: () => Promise<unknown>
    }

    expect(output).toContain(`import "preserved-external"`)
    expect(output).not.toContain(`from "@upstash/redis"`)
    expect(output).toContain(`import("@vite-hub/kv/runtime/upstash-driver")`)
    expect(output).not.toContain("__vite-optional-peer-dep")
    expect(output).not.toContain(`from "unstorage/drivers/fs-lite"`)
    await expect(worker.default()).resolves.toBeNull()
  })

  it("bundles selected runtime config into server output", async () => {
    const rootDir = await createConsumerRoot()
    const entry = join(rootDir, "src", "worker.ts")
    const [{ build }, { hubKv }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])

    await build({
      appType: "custom",
      build: {
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "worker.js" },
        },
        ssr: entry,
      },
      configFile: false,
      kv: {
        binding: "KV_CUSTOM",
        driver: "cloudflare-kv-binding",
        namespaceId: "namespace-id",
      },
      logLevel: "silent",
      plugins: [hubKv()],
      root: rootDir,
    })

    const output = await readOutput(join(rootDir, "dist"))

    expect(output).not.toContain(`from "@vite-hub/kv"`)
    expect(output).not.toContain(`from "unstorage`)
    expect(output).not.toContain("#vitehub/kv/config")
    expect(output).not.toContain("@upstash/redis")
    expect(output).toContain("cloudflare-kv-binding")
    expect(output).toContain("KV_CUSTOM")
  })

  it("merges configured Cloudflare KV namespaces into provider output", async () => {
    const rootDir = await createConsumerRoot()
    const entry = join(rootDir, "src", "worker.ts")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
      d1_databases: [{ binding: "DB", database_id: "database-id", database_name: "app" }],
      kv_namespaces: [{ binding: "OLD", id: "old-namespace" }],
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`, "utf8")
    const [{ build }, { hubKv }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])

    await build({
      appType: "custom",
      build: {
        emptyOutDir: false,
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "worker.js" },
        },
        ssr: entry,
      },
      configFile: false,
      kv: {
        binding: "SETTINGS",
        driver: "cloudflare-kv-binding",
        namespaceId: "11111111111111111111111111111111",
      },
      logLevel: "silent",
      plugins: [hubKv()],
      root: rootDir,
    })

    const wrangler = JSON.parse(await readFile(join(cloudflareOutputRoot, "wrangler.json"), "utf8"))

    expect(existsSync(join(cloudflareOutputRoot, "index.js"))).toBe(false)
    expect(wrangler).toEqual({
      d1_databases: [{ binding: "DB", database_id: "database-id", database_name: "app" }],
      kv_namespaces: [
        { binding: "OLD", id: "old-namespace" },
        { binding: "SETTINGS", id: "11111111111111111111111111111111" },
      ],
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("preserves sibling Cloudflare provider output from closeBundle hooks", async () => {
    const rootDir = await createConsumerRoot()
    const entry = join(rootDir, "src", "worker.ts")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    const [{ build }, { hubKv }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])

    await build({
      appType: "custom",
      build: {
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "worker.js" },
        },
        ssr: entry,
      },
      configFile: false,
      kv: {
        binding: "SETTINGS",
        driver: "cloudflare-kv-binding",
        namespaceId: "22222222222222222222222222222222",
      },
      logLevel: "silent",
      plugins: [
        hubKv(),
        {
          name: "late-cloudflare-provider-output",
          async closeBundle() {
            await new Promise(resolve => setTimeout(resolve, 10))
            await mkdir(cloudflareOutputRoot, { recursive: true })
            await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
              d1_databases: [{ binding: "DB", database_id: "database-id", database_name: "app" }],
              kv_namespaces: [{ binding: "MANUAL", id: "manual-namespace" }],
            }, null, 2)}\n`, "utf8")
          },
        },
      ],
      root: rootDir,
    })

    const wrangler = JSON.parse(await readFile(join(cloudflareOutputRoot, "wrangler.json"), "utf8"))

    expect(wrangler).toEqual({
      d1_databases: [{ binding: "DB", database_id: "database-id", database_name: "app" }],
      kv_namespaces: [
        { binding: "MANUAL", id: "manual-namespace" },
        { binding: "SETTINGS", id: "22222222222222222222222222222222" },
      ],
    })
  })

  it("leaves existing Cloudflare KV namespaces alone without a Cloudflare KV contribution", async () => {
    const rootDir = await createConsumerRoot()
    const entry = join(rootDir, "src", "worker.ts")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
      kv_namespaces: [{ binding: "MANUAL", id: "manual-namespace" }],
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`, "utf8")
    const [{ build }, { hubKv }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])

    await build({
      appType: "custom",
      build: {
        emptyOutDir: false,
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "worker.js" },
        },
        ssr: entry,
      },
      configFile: false,
      kv: { driver: "fs-lite" },
      logLevel: "silent",
      plugins: [hubKv()],
      root: rootDir,
    })

    const wrangler = JSON.parse(await readFile(join(cloudflareOutputRoot, "wrangler.json"), "utf8"))

    expect(wrangler).toEqual({
      kv_namespaces: [{ binding: "MANUAL", id: "manual-namespace" }],
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("replaces stale generated Cloudflare KV namespaces without deleting manual bindings", async () => {
    const rootDir = await createConsumerRoot()
    const entry = join(rootDir, "src", "worker.ts")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
      kv_namespaces: [
        { binding: "MANUAL", id: "manual-namespace" },
        { binding: "OLD", id: "old-namespace" },
      ],
    }, null, 2)}\n`, "utf8")
    await writeFile(join(cloudflareOutputRoot, kvBindingsFile), `${JSON.stringify(["OLD"], null, 2)}\n`, "utf8")
    const [{ build }, { hubKv }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])

    await build({
      appType: "custom",
      build: {
        emptyOutDir: false,
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "worker.js" },
        },
        ssr: entry,
      },
      configFile: false,
      kv: {
        binding: "NEW",
        driver: "cloudflare-kv-binding",
        namespaceId: "new-namespace",
      },
      logLevel: "silent",
      plugins: [hubKv()],
      root: rootDir,
    })

    const wrangler = JSON.parse(await readFile(join(cloudflareOutputRoot, "wrangler.json"), "utf8"))

    expect(wrangler.kv_namespaces).toEqual([
      { binding: "MANUAL", id: "manual-namespace" },
      { binding: "NEW", id: "new-namespace" },
    ])
    await expect(readFile(join(cloudflareOutputRoot, kvBindingsFile), "utf8").then(JSON.parse)).resolves.toEqual(["NEW"])
  })

  it("removes stale generated Cloudflare KV namespaces when KV stops contributing", async () => {
    const rootDir = await createConsumerRoot()
    const entry = join(rootDir, "src", "worker.ts")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
      kv_namespaces: [
        { binding: "MANUAL", id: "manual-namespace" },
        { binding: "OLD", id: "old-namespace" },
      ],
    }, null, 2)}\n`, "utf8")
    await writeFile(join(cloudflareOutputRoot, kvBindingsFile), `${JSON.stringify(["OLD"], null, 2)}\n`, "utf8")
    const [{ build }, { hubKv }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])

    await build({
      appType: "custom",
      build: {
        emptyOutDir: false,
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "worker.js" },
        },
        ssr: entry,
      },
      configFile: false,
      kv: { driver: "fs-lite" },
      logLevel: "silent",
      plugins: [hubKv()],
      root: rootDir,
    })

    const wrangler = JSON.parse(await readFile(join(cloudflareOutputRoot, "wrangler.json"), "utf8"))

    expect(wrangler.kv_namespaces).toEqual([{ binding: "MANUAL", id: "manual-namespace" }])
    expect(existsSync(join(cloudflareOutputRoot, kvBindingsFile))).toBe(false)
  })
})

describe("KV source type visibility", () => {
  it("typechecks source consumers that resolve @vite-hub/kv to package source", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-kv-source-types-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "package.json"), JSON.stringify({ type: "module" }))
    await writeFile(join(rootDir, "src", "consumer.ts"), [
      `import { kv } from "@vite-hub/kv"`,
      ``,
      `const [error] = await kv.get("settings")`,
      `if (error) throw error`,
      ``,
    ].join("\n"))

    const repoRoot = resolve(import.meta.dirname, "../../..")
    await writeFile(join(rootDir, "tsconfig.json"), JSON.stringify({
      extends: join(repoRoot, "tsconfig.json"),
      compilerOptions: {
        baseUrl: repoRoot,
        paths: {
          "@vite-hub/internal/*": ["packages/internal/src/*.ts"],
          "@vite-hub/kv": ["packages/kv/src/index.ts"],
        },
        typeRoots: [join(repoRoot, "node_modules", "@types")],
      },
      files: ["src/consumer.ts"],
    }, null, 2))

    try {
      await execFileAsync(resolve(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", join(rootDir, "tsconfig.json")])
    }
    catch (error) {
      const output = (error as { stderr?: string, stdout?: string }).stdout || (error as { stderr?: string, stdout?: string }).stderr
      throw new Error(output)
    }
  })
})
