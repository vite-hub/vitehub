import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  captureProviderDeploymentOutputGeneration,
  contributeProviderDeploymentOutput,
  createDefaultCloudflareOutputRoot,
  createProviderDeploymentOutputGenerationState,
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
  it("keeps build generations local to each Vite environment", async () => {
    const catalog = createProviderOutputCatalog()
    const generations = createProviderDeploymentOutputGenerationState()
    const environmentA = {}
    const environmentB = {}
    generations.capture({ environment: environmentA }, catalog)
    await resetProviderDeploymentOutputs(catalog, new Error("build A failed"))
    generations.capture({ environment: environmentB }, catalog)

    expect(generations.get({ environment: environmentA })).toBe(0)
    expect(generations.get({ environment: environmentB })).toBe(1)
  })

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

  it("rolls back earlier owners when a later owner fails", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
    const outputFile = join(outputRoot, "index.js")
    await mkdir(outputRoot, { recursive: true })
    await writeFile(outputFile, "previous\n")
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => await writeFile(outputFile, "replacement\n"),
    })
    contributeProviderDeploymentOutput(catalog, {
      owner: "database",
      rootDir,
      write: async () => { throw new Error("database failed") },
    })

    await expect(finalizeProviderDeploymentOutputs(catalog)).rejects.toThrow("database failed")
    await expect(readFile(outputFile, "utf8")).resolves.toBe("previous\n")
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

  it("drains contributions registered while an active finalizer settles", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const writes: string[] = []
    let takeCount = 0
    const take = catalog.takeDeploymentContributions.bind(catalog)
    catalog.takeDeploymentContributions = () => {
      const contributions = take()
      if (++takeCount === 2) {
        queueMicrotask(() => contributeProviderDeploymentOutput(catalog, {
          owner: "blob",
          rootDir,
          write: async () => { writes.push("blob") },
        }))
      }
      return contributions
    }
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => { writes.push("agent") },
    })

    const first = finalizeProviderDeploymentOutputs(catalog)
    const overlapping = finalizeProviderDeploymentOutputs(catalog)
    await Promise.all([first, overlapping])

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

  it("finalizes newer contributions registered while reset unwinds", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    let releaseWrite!: () => void
    let writeStarted!: () => void
    const started = new Promise<void>(resolve => writeStarted = resolve)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => {
        writeStarted()
        await new Promise<void>(resolve => releaseWrite = resolve)
      },
    })

    const failedFinalization = finalizeProviderDeploymentOutputs(catalog)
    await started
    const reset = resetProviderDeploymentOutputs(catalog)
    const newerWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: newerWrite })
    const repeatedReset = resetProviderDeploymentOutputs(catalog)
    const newerFinalization = finalizeProviderDeploymentOutputs(catalog)
    releaseWrite()

    await Promise.all([reset, repeatedReset])
    await expect(failedFinalization).rejects.toThrow("Provider Output finalization reset")
    await newerFinalization
    expect(newerWrite).toHaveBeenCalledOnce()
  })

  it("preserves newer contributions from a reset repeated after teardown", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const failedBuild = new Error("build failed")
    let releaseWrite!: () => void
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => await new Promise<void>(resolve => releaseWrite = resolve),
    })

    const failedFinalization = finalizeProviderDeploymentOutputs(catalog)
    await vi.waitFor(() => expect(releaseWrite).toBeDefined())
    const reset = resetProviderDeploymentOutputs(catalog, failedBuild)
    releaseWrite()
    await reset
    await expect(failedFinalization).rejects.toThrow("Provider Output finalization reset")

    const newerWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: newerWrite })
    await resetProviderDeploymentOutputs(catalog, failedBuild)
    await finalizeProviderDeploymentOutputs(catalog)
    expect(newerWrite).toHaveBeenCalledOnce()
  })

  it("rejects a contribution prepared before a build reset", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const generation = captureProviderDeploymentOutputGeneration(catalog)
    const staleWrite = vi.fn(async () => undefined)

    await resetProviderDeploymentOutputs(catalog, new Error("build failed"))
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: staleWrite }, generation)
    await finalizeProviderDeploymentOutputs(catalog)

    expect(staleWrite).not.toHaveBeenCalled()
  })

  it("deduplicates an old failure without shielding a newer failure", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const oldFailure = new Error("old build failed")
    let releaseOldWrite!: () => void
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => await new Promise<void>(resolve => releaseOldWrite = resolve),
    })

    const oldFinalization = finalizeProviderDeploymentOutputs(catalog)
    await vi.waitFor(() => expect(releaseOldWrite).toBeDefined())
    const oldReset = resetProviderDeploymentOutputs(catalog, oldFailure)
    releaseOldWrite()
    await oldReset
    await expect(oldFinalization).rejects.toThrow("Provider Output finalization reset")

    let activeSignal: AbortSignal | undefined
    let releaseNewWrite!: () => void
    contributeProviderDeploymentOutput(catalog, {
      owner: "blob",
      rootDir,
      write: async ({ signal }) => {
        activeSignal = signal
        await new Promise<void>(resolve => releaseNewWrite = resolve)
      },
    })
    const newFinalization = finalizeProviderDeploymentOutputs(catalog)
    await vi.waitFor(() => expect(activeSignal).toBeDefined())

    await resetProviderDeploymentOutputs(catalog, oldFailure)
    expect(activeSignal?.aborted).toBe(false)

    const newReset = resetProviderDeploymentOutputs(catalog, new Error("new build failed"))
    expect(activeSignal?.aborted).toBe(true)
    releaseNewWrite()
    await newReset
    await expect(newFinalization).rejects.toThrow("Provider Output finalization reset")
  })

  it("deduplicates an old failure after a successful replacement", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const oldFailure = new Error("old build failed")
    await resetProviderDeploymentOutputs(catalog, oldFailure)
    const replacementWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "agent", rootDir, write: replacementWrite })
    await finalizeProviderDeploymentOutputs(catalog)
    const laterWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: laterWrite })

    await resetProviderDeploymentOutputs(catalog, oldFailure)
    await finalizeProviderDeploymentOutputs(catalog)

    expect(replacementWrite).toHaveBeenCalledOnce()
    expect(laterWrite).toHaveBeenCalledOnce()
  })

  it("clears the next build's contributions when it fails after reset teardown", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const failedBuild = new Error("first build failed")
    let releaseWrite!: () => void
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => await new Promise<void>(resolve => releaseWrite = resolve),
    })

    const failedFinalization = finalizeProviderDeploymentOutputs(catalog)
    await vi.waitFor(() => expect(releaseWrite).toBeDefined())
    const reset = resetProviderDeploymentOutputs(catalog, failedBuild)
    releaseWrite()
    await reset
    await expect(failedFinalization).rejects.toThrow("Provider Output finalization reset")

    const staleWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: staleWrite })
    await resetProviderDeploymentOutputs(catalog, new Error("next build failed"))
    await finalizeProviderDeploymentOutputs(catalog)
    expect(staleWrite).not.toHaveBeenCalled()
  })

  it("joins every reset waiter to the same replacement finalization", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    let releaseWrite!: () => void
    let writeStarted!: () => void
    const started = new Promise<void>(resolve => writeStarted = resolve)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => {
        writeStarted()
        await new Promise<void>(resolve => releaseWrite = resolve)
      },
    })

    const failedFinalization = finalizeProviderDeploymentOutputs(catalog)
    await started
    const reset = resetProviderDeploymentOutputs(catalog)
    const newerWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: newerWrite })
    const firstWaiter = finalizeProviderDeploymentOutputs(catalog)
    const secondWaiter = finalizeProviderDeploymentOutputs(catalog)
    releaseWrite()

    await reset
    await expect(failedFinalization).rejects.toThrow("Provider Output finalization reset")
    await Promise.all([firstWaiter, secondWaiter])
    expect(newerWrite).toHaveBeenCalledOnce()
  })

  it("preserves newer contributions after a writer failure", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    let releaseWrite!: () => void
    let writeStarted!: () => void
    const started = new Promise<void>(resolve => writeStarted = resolve)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => {
        writeStarted()
        await new Promise<void>(resolve => releaseWrite = resolve)
        throw new Error("writer failed")
      },
    })

    const failedFinalization = finalizeProviderDeploymentOutputs(catalog)
    await started
    const newerWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: newerWrite })
    const newerFinalization = finalizeProviderDeploymentOutputs(catalog)
    releaseWrite()

    await expect(failedFinalization).rejects.toThrow("writer failed")
    await newerFinalization
    expect(newerWrite).toHaveBeenCalledOnce()
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

  it("does not publish a bundle when finalization is reset during bundling", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const entry = join(rootDir, "entry.ts")
    const outputRoot = join(rootDir, "provider-output")
    await writeFile(entry, "export default true\n")
    let reset!: Promise<void>
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => await write({
        clientOutDir: "dist/client",
        cloudflare: {
          bundleEntry: entry,
          bundleOptions: {
            plugins: [{
              name: "reset-finalization",
              setup(build) {
                build.onStart(() => {
                  reset = resetProviderDeploymentOutputs(catalog)
                })
              },
            }],
          },
          outputRoot,
          wranglerConfig: {},
        },
        rootDir,
      }),
    })

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")
    await reset
    expect(existsSync(join(outputRoot, "index.js"))).toBe(false)
  })

  it("does not start cleanup after finalization is reset", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
    const staleFile = join(outputRoot, "stale.js")
    await mkdir(outputRoot, { recursive: true })
    await writeFile(staleFile, "stale\n")
    let releaseCleanup!: () => void
    let cleanupStarted!: () => void
    const started = new Promise<void>(resolve => cleanupStarted = resolve)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => await write({
        clientOutDir: "dist/client",
        cleanup: {
          cloudflare: async () => {
            cleanupStarted()
            await new Promise<void>(resolve => releaseCleanup = resolve)
            return { fileNames: ["stale.js"] }
          },
        },
        rootDir,
      }),
    })

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await started
    const reset = resetProviderDeploymentOutputs(catalog)
    releaseCleanup()
    await reset
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")
    expect(existsSync(staleFile)).toBe(true)
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
