import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createNodeModulesSnapshot, SnapshotLockfileMismatchError } from "../src/snapshot.ts"

const npm = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util")
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: npm }) }
})

let dir: string
const manifest = '{\n\t"private": true, "dependencies": { "esbuild": "0.28.2" }\n}\n'
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "snapshot-install-"))
  await writeFile(join(dir, "package.json"), manifest)
  npm.mockReset()
  npm.mockImplementation(async () => {
    const installed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
    for (const name of Object.keys(installed.dependencies)) {
      const path = join(dir, "node_modules", name)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, "package.json"), JSON.stringify({ name: name.startsWith("vitehub-wasm-") ? "esbuild-wasm" : name, version: "0.28.2" }))
    }
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ packages: { "": installed } }))
  })
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe.skipIf(process.platform === "win32")("snapshot installs", () => {
  it("installs a wasm alias and restores the caller's exact manifest", async () => {
    const result = await createNodeModulesSnapshot({ dir })
    expect(JSON.parse(result.lockfile).packages[""].dependencies).toHaveProperty("vitehub-wasm-esbuild-wasm-0.28.2", "npm:esbuild-wasm@0.28.2")
    expect(JSON.parse(await readFile(join(dir, "node_modules/esbuild/package.json"), "utf8")).name).toBe("esbuild-wasm")
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(manifest)
    const pinned = await createNodeModulesSnapshot({ dir, lockfile: result.lockfile })
    expect(npm.mock.calls.at(-1)?.[1][0]).toBe("ci")
    expect(pinned.snapshot).toEqual(result.snapshot)
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(manifest)
  })

  it("restores the caller's manifest when npm fails after aliases have been added", async () => {
    const error = new Error("registry unavailable")
    npm.mockImplementationOnce(async () => {
      await mkdir(join(dir, "node_modules/esbuild"), { recursive: true })
      await writeFile(join(dir, "node_modules/esbuild/package.json"), '{"version":"0.28.2"}')
    }).mockRejectedValueOnce(error)
    await expect(createNodeModulesSnapshot({ dir })).rejects.toBe(error)
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(manifest)
  })

  it("reports a confirmed wasm alias mismatch separately", async () => {
    await expect(createNodeModulesSnapshot({ dir, lockfile: '{"packages":{"":{}}}' })).rejects.toBeInstanceOf(SnapshotLockfileMismatchError)
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(manifest)
  })

  it.each([
    "npm error code ETIMEDOUT\nnpm error registry unavailable",
    "npm error code EUSAGE\nnpm error The npm ci command can only install with an existing package-lock.json",
  ])("propagates unrelated npm failures: %s", async (stderr) => {
    const error = Object.assign(new Error("npm failed"), { stderr })
    npm.mockRejectedValueOnce(error)
    await expect(createNodeModulesSnapshot({ dir, lockfile: '{"packages":{"":{}}}' })).rejects.toBe(error)
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(manifest)
  })

  it("restores the manifest and preserves a failure after npm succeeds", async () => {
    const lockfile = '{"packages":{"":{"dependencies":{"vitehub-wasm-esbuild-wasm-0.28.2":"npm:esbuild-wasm@0.28.2"}}}}'
    npm.mockImplementationOnce(async () => {
      await mkdir(join(dir, "node_modules/esbuild"), { recursive: true })
      await writeFile(join(dir, "node_modules/esbuild/package.json"), '{"version":"0.28.2"}')
    })
    await expect(createNodeModulesSnapshot({ dir, lockfile })).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(manifest)
  })

  it("preserves directory scan errors instead of reporting stale wasm aliases", async () => {
    const lockfile = '{"packages":{"":{"dependencies":{"vitehub-wasm-esbuild-wasm-0.28.2":"npm:esbuild-wasm@0.28.2"}}}}'
    npm.mockImplementationOnce(() => writeFile(join(dir, "node_modules"), "not a directory"))
    await expect(createNodeModulesSnapshot({ dir, lockfile })).rejects.toMatchObject({ code: "ENOTDIR" })
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(manifest)
  })
})
