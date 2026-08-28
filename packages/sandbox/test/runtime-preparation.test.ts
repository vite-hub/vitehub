import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  activateSandboxRuntimeFile,
  markSandboxRuntimeGeneration,
  pruneSandboxRuntimeGeneration,
  readSandboxRuntimeGeneration,
  restoreSandboxRuntimeGeneration,
  resolveSandboxRuntimeFacadeImportBase,
  resolveSandboxRuntimeLinkType,
  withSandboxRuntimeGenerationLock,
} from "../src/internal/runtime-generation.ts"
import { createFileImportSpecifier } from "../src/internal/shared/file-import-specifier.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Sandbox runtime preparation", () => {
  it("emits loadable file URLs for Windows package imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-import-"))
    tempDirs.push(root)
    const moduleFile = join(root, "state.mjs")
    await writeFile(moduleFile, "export const ready = true\n")

    const specifier = createFileImportSpecifier(moduleFile, "win32")
    expect(specifier).toMatch(/^file:\/\//)
    await expect(import(specifier)).resolves.toMatchObject({ ready: true })
    expect(createFileImportSpecifier(
      String.raw`C:\repo\node_modules\@vite-hub\sandbox\dist\runtime\state.js`,
      "win32",
    )).toBe("file:///C:/repo/node_modules/@vite-hub/sandbox/dist/runtime/state.js")
  })

  it("uses directory links only where they can be replaced atomically", () => {
    expect(resolveSandboxRuntimeLinkType("win32")).toBe("junction")
    expect(resolveSandboxRuntimeLinkType("linux")).toBe("dir")
  })

  it("renders copied Windows facade imports from the active location", () => {
    const generatedDir = join(tmpdir(), "generated")
    const runtimeDir = join(generatedDir, "runtime")
    const generationFacade = join(generatedDir, ".runtime-generations", "runtime-next", "sandbox.mjs")

    expect(resolveSandboxRuntimeFacadeImportBase(runtimeDir, generationFacade, "win32"))
      .toBe(join(runtimeDir, "sandbox.mjs"))
    expect(resolveSandboxRuntimeFacadeImportBase(runtimeDir, generationFacade, "linux")).toBe(generationFacade)
  })

  it("retains the active Windows runtime when file replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const source = join(root, "next.mjs")
    const staged = join(root, "staged.mjs")
    const target = join(root, "runtime", "sandbox.mjs")
    await mkdir(join(root, "runtime"))
    await writeFile(source, "export const generation = 'next'\n")
    await writeFile(target, "export const generation = 'previous'\n")

    await expect(activateSandboxRuntimeFile(source, target, staged, {
      copyFile: async (from, to) => {
        await writeFile(to, await readFile(from))
      },
      rename: async () => {
        throw new Error("activation failed")
      },
      rm,
    })).rejects.toThrow("activation failed")
    await expect(readFile(target, "utf8")).resolves.toContain("previous")
    await expect(readFile(staged, "utf8")).rejects.toMatchObject({ code: "ENOENT" })

    await activateSandboxRuntimeFile(source, target, staged)
    await expect(readFile(target, "utf8")).resolves.toContain("next")
  })

  it("does not restore an older runtime after generation ownership is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const previous = join(root, "previous")
    const active = join(root, "runtime")
    await writeFile(previous, "previous\n")
    await writeFile(active, "successor\n")
    const move = vi.fn(rename)
    const lease = {
      assertOwned: vi.fn(async () => {
        throw new Error("Lost ownership")
      }),
    }

    await expect(restoreSandboxRuntimeGeneration(previous, active, lease, move)).rejects.toThrow("Lost ownership")

    expect(move).not.toHaveBeenCalled()
    await expect(readFile(active, "utf8")).resolves.toBe("successor\n")
    await expect(readFile(previous, "utf8")).resolves.toBe("previous\n")
  })

  it("does not replace a successor while restoring an older runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const previous = join(root, "previous")
    const active = join(root, "runtime")
    await writeFile(previous, "previous\n")
    await writeFile(active, "successor\n")
    const move = vi.fn(rename)
    const lease = { assertOwned: vi.fn(async () => {}) }

    await expect(restoreSandboxRuntimeGeneration(previous, active, lease, move)).rejects.toThrow("runtime changed during activation")

    expect(move).not.toHaveBeenCalled()
    await expect(readFile(active, "utf8")).resolves.toBe("successor\n")
    await expect(readFile(previous, "utf8")).resolves.toBe("previous\n")
  })

  it("does not reject an activated refresh when generation pruning fails", async () => {
    const remove = vi.fn(async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" })
    })

    await expect(pruneSandboxRuntimeGeneration("/generated/runtime", remove)).resolves.toBeUndefined()
  })

  it("serializes generation writers through the project filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const order: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withSandboxRuntimeGenerationLock(root, async () => {
      order.push("first-start")
      markFirstStarted()
      await firstReleased
      order.push("first-end")
    })
    await firstStarted
    const second = withSandboxRuntimeGenerationLock(root, async () => {
      order.push("second")
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(order).toEqual(["first-start"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second"])
  })

  it("preserves a successor when an initializing writer loses its lock directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")
    let continueFirst!: () => void
    let markFirstPaused!: () => void
    let markSecondStarted!: () => void
    let releaseSecond!: () => void
    const firstPaused = new Promise<void>((resolve) => { markFirstPaused = resolve })
    const firstContinued = new Promise<void>((resolve) => { continueFirst = resolve })
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve })
    const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve })
    const lockOptions = { pollMs: 5, staleMs: -1, waitMs: 1_000 }

    const first = withSandboxRuntimeGenerationLock(root, async () => "first", {
      ...lockOptions,
      beforeInitializeLock: async () => {
        markFirstPaused()
        await firstContinued
      },
    })
    await firstPaused
    const second = withSandboxRuntimeGenerationLock(root, async (lease) => {
      markSecondStarted()
      await secondReleased
      await expect(lease.assertOwned()).resolves.toBeUndefined()
      return "second"
    }, lockOptions)
    await secondStarted
    const secondOwner = await readFile(join(lockDir, "owner.json"), "utf8")

    const firstRejected = expect(first).rejects.toThrow()
    continueFirst()
    await firstRejected

    let thirdStarted = false
    const third = withSandboxRuntimeGenerationLock(root, async () => {
      thirdStarted = true
      return "third"
    }, lockOptions)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(thirdStarted).toBe(false)
    await expect(readFile(join(lockDir, "owner.json"), "utf8")).resolves.toBe(secondOwner)

    releaseSecond()
    await expect(second).resolves.toBe("second")
    await expect(third).resolves.toBe("third")
  })

  it("renews a remote writer lease before a contender can reclaim it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve })
    let secondStarted = false

    const first = withSandboxRuntimeGenerationLock(root, async () => {
      const stale = new Date(Date.now() - 301_000)
      await utimes(join(root, ".runtime-generation.lock/lease"), stale, stale)
      markFirstStarted()
      await firstReleased
    }, {
      heartbeatMs: 5,
      host: "remote-host",
    })
    await firstStarted
    await new Promise(resolve => setTimeout(resolve, 25))
    const second = withSandboxRuntimeGenerationLock(root, async () => {
      secondStarted = true
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(secondStarted).toBe(false)
    releaseFirst()
    await Promise.all([first, second])
    expect(secondStarted).toBe(true)
  })

  it("releases the generation lock when a writer fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)

    await expect(withSandboxRuntimeGenerationLock(root, async () => {
      throw new Error("generation failed")
    })).rejects.toThrow("generation failed")
    await expect(withSandboxRuntimeGenerationLock(root, async () => "recovered")).resolves.toBe("recovered")
  })

  it("marks a lock released when filesystem cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)

    await expect(withSandboxRuntimeGenerationLock(root, async () => "generated", {
      removeLock: (async () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" })
      }) as typeof rm,
    })).resolves.toBe("generated")
    await expect(withSandboxRuntimeGenerationLock(root, async () => "recovered")).resolves.toBe("recovered")
  })

  it("retires only the observed lock while a successor reclaims and acquires", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")
    let continueRemoval!: () => void
    let continueRetirement!: () => void
    let markRemovalStarted!: () => void
    let markRetirementStarted!: () => void
    let markSuccessorStarted!: () => void
    let releaseSuccessor!: () => void
    const removalStarted = new Promise<void>((resolve) => { markRemovalStarted = resolve })
    const removalContinued = new Promise<void>((resolve) => { continueRemoval = resolve })
    const retirementStarted = new Promise<void>((resolve) => { markRetirementStarted = resolve })
    const retirementContinued = new Promise<void>((resolve) => { continueRetirement = resolve })
    const successorStarted = new Promise<void>((resolve) => { markSuccessorStarted = resolve })
    const successorReleased = new Promise<void>((resolve) => { releaseSuccessor = resolve })

    const first = withSandboxRuntimeGenerationLock(root, async () => "first", {
      removeLock: (async (path, options) => {
        expect(path).not.toBe(lockDir)
        markRemovalStarted()
        await removalContinued
        await rm(path, options)
      }) as typeof rm,
      retireLock: (async (from, to) => {
        expect(from).toBe(lockDir)
        markRetirementStarted()
        await retirementContinued
        await rename(from, to)
      }) as typeof rename,
    })
    await retirementStarted
    let successorDidStart = false
    const second = withSandboxRuntimeGenerationLock(root, async (lease) => {
      successorDidStart = true
      markSuccessorStarted()
      await successorReleased
      await expect(lease.assertOwned()).resolves.toBeUndefined()
      return "second"
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(successorDidStart).toBe(false)

    continueRetirement()
    await removalStarted
    await successorStarted

    continueRemoval()
    await expect(first).resolves.toBe("first")
    await expect(readFile(join(lockDir, "owner.json"), "utf8")).resolves.toContain("token")
    releaseSuccessor()
    await expect(second).resolves.toBe("second")
  })

  it("does not retire a successor after the release claim expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")
    let continueRelease!: () => void
    let markReleaseStarted!: () => void
    let markSuccessorStarted!: () => void
    let releaseSuccessor!: () => void
    const releaseStarted = new Promise<void>((resolve) => { markReleaseStarted = resolve })
    const releaseContinued = new Promise<void>((resolve) => { continueRelease = resolve })
    const successorStarted = new Promise<void>((resolve) => { markSuccessorStarted = resolve })
    const successorReleased = new Promise<void>((resolve) => { releaseSuccessor = resolve })
    let releaseWrites = 0

    const first = withSandboxRuntimeGenerationLock(root, async () => "first", {
      host: "remote-host",
      writeReleasedOwner: async (file, value) => {
        releaseWrites += 1
        if (releaseWrites === 1) {
          markReleaseStarted()
          await releaseContinued
        }
        await file.write(value, 0, "utf8")
        await file.truncate(Buffer.byteLength(value))
      },
    })
    await releaseStarted
    await rm(join(lockDir, ".reclaim"), { force: true })

    const second = withSandboxRuntimeGenerationLock(root, async (lease) => {
      markSuccessorStarted()
      await successorReleased
      await expect(lease.assertOwned()).resolves.toBeUndefined()
      return "second"
    })
    await successorStarted
    continueRelease()

    await expect(first).resolves.toBe("first")
    await expect(readFile(join(lockDir, "owner.json"), "utf8")).resolves.toContain("token")
    releaseSuccessor()
    await expect(second).resolves.toBe("second")
  })

  it("reclaims in process when both release marker writes fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const writeReleasedOwner = vi.fn(async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" })
    })

    await expect(withSandboxRuntimeGenerationLock(root, async () => "first", {
      writeReleasedOwner,
    })).rejects.toThrow("Failed to release the Sandbox runtime generation lock")
    expect(writeReleasedOwner).toHaveBeenCalledTimes(2)
    await expect(withSandboxRuntimeGenerationLock(root, async () => "recovered", {
      pollMs: 5,
      waitMs: 250,
    })).resolves.toBe("recovered")
  })

  it("reclaims a generation lock left by a terminated process", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")
    await mkdir(lockDir)
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({
      host: hostname(),
      pid: 2_147_483_647,
      token: "terminated",
    }))

    await expect(withSandboxRuntimeGenerationLock(root, async () => "reclaimed")).resolves.toBe("reclaimed")
  })

  it("reclaims an aged generation lock owned on another host", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")
    await mkdir(lockDir)
    const ownerPath = join(lockDir, "owner.json")
    await writeFile(ownerPath, JSON.stringify({
      host: "remote-host",
      pid: 42,
      token: "stale",
    }))
    await writeFile(join(lockDir, "lease"), "stale")
    const stale = new Date(Date.now() - 301_000)
    await utimes(join(lockDir, "lease"), stale, stale)

    await expect(withSandboxRuntimeGenerationLock(root, async () => "reclaimed")).resolves.toBe("reclaimed")
  })

  it("keeps a long-running remote writer leased past the stale threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const order: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const lockOptions = {
      heartbeatMs: 20,
      host: "remote-host",
      pollMs: 5,
      staleMs: 80,
      waitMs: 1_000,
    }

    const first = withSandboxRuntimeGenerationLock(root, async () => {
      order.push("first-start")
      markFirstStarted()
      await firstReleased
      order.push("first-end")
    }, lockOptions)
    await firstStarted
    await new Promise(resolve => setTimeout(resolve, 160))
    const second = withSandboxRuntimeGenerationLock(root, async () => {
      order.push("second")
    }, lockOptions)

    await new Promise(resolve => setTimeout(resolve, 100))
    expect(order).toEqual(["first-start"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second"])
  })

  it("recovers an aged malformed generation lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")
    await mkdir(lockDir)
    await writeFile(join(lockDir, "owner.json"), "not-json")
    const stale = new Date(Date.now() - 301_000)
    await utimes(lockDir, stale, stale)

    await expect(withSandboxRuntimeGenerationLock(root, async () => "reclaimed")).resolves.toBe("reclaimed")
  })

  it("fences a writer after its lock ownership is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")

    await expect(withSandboxRuntimeGenerationLock(root, async (lease) => {
      await rename(lockDir, `${lockDir}.replaced`)
      await mkdir(lockDir)
      await writeFile(join(lockDir, "owner.json"), JSON.stringify({
        host: hostname(),
        pid: process.pid,
        token: "replacement",
      }))
      await writeFile(join(lockDir, "lease"), "replacement")

      await expect(lease.assertOwned()).rejects.toThrow("Lost ownership")
    }, { heartbeatMs: 60_000 })).rejects.toThrow("Lost ownership")

    await expect(readFile(join(lockDir, "owner.json"), "utf8")).resolves.toContain("replacement")
  })

  it("makes a lock reclaimable when release removal fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const removeLock = vi.fn(async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" })
    })

    await expect(withSandboxRuntimeGenerationLock(
      root,
      async () => "released",
      { removeLock: removeLock as typeof rm },
    )).resolves.toBe("released")
    expect(removeLock).toHaveBeenCalledOnce()
    await expect(withSandboxRuntimeGenerationLock(root, async () => "reclaimed")).resolves.toBe("reclaimed")
  })

  it("recovers when a stale-lock reclaimer exits before moving the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")
    const claimPath = join(lockDir, ".reclaim")
    await mkdir(lockDir)
    const ownerPath = join(lockDir, "owner.json")
    await writeFile(ownerPath, JSON.stringify({
      host: "remote-host",
      pid: 42,
      token: "stale",
    }))
    await writeFile(claimPath, "")
    const staleLock = new Date(Date.now() - 301_000)
    const staleClaim = new Date(Date.now() - 61_000)
    await utimes(lockDir, staleLock, staleLock)
    await utimes(claimPath, staleClaim, staleClaim)

    await expect(withSandboxRuntimeGenerationLock(root, async () => "reclaimed")).resolves.toBe("reclaimed")
  })

  it("reads the active Windows generation instead of sorting random suffixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const generationsDir = join(root, ".runtime-generations")
    const facade = join(root, "runtime", "sandbox.mjs")
    await mkdir(join(root, "runtime"), { recursive: true })
    await mkdir(generationsDir, { recursive: true })

    for (const generation of ["runtime-zzz", "runtime-aaa", "runtime-mmm"]) {
      await writeFile(facade, markSandboxRuntimeGeneration("export default {}\n", join(generationsDir, generation)))
      await expect(readSandboxRuntimeGeneration(facade, generationsDir)).resolves.toBe(join(generationsDir, generation))
    }
  })
})
