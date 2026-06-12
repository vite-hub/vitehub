import { mkdtemp, readFile, rm } from "node:fs/promises"
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
})
