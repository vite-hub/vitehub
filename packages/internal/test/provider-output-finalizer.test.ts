import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  contributeProviderDeploymentOutput,
  createDefaultCloudflareOutputRoot,
  finalizeProviderDeploymentOutputs,
  resetProviderDeploymentOutputs,
} from "../src/build/deployment-output.ts"
import { createProviderOutputCatalog } from "../src/build/provider-output-catalog.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-output-finalizer-"))
  tempDirs.push(rootDir)
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Provider Output finalizer", () => {
  it("settles contributions in stable owner order and replaces duplicates", async () => {
    const catalog = createProviderOutputCatalog()
    const writes: string[] = []
    const rootDir = await createTempProject()
    const contribute = (owner: "agent" | "blob" | "database", value = owner) => {
      contributeProviderDeploymentOutput(catalog, {
        owner,
        rootDir,
        write: async () => {
          writes.push(value)
        },
      })
    }

    contribute("blob", "stale")
    contribute("agent")
    contribute("database")
    contribute("blob", "current")
    await finalizeProviderDeploymentOutputs(catalog)

    expect(writes).toEqual(["agent", "database", "current"])
  })

  it("clears settled contributions between repeat builds", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const write = vi.fn(async () => undefined)

    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write })
    await finalizeProviderDeploymentOutputs(catalog)
    await finalizeProviderDeploymentOutputs(catalog)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write })
    await finalizeProviderDeploymentOutputs(catalog)

    expect(write).toHaveBeenCalledTimes(2)
  })

  it("drains contributions registered during active finalization", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const writes: string[] = []
    let releaseFirst!: () => void
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => {
        writes.push("agent")
        await new Promise<void>(resolve => releaseFirst = resolve)
      },
    })

    const firstFinalization = finalizeProviderDeploymentOutputs(catalog)
    await vi.waitFor(() => expect(writes).toEqual(["agent"]))
    contributeProviderDeploymentOutput(catalog, {
      owner: "blob",
      rootDir,
      write: async () => {
        writes.push("blob")
      },
    })
    const overlappingFinalization = finalizeProviderDeploymentOutputs(catalog)
    releaseFirst()
    await Promise.all([firstFinalization, overlappingFinalization])

    expect(writes).toEqual(["agent", "blob"])
  })

  it("isolates concurrent roots", async () => {
    const first = createProviderOutputCatalog()
    const second = createProviderOutputCatalog()
    const firstRoot = await createTempProject()
    const secondRoot = await createTempProject()
    const started: string[] = []
    const releases: Array<() => void> = []
    const block = (name: string) => async () => {
      started.push(name)
      await new Promise<void>(resolve => releases.push(resolve))
    }
    contributeProviderDeploymentOutput(first, { owner: "blob", rootDir: firstRoot, write: block("first") })
    contributeProviderDeploymentOutput(second, { owner: "blob", rootDir: secondRoot, write: block("second") })

    const finalizations = Promise.all([
      finalizeProviderDeploymentOutputs(first),
      finalizeProviderDeploymentOutputs(second),
    ])
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]))
    releases.splice(0).forEach(release => release())
    await finalizations
  })

  it("serializes concurrent finalizers for the same root", async () => {
    const first = createProviderOutputCatalog()
    const second = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const started: string[] = []
    let releaseFirst!: () => void
    contributeProviderDeploymentOutput(first, {
      owner: "blob",
      rootDir,
      write: async () => {
        started.push("first")
        await new Promise<void>(resolve => releaseFirst = resolve)
      },
    })
    contributeProviderDeploymentOutput(second, {
      owner: "blob",
      rootDir,
      write: async () => {
        started.push("second")
      },
    })

    const firstFinalization = finalizeProviderDeploymentOutputs(first)
    const secondFinalization = finalizeProviderDeploymentOutputs(second)
    await vi.waitFor(() => expect(started).toEqual(["first"]))
    releaseFirst()
    await Promise.all([firstFinalization, secondFinalization])

    expect(started).toEqual(["first", "second"])
  })

  it("releases state and the root lock after a writer error", async () => {
    const failed = createProviderOutputCatalog()
    const recovered = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const afterFailure = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(failed, {
      owner: "agent",
      rootDir,
      write: async () => {
        throw new Error("writer failed")
      },
    })
    contributeProviderDeploymentOutput(failed, { owner: "blob", rootDir, write: afterFailure })

    await expect(finalizeProviderDeploymentOutputs(failed)).rejects.toThrow("writer failed")
    expect(afterFailure).not.toHaveBeenCalled()

    const recoveredWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(recovered, { owner: "blob", rootDir, write: recoveredWrite })
    await finalizeProviderDeploymentOutputs(recovered)
    expect(recoveredWrite).toHaveBeenCalledOnce()
  })

  it("clears pending work when finalization is aborted", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const controller = new AbortController()
    const write = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write })
    controller.abort(new Error("build aborted"))

    await expect(finalizeProviderDeploymentOutputs(catalog, { signal: controller.signal })).rejects.toThrow("build aborted")
    expect(write).not.toHaveBeenCalled()
    await finalizeProviderDeploymentOutputs(catalog)
    expect(write).not.toHaveBeenCalled()
  })

  it("aborts and settles active finalization when reset", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    let activeSignal: AbortSignal | undefined
    let releaseWrite!: () => void
    const laterWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ signal }) => {
        activeSignal = signal
        await new Promise<void>(resolve => releaseWrite = resolve)
      },
    })
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: laterWrite })

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await vi.waitFor(() => expect(activeSignal).toBeDefined())
    const reset = resetProviderDeploymentOutputs(catalog)
    expect(activeSignal?.aborted).toBe(true)
    releaseWrite()
    await reset
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")
    expect(laterWrite).not.toHaveBeenCalled()
  })

  it("prevents publication resumed after active finalization is reset", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    let releaseContribution!: () => void
    let contributionStarted!: () => void
    const started = new Promise<void>(resolve => contributionStarted = resolve)
    const publication = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => {
        contributionStarted()
        await new Promise<void>(resolve => releaseContribution = resolve)
        await write({ clientOutDir: "dist/client", rootDir })
        await publication()
      },
    })

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await started
    const reset = resetProviderDeploymentOutputs(catalog)
    releaseContribution()
    await reset
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")
    expect(publication).not.toHaveBeenCalled()
  })

  it("removes stale output for every disabled host", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    const vercelRoot = join(rootDir, ".vercel", "output")
    const netlifyRoot = join(rootDir, ".netlify", "v1")
    await Promise.all([
      mkdir(cloudflareRoot, { recursive: true }),
      mkdir(join(vercelRoot, "functions", "stale.func"), { recursive: true }),
      mkdir(join(netlifyRoot, "functions"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(cloudflareRoot, "index.js"), "stale\n"),
      writeFile(join(cloudflareRoot, "wrangler.json"), '{"name":"app","queues":{"producers":[]}}\n'),
      writeFile(join(vercelRoot, "config.json"), '{"version":3,"routes":[]}\n'),
      writeFile(join(vercelRoot, "functions", "stale.func", "index.mjs"), "stale\n"),
      writeFile(join(netlifyRoot, "config.json"), '{"version":1,"routes":[]}\n'),
      writeFile(join(netlifyRoot, "functions", "stale.mjs"), "stale\n"),
    ])
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => await write({
        clientOutDir: "dist/client",
        cleanup: {
          cloudflare: { fileNames: ["index.js"], wranglerConfigOwnership: { keys: ["queues"] } },
          netlify: { configKeys: ["routes"], functionNames: ["stale"] },
          vercel: { configKeys: ["routes"], serverFunctionName: "stale.func" },
        },
        rootDir,
      }),
    })

    await finalizeProviderDeploymentOutputs(catalog)

    expect(existsSync(join(cloudflareRoot, "index.js"))).toBe(false)
    await expect(readFile(join(cloudflareRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({ name: "app" })
    expect(existsSync(join(vercelRoot, "functions", "stale.func"))).toBe(false)
    await expect(readFile(join(vercelRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual({ version: 3 })
    expect(existsSync(join(netlifyRoot, "functions", "stale.mjs"))).toBe(false)
    await expect(readFile(join(netlifyRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual({ version: 1 })
  })
})
