import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  activateSandboxRuntimeFile,
  markSandboxRuntimeGeneration,
  pruneSandboxRuntimeGeneration,
  readSandboxRuntimeGeneration,
  resolveSandboxRuntimeFacadeImportBase,
  resolveSandboxRuntimeLinkType,
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
