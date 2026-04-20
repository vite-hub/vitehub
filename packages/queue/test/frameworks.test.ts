import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

interface NitroHarnessOptions {
  imports?: false | { imports?: unknown[] }
  plugins?: string[]
  preset?: string
  queue?: unknown
  scanDirs?: string[]
}

interface NitroStub {
  hooks: {
    hook: (name: string, fn: (...args: any[]) => void | Promise<void>) => () => void
  }
  options: {
    _config?: {
      imports?: false | { imports?: unknown[] }
    }
    alias: Record<string, string>
    buildDir: string
    cloudflare?: {
      wrangler?: {
        queues?: {
          consumers?: Array<{ queue: string }>
          producers?: Array<{ binding: string, queue: string }>
        }
      }
    }
    imports?: false | { imports?: unknown[], presets?: unknown[] }
    output: { dir: string }
    plugins: string[]
    preset?: string
    queue?: unknown
    rootDir: string
    runtimeConfig?: unknown
    scanDirs: string[]
  }
  logger: {
    error: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
  }
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createNitroStub(options: NitroHarnessOptions = {}): Promise<NitroStub> {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
  const buildDir = join(rootDir, ".nitro")
  const serverDir = join(rootDir, "server")

  directories.push(rootDir)
  await mkdir(join(serverDir, "queues"), { recursive: true })
  await writeFile(join(serverDir, "queues", "welcome.ts"), "export default null\n", "utf8")

  const hookMap = new Map<string, (...args: any[]) => void | Promise<void>>()
  return {
    hooks: {
      hook(name, fn) {
        hookMap.set(name, fn)
        return () => {
          hookMap.delete(name)
        }
      },
    },
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    options: {
      _config: {
        imports: options.imports,
      },
      alias: {},
      buildDir,
      imports: options.imports,
      output: { dir: join(rootDir, ".output") },
      plugins: options.plugins || [],
      preset: options.preset || "cloudflare_module",
      queue: options.queue,
      rootDir,
      scanDirs: options.scanDirs || [serverDir],
    },
  }
}

describe("hubQueue", () => {
  it("exposes the Nitro module on the Vite plugin", async () => {
    const { hubQueue } = await import("../src/vite.ts")
    const plugin = hubQueue()

    expect(plugin.nitro.name).toBe("@vitehub/queue")
  })
})

describe("Nitro module", () => {
  it("wires runtime config, aliases, plugins, imports, and queue bindings", async () => {
    const nitro = await createNitroStub({
      preset: "cloudflare_module",
      queue: {
        provider: "cloudflare",
      },
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig).toMatchObject({
      hosting: "cloudflare_module",
      queue: {
        provider: "cloudflare",
      },
    })
    expect(nitro.options.alias["@vitehub/queue"]).toContain("/packages/queue/src/index.ts")
    expect(nitro.options.alias["#vitehub/queue/registry"]).toContain("/.nitro/.vitehub/queue/nitro-registry.mjs")
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.imports).toMatchObject({
      presets: expect.arrayContaining([
        expect.objectContaining({
          from: "@vitehub/queue",
          imports: expect.arrayContaining(["defineQueue", "runQueue"]),
        }),
      ]),
    })
    expect(nitro.options.cloudflare?.wrangler?.queues).toEqual({
      consumers: [{ queue: "queue--77656c636f6d65" }],
      producers: [{ binding: "QUEUE_77656C636F6D65", queue: "queue--77656c636f6d65" }],
    })
  })

  it("respects explicit imports=false", async () => {
    const nitro = await createNitroStub({
      imports: false,
      queue: {
        provider: "vercel",
      },
      preset: "vercel",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.imports).toBe(false)
  })

  it("discovers server/queues names from Nitro scan roots", async () => {
    const nitro = await createNitroStub({
      preset: "vercel",
      queue: {
        provider: "vercel",
      },
    })
    await mkdir(join(nitro.options.scanDirs[0]!, "queues", "emails"), { recursive: true })
    await writeFile(join(nitro.options.scanDirs[0]!, "queues", "emails", "index.ts"), "export default null\n", "utf8")
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    const registryPath = nitro.options.alias["#vitehub/queue/registry"]
    expect(await readFile(registryPath, "utf8")).toContain('"emails": async () => import(')
  })
})
