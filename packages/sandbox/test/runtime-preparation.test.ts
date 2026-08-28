import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  activateSandboxRuntimeFile,
  markSandboxRuntimeGeneration,
  pruneSandboxRuntimeGeneration,
  readSandboxRuntimeGeneration,
  resolveSandboxRuntimeFacadeImportBase,
  resolveSandboxRuntimeLinkType,
  withSandboxRuntimeGenerationLock,
} from "../src/internal/runtime-generation.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Sandbox runtime preparation", () => {
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

  it("retires only the observed lock while a successor writer is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-"))
    tempDirs.push(root)
    const lockDir = join(root, ".runtime-generation.lock")
    let continueRemoval!: () => void
    let releaseSuccessor!: () => void
    const removalStarted = Promise.withResolvers<void>()
    const removalContinued = new Promise<void>((resolve) => { continueRemoval = resolve })
    const successorStarted = Promise.withResolvers<void>()
    const successorReleased = new Promise<void>((resolve) => { releaseSuccessor = resolve })

    const first = withSandboxRuntimeGenerationLock(root, async () => "first", {
      removeLock: (async (path, options) => {
        expect(path).not.toBe(lockDir)
        removalStarted.resolve()
        await removalContinued
        await rm(path, options)
      }) as typeof rm,
    })
    await removalStarted.promise
    const second = withSandboxRuntimeGenerationLock(root, async (lease) => {
      successorStarted.resolve()
      await successorReleased
      await expect(lease.assertOwned()).resolves.toBeUndefined()
      return "second"
    })
    await successorStarted.promise

    continueRemoval()
    await expect(first).resolves.toBe("first")
    await expect(readFile(join(lockDir, "owner.json"), "utf8")).resolves.toContain("token")
    releaseSuccessor()
    await expect(second).resolves.toBe("second")
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
