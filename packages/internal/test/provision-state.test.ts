import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createProvisionNamespace } from "../../cli/src/provision.ts"
import { getProvisionStatePath, mergeProvisionState, readProvisionedId, readProvisionState, readProvisionStateSync, writeProvisionState } from "../src/provision-state.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provision-state-"))
  directories.push(rootDir)
  return rootDir
}

async function createStateFile(raw: string) {
  const rootDir = await createTempDir()
  const path = getProvisionStatePath(rootDir)
  await mkdir(join(rootDir, ".vitehub"))
  await writeFile(path, raw)
  return { path, rootDir }
}

const invalidState = '{"cloudflare":{"d1":{"primary":"existing-id"}},}'

describe.each([
  ["async", readProvisionState],
  ["sync", readProvisionStateSync],
] as const)("%s provision state reader", (_, read) => {
  it("returns empty state when the file is missing", async () => {
    const rootDir = await createTempDir()
    expect(await read(rootDir)).toEqual({})
    await mkdir(join(rootDir, ".vitehub"))
    expect(await read(rootDir)).toEqual({})
  })

  it.each([invalidState, ""])("rejects invalid JSON %j with its path and original cause", async (raw) => {
    const { path, rootDir } = await createStateFile(raw)
    await expect(async () => read(rootDir)).rejects.toMatchObject({
      code: "INTERNAL_R0014",
      message: expect.stringContaining(path),
      cause: expect.any(SyntaxError),
    })
    expect(await readFile(path, "utf8")).toBe(raw)
  })

  it("rejects filesystem errors other than ENOENT", async () => {
    const rootDir = await createTempDir()
    const path = getProvisionStatePath(rootDir)
    await writeFile(join(rootDir, ".vitehub"), "obstruction")
    await expect(async () => read(rootDir)).rejects.toMatchObject({
      code: "INTERNAL_R0014",
      message: expect.stringContaining(path),
      cause: expect.objectContaining({ code: "ENOTDIR" }),
    })
  })

  it.each(["null", "[]", "42", '"value"'])("keeps the empty-state policy for a valid non-object root %s", async (raw) => {
    const { rootDir } = await createStateFile(raw)
    expect(await read(rootDir)).toEqual({})
  })

  it("keeps valid IDs while filtering unsupported shapes", async () => {
    const { rootDir } = await createStateFile(JSON.stringify({
      cloudflare: { d1: { primary: "id-1", invalid: 42 }, kv: [], empty: { invalid: null } },
      vercel: { blob: { assets: "id-2" }, invalid: null },
      unknown: { resource: { name: "id-3" } },
    }))
    expect(await read(rootDir)).toEqual({
      cloudflare: { d1: { primary: "id-1" } },
      vercel: { blob: { assets: "id-2" } },
    })
  })
})

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
    await writeProvisionState(rootDir, { vercel: { blob: { assets: "id-3" } } })
    expect(await readProvisionState(rootDir)).toEqual({ ...state, vercel: { blob: { assets: "id-3" } } })
  })

  it.each([invalidState, ""])("refuses to overwrite invalid state %j", async (raw) => {
    const { path, rootDir } = await createStateFile(raw)
    const original = await readFile(path)
    await expect(writeProvisionState(rootDir, { vercel: { blob: { assets: "new-id" } } })).rejects.toMatchObject({
      code: "INTERNAL_R0014",
      cause: expect.any(SyntaxError),
    })
    expect(await readFile(path)).toEqual(original)
  })

  it("refuses writes after a read error and preserves the obstruction", async () => {
    const rootDir = await createTempDir()
    const path = join(rootDir, ".vitehub")
    await writeFile(path, "existing bytes")
    const original = await readFile(path)
    await expect(writeProvisionState(rootDir, { vercel: { blob: { assets: "new-id" } } })).rejects.toMatchObject({
      code: "INTERNAL_R0014",
      cause: expect.objectContaining({ code: "ENOTDIR" }),
    })
    expect(await readFile(path)).toEqual(original)
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

describe("provision status", () => {
  function createStatus(rootDir: string) {
    const plan = vi.fn(async () => [])
    const status = createProvisionNamespace([{ id: "test", provider: "cloudflare", plan }]).features.find(feature => feature.name === "status")!
    const context = {
      cwd: rootDir,
      env: { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token" },
      rootDir,
      spawn: vi.fn(),
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    }
    return { context, plan, status }
  }

  it.each([{ mode: "human", options: [] }, { mode: "JSON", options: ["--json"] }])("rejects corrupt state before reporting or planning in $mode mode", async ({ options }) => {
    const { path, rootDir } = await createStateFile(invalidState)
    const original = await readFile(path)
    const { context, plan, status } = createStatus(rootDir)
    await expect(status.run(["--provider", "cloudflare", ...options], context)).rejects.toMatchObject({
      code: "INTERNAL_R0014",
      message: expect.stringContaining(path),
      cause: expect.any(SyntaxError),
    })
    expect(context.stdout.write).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
    expect(await readFile(path)).toEqual(original)
  })

  it("rejects a state read error before reporting or planning", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, ".vitehub"), "obstruction")
    const { context, plan, status } = createStatus(rootDir)
    await expect(status.run(["--provider", "cloudflare", "--json"], context)).rejects.toMatchObject({
      code: "INTERNAL_R0014",
      cause: expect.objectContaining({ code: "ENOTDIR" }),
    })
    expect(context.stdout.write).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
  })

  it("reports missing state and persisted IDs", async () => {
    const rootDir = await createTempDir()
    const { context, status } = createStatus(rootDir)
    const args = ["--provider", "cloudflare", "--json"]
    expect(await status.run(args, context)).toBe(0)
    expect(JSON.parse(context.stdout.write.mock.lastCall![0])).toMatchObject({ recorded: {} })
    await writeProvisionState(rootDir, { cloudflare: { d1: { primary: "id-1" } } })
    expect(await status.run(args, context)).toBe(0)
    expect(JSON.parse(context.stdout.write.mock.lastCall![0])).toMatchObject({ recorded: { d1: { primary: "id-1" } } })
  })
})
