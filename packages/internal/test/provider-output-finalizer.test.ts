import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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
    const rootDir = await createTempProject()
    const writes: string[] = []
    generations.capture({ environment: environmentA }, catalog)
    generations.capture({ environment: environmentB }, catalog)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => { writes.push("A") },
    }, generations.get({ environment: environmentA }))
    await generations.reset({ environment: environmentA }, catalog, new Error("build A failed"))
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => { writes.push("stale A") },
    }, generations.get({ environment: environmentA }))
    contributeProviderDeploymentOutput(catalog, {
      owner: "blob",
      rootDir,
      write: async () => { writes.push("B") },
    }, generations.get({ environment: environmentB }))
    await finalizeProviderDeploymentOutputs(catalog)

    expect(writes).toEqual(["B"])
  })

  it("invalidates every generation when Vite repeats one failure", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const failure = new Error("render failed")
    const first = captureProviderDeploymentOutputGeneration(catalog)
    const second = captureProviderDeploymentOutputGeneration(catalog)
    const writes: string[] = []

    await resetProviderDeploymentOutputs(catalog, failure, first)
    await resetProviderDeploymentOutputs(catalog, failure, second)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => { writes.push("first") },
    }, first)
    contributeProviderDeploymentOutput(catalog, {
      owner: "blob",
      rootDir,
      write: async () => { writes.push("second") },
    }, second)
    await finalizeProviderDeploymentOutputs(catalog)

    expect(writes).toEqual([])
  })

  it("preserves an older owner contribution when its replacement resets", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const first = captureProviderDeploymentOutputGeneration(catalog)
    const second = captureProviderDeploymentOutputGeneration(catalog)
    const writes: string[] = []
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => { writes.push("first") },
    }, first)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => { writes.push("second") },
    }, second)

    await resetProviderDeploymentOutputs(catalog, new Error("replacement failed"), second)
    await finalizeProviderDeploymentOutputs(catalog)

    expect(writes).toEqual(["first"])
  })

  it("does not abort another generation's active finalization", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const failed = captureProviderDeploymentOutputGeneration(catalog)
    const active = captureProviderDeploymentOutputGeneration(catalog)
    let activeSignal: AbortSignal | undefined
    let releaseWrite!: () => void
    contributeProviderDeploymentOutput(catalog, {
      owner: "blob",
      rootDir,
      write: async ({ signal }) => {
        activeSignal = signal
        await new Promise<void>(resolve => releaseWrite = resolve)
      },
    }, active)

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await vi.waitFor(() => expect(activeSignal).toBeDefined())
    await resetProviderDeploymentOutputs(catalog, new Error("other environment failed"), failed)

    expect(activeSignal?.aborted).toBe(false)
    releaseWrite()
    await finalization
  })

  it("requeues valid generations when a peer resets active finalization", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const failed = captureProviderDeploymentOutputGeneration(catalog)
    const valid = captureProviderDeploymentOutputGeneration(catalog)
    const validWrite = vi.fn(async () => undefined)
    let releaseFailed!: () => void
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => await new Promise<void>(resolve => releaseFailed = resolve),
    }, failed)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir, write: validWrite }, valid)

    const failedFinalization = finalizeProviderDeploymentOutputs(catalog)
    await vi.waitFor(() => expect(releaseFailed).toBeDefined())
    const reset = resetProviderDeploymentOutputs(catalog, new Error("agent failed"), failed)
    releaseFailed()
    await reset
    await expect(failedFinalization).rejects.toThrow("Provider Output finalization reset")
    await finalizeProviderDeploymentOutputs(catalog)

    expect(validWrite).toHaveBeenCalledOnce()
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
    const customOutputRoot = join(rootDir, "custom-cloudflare")
    const customOutputFile = join(customOutputRoot, "owner.js")
    const ownershipFile = join(rootDir, ".vitehub/blob/cloudflare-output.json")
    await Promise.all([
      mkdir(outputRoot, { recursive: true }),
      mkdir(customOutputRoot, { recursive: true }),
      mkdir(dirname(ownershipFile), { recursive: true }),
    ])
    await Promise.all([
      writeFile(outputFile, "previous\n"),
      writeFile(customOutputFile, "previous\n"),
      writeFile(ownershipFile, "previous\n"),
    ])
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => {
        await writeFile(outputFile, "replacement\n")
        await write({
          clientOutDir: "dist/client",
          cloudflare: {
            files: { "owner.js": "replacement\n" },
            outputRoot: customOutputRoot,
            wranglerConfig: {},
          },
          rootDir,
        })
        await writeFile(ownershipFile, "replacement\n")
      },
    })
    contributeProviderDeploymentOutput(catalog, {
      owner: "database",
      rootDir,
      write: async () => { throw new Error("database failed") },
    })

    await expect(finalizeProviderDeploymentOutputs(catalog)).rejects.toThrow("database failed")
    await expect(readFile(outputFile, "utf8")).resolves.toBe("previous\n")
    await expect(readFile(customOutputFile, "utf8")).resolves.toBe("previous\n")
    await expect(readFile(ownershipFile, "utf8")).resolves.toBe("previous\n")
  })

  it("does not roll back client output written by a newer build", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const clientOutput = join(rootDir, "dist/client/index.html")
    await mkdir(dirname(clientOutput), { recursive: true })
    await writeFile(clientOutput, "older build\n")
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => {
        await write({ clientOutDir: "dist/client", rootDir })
        await writeFile(clientOutput, "newer build\n")
        throw new Error("older output failed")
      },
    })

    await expect(finalizeProviderDeploymentOutputs(catalog)).rejects.toThrow("older output failed")
    await expect(readFile(clientOutput, "utf8")).resolves.toBe("newer build\n")
  })

  it("discards superseded contribution artifacts after completion", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const olderDiscard = vi.fn(async () => undefined)
    const newerDiscard = vi.fn(async () => undefined)
    const olderWrite = vi.fn(async () => undefined)
    const newerWrite = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, {
      discard: olderDiscard,
      owner: "blob",
      rootDir,
      write: olderWrite,
    }, captureProviderDeploymentOutputGeneration(catalog))
    contributeProviderDeploymentOutput(catalog, {
      discard: newerDiscard,
      owner: "blob",
      rootDir,
      write: newerWrite,
    }, captureProviderDeploymentOutputGeneration(catalog))

    await finalizeProviderDeploymentOutputs(catalog)

    expect(olderWrite).not.toHaveBeenCalled()
    expect(newerWrite).toHaveBeenCalledOnce()
    expect(olderDiscard).toHaveBeenCalledOnce()
    expect(newerDiscard).toHaveBeenCalledOnce()
  })

  it("preserves fallback artifacts when the selected generation resets during cleanup", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const olderDiscard = vi.fn(async () => undefined)
    const olderWrite = vi.fn(async () => undefined)
    let cleanupStarted!: () => void
    let releaseCleanup!: () => void
    const started = new Promise<void>(resolve => cleanupStarted = resolve)
    const olderGeneration = captureProviderDeploymentOutputGeneration(catalog)
    const newerGeneration = captureProviderDeploymentOutputGeneration(catalog)
    contributeProviderDeploymentOutput(catalog, {
      discard: olderDiscard,
      owner: "blob",
      rootDir,
      write: olderWrite,
    }, olderGeneration)
    contributeProviderDeploymentOutput(catalog, {
      discard: async () => {
        cleanupStarted()
        await new Promise<void>(resolve => releaseCleanup = resolve)
      },
      owner: "blob",
      rootDir,
      write: async () => undefined,
    }, newerGeneration)

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await started
    const reset = resetProviderDeploymentOutputs(catalog, undefined, newerGeneration)
    releaseCleanup()

    await reset
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")
    expect(olderDiscard).not.toHaveBeenCalled()
    await finalizeProviderDeploymentOutputs(catalog)
    expect(olderWrite).toHaveBeenCalledOnce()
    expect(olderDiscard).toHaveBeenCalledOnce()
  })

  it("rolls back completed roots when a peer root fails", async () => {
    const catalog = createProviderOutputCatalog()
    const firstRoot = await createTempProject()
    const secondRoot = await createTempProject()
    const firstOutput = createDefaultCloudflareOutputRoot(firstRoot)
    const secondOutput = createDefaultCloudflareOutputRoot(secondRoot)
    await Promise.all([
      mkdir(firstOutput, { recursive: true }),
      mkdir(secondOutput, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(firstOutput, "index.js"), "first previous\n"),
      writeFile(join(secondOutput, "index.js"), "second previous\n"),
    ])
    let firstReady!: () => void
    const firstCompleted = new Promise<void>(resolve => firstReady = resolve)
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir: firstRoot,
      write: async ({ write }) => {
        await write({
          clientOutDir: "dist/client",
          cloudflare: { files: { "index.js": "first replacement\n" }, outputRoot: firstOutput, wranglerConfig: {} },
          rootDir: firstRoot,
        })
        firstReady()
      },
    })
    contributeProviderDeploymentOutput(catalog, {
      owner: "blob",
      rootDir: secondRoot,
      write: async ({ write }) => {
        await firstCompleted
        await write({
          clientOutDir: "dist/client",
          cloudflare: { files: { "index.js": "second replacement\n" }, outputRoot: secondOutput, wranglerConfig: {} },
          rootDir: secondRoot,
        })
        throw new Error("second root failed")
      },
    })

    await expect(finalizeProviderDeploymentOutputs(catalog)).rejects.toThrow("second root failed")
    await expect(readFile(join(firstOutput, "index.js"), "utf8")).resolves.toBe("first previous\n")
    await expect(readFile(join(secondOutput, "index.js"), "utf8")).resolves.toBe("second previous\n")
  })

  it("preserves newer generated inputs when rolling back output ownership", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const generatedInput = join(rootDir, ".vitehub/blob/runtime.mjs")
    await mkdir(dirname(generatedInput), { recursive: true })
    await writeFile(generatedInput, "old input\n")
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async () => {
        await writeFile(generatedInput, "new input\n")
        throw new Error("output failed")
      },
    })

    await expect(finalizeProviderDeploymentOutputs(catalog)).rejects.toThrow("output failed")
    await expect(readFile(generatedInput, "utf8")).resolves.toBe("new input\n")
  })

  it("coalesces a custom parent output root with default child snapshots", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const outputRoot = join(rootDir, "dist")
    const previousFile = join(outputRoot, "existing.txt")
    await mkdir(outputRoot, { recursive: true })
    await writeFile(previousFile, "previous\n")
    contributeProviderDeploymentOutput(catalog, {
      owner: "agent",
      rootDir,
      write: async ({ write }) => {
        await write({
          clientOutDir: join(outputRoot, "client"),
          cloudflare: { files: { "index.js": "replacement\n" }, outputRoot, wranglerConfig: {} },
          rootDir,
        })
        throw new Error("output failed")
      },
    })

    await expect(finalizeProviderDeploymentOutputs(catalog)).rejects.toThrow("output failed")
    await expect(readFile(previousFile, "utf8")).resolves.toBe("previous\n")
    expect(existsSync(join(outputRoot, "index.js"))).toBe(false)
  })

  it("does not enter finalization when a root snapshot fails", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(dirname(outputRoot), { recursive: true })
    const socket = createServer()
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject)
      socket.listen(outputRoot, resolve)
    })
    const write = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "agent", rootDir, write })

    try {
      await expect(finalizeProviderDeploymentOutputs(catalog)).rejects.toThrow()
      expect(write).not.toHaveBeenCalled()
      expect(existsSync(outputRoot)).toBe(true)
    }
    finally {
      await new Promise<void>(resolve => socket.close(() => resolve()))
    }
  })

  it("restores snapshots across filesystems", async () => {
    const memoryRoot = "/dev/shm"
    if (!existsSync(memoryRoot)) return
    const [temporaryFilesystem, memoryFilesystem] = await Promise.all([stat(tmpdir()), stat(memoryRoot)])
    if (temporaryFilesystem.dev === memoryFilesystem.dev) return
    const catalog = createProviderOutputCatalog()
    const rootDir = await mkdtemp(join(memoryRoot, "vitehub-provider-output-finalizer-"))
    tempDirs.push(rootDir)
    const outputFile = join(createDefaultCloudflareOutputRoot(rootDir), "index.js")
    await mkdir(dirname(outputFile), { recursive: true })
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

  it("rolls back root output when reset interrupts contribution cleanup", async () => {
    const catalog = createProviderOutputCatalog()
    const rootDir = await createTempProject()
    const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
    const outputFile = join(outputRoot, "index.js")
    await mkdir(outputRoot, { recursive: true })
    await writeFile(outputFile, "previous\n")
    let cleanupStarted!: () => void
    let releaseCleanup!: () => void
    const started = new Promise<void>(resolve => cleanupStarted = resolve)
    contributeProviderDeploymentOutput(catalog, {
      discard: async () => {
        cleanupStarted()
        await new Promise<void>(resolve => releaseCleanup = resolve)
      },
      owner: "agent",
      rootDir,
      write: async () => await writeFile(outputFile, "replacement\n"),
    })

    const finalization = finalizeProviderDeploymentOutputs(catalog)
    await started
    const reset = resetProviderDeploymentOutputs(catalog)
    releaseCleanup()

    await reset
    await expect(finalization).rejects.toThrow("Provider Output finalization reset")
    await expect(readFile(outputFile, "utf8")).resolves.toBe("previous\n")
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
