import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { packageTypecheckCompiler } from "./package-typecheck.mjs"

describe("package typecheck compiler", () => {
  it.each([
    ["darwin", "arm64"], ["darwin", "x64"],
    ["linux", "arm64"], ["linux", "x64"], ["win32", "x64"],
  ])("uses tsrs on %s %s", (platform, arch) => {
    expect(packageTypecheckCompiler(platform, arch).href).toBe(
      new URL("./bin/tsrs", import.meta.resolve("tsrs/package.json")).href,
    )
  })

  it.each([
    ["win32", "arm64"], ["linux", "arm"], ["freebsd", "x64"],
  ])("retains an available native compiler on %s %s", (platform, arch) => {
    const manifest = new URL(import.meta.resolve("typescript-native/package.json"))
    expect(packageTypecheckCompiler(platform, arch).href).toBe(new URL("./bin/tsc", manifest).href)
    const { optionalDependencies } = JSON.parse(readFileSync(manifest, "utf8"))
    expect(optionalDependencies).toHaveProperty(`@typescript/typescript-${platform}-${arch}`)
  })

  it.each([
    ["package launcher", new URL("./package-typecheck.mjs", import.meta.url)],
    ["fallback compiler", packageTypecheckCompiler("win32", "arm64")],
  ])("%s checks the requested project without emitting and reports errors", (_, compiler) => {
    const root = mkdtempSync(join(tmpdir(), "vitehub-typecheck-"))
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ files: ["input.ts"] }))
      writeFileSync(join(root, "input.ts"), "export const value: string = 'valid'\n")
      const check = () => spawnSync(process.execPath, [fileURLToPath(compiler), "--noEmit", "-p", "tsconfig.json"], {
        cwd: root,
        encoding: "utf8",
      })
      const valid = check()
      expect(valid.error).toBeUndefined()
      expect(valid.status, valid.stdout + valid.stderr).toBe(0)
      expect(readdirSync(root).sort()).toEqual(["input.ts", "tsconfig.json"])

      writeFileSync(join(root, "input.ts"), "export const value: string = 42\n")
      const invalid = check()
      expect(invalid.error).toBeUndefined()
      expect(invalid.status).toBeGreaterThan(0)
      expect(invalid.stdout + invalid.stderr).toContain("TS2322")
      expect(readdirSync(root).sort()).toEqual(["input.ts", "tsconfig.json"])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("checks every repeated project and fails when any of them has errors", () => {
    const root = mkdtempSync(join(tmpdir(), "vitehub-typecheck-"))
    try {
      for (const project of ["first", "second"]) {
        mkdirSync(join(root, project))
        writeFileSync(join(root, project, "tsconfig.json"), JSON.stringify({ files: ["input.ts"] }))
      }
      const check = () => spawnSync(process.execPath, [
        fileURLToPath(new URL("./package-typecheck.mjs", import.meta.url)),
        "--noEmit", "-p", "first/tsconfig.json", "-p", "second/tsconfig.json",
      ], { cwd: root, encoding: "utf8" })

      writeFileSync(join(root, "first", "input.ts"), "export const value: string = 42\n")
      writeFileSync(join(root, "second", "input.ts"), "export const value: number = 'text'\n")
      const invalid = check()
      expect(invalid.status).toBeGreaterThan(0)
      expect(invalid.stdout + invalid.stderr).toContain("first")
      expect(invalid.stdout + invalid.stderr).toContain("second")

      writeFileSync(join(root, "first", "input.ts"), "export const value: string = 'valid'\n")
      const second = check()
      expect(second.status).toBeGreaterThan(0)
      expect(second.stdout + second.stderr).toContain("second")

      writeFileSync(join(root, "second", "input.ts"), "export const value: number = 1\n")
      const valid = check()
      expect(valid.status, valid.stdout + valid.stderr).toBe(0)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
