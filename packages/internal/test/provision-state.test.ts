import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { mergeProvisionState, readProvisionedId, readProvisionState, writeProvisionState } from "../src/provision-state.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provision-state-"))
  directories.push(rootDir)
  return rootDir
}

describe("provision state", () => {
  it("merges ids without dropping existing entries", () => {
    const merged = mergeProvisionState(
      { cloudflare: { d1: { primary: "id-1" } } },
      { cloudflare: { d1: { analytics: "id-2" } } },
    )
    expect(merged).toEqual({ cloudflare: { d1: { primary: "id-1", analytics: "id-2" } } })
  })

  it("writes ids to .vitehub/provision.json with stable key order and reads them back", async () => {
    const rootDir = await createTempDir()
    await writeProvisionState(rootDir, { cloudflare: { d1: { primary: "id-1" } } })
    await writeProvisionState(rootDir, { cloudflare: { d1: { analytics: "id-2" } } })

    const raw = await readFile(join(rootDir, ".vitehub", "provision.json"), "utf8")
    expect(raw).toBe(`${JSON.stringify({ cloudflare: { d1: { analytics: "id-2", primary: "id-1" } } }, null, 2)}\n`)

    const state = await readProvisionState(rootDir)
    expect(readProvisionedId(state, "cloudflare", "d1", "primary")).toBe("id-1")
    expect(readProvisionedId(state, "cloudflare", "d1", "analytics")).toBe("id-2")
  })

  it("only persists the non-secret ids it is given", async () => {
    const rootDir = await createTempDir()
    await writeProvisionState(rootDir, { cloudflare: { d1: { primary: "id-1" } } })
    const raw = await readFile(join(rootDir, ".vitehub", "provision.json"), "utf8")
    expect(raw).not.toMatch(/token|secret/i)
  })

  it("does not return inherited categories or identifiers", () => {
    const state = { cloudflare: { d1: { primary: "id-1" } } }
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(readProvisionedId(state, "cloudflare", "d1", name)).toBeUndefined()
      expect(readProvisionedId(state, "cloudflare", name, "constructor")).toBeUndefined()
    }
  })

  it("merges and round-trips prototype-named categories and identifiers", async () => {
    const rootDir = await createTempDir()
    const initial = JSON.parse('{"cloudflare":{"__proto__":{"__proto__":"id-1"},"constructor":{"toString":"id-2"}}}')
    const next = JSON.parse('{"cloudflare":{"__proto__":{"constructor":"id-3"}}}')
    await writeProvisionState(rootDir, initial)
    await writeProvisionState(rootDir, next)
    const state = await readProvisionState(rootDir)
    expect(readProvisionedId(state, "cloudflare", "__proto__", "__proto__")).toBe("id-1")
    expect(readProvisionedId(state, "cloudflare", "__proto__", "constructor")).toBe("id-3")
    expect(readProvisionedId(state, "cloudflare", "constructor", "toString")).toBe("id-2")
    expect(Object.getPrototypeOf(state.cloudflare)).toBe(Object.prototype)
    expect(Object.hasOwn(state.cloudflare!, "__proto__")).toBe(true)
  })

  it("preserves provision categories and identifiers named __proto__", async () => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub", "provision.json"), '{"cloudflare":{"__proto__":{"__proto__":"id-prototype"}}}')

    const state = await readProvisionState(rootDir)
    expect(readProvisionedId(state, "cloudflare", "__proto__", "__proto__")).toBe("id-prototype")
  })
})
