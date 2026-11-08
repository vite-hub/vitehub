import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { afterEach, expect, it } from "vitest"

import { getViteHubTestMode } from "../src/internal/test-mode.ts"
import { enableViteHubTestMode } from "../src/internal/test-mode-setup.ts"

const testModeKey = Symbol.for("vitehub.test")

afterEach(() => {
  Reflect.deleteProperty(globalThis, testModeKey)
})

it("is off until a test turns it on, and every copy sees the same mode", () => {
  expect(getViteHubTestMode()).toBeUndefined()
  const mode = enableViteHubTestMode({ root: "/app" })
  expect(getViteHubTestMode()).toBe(mode)
  expect(Reflect.get(globalThis, testModeKey)).toBe(mode)
  expect(enableViteHubTestMode({ root: "/app" })).toBe(mode)
})

it("keeps a backend until reset, then disposes it and starts again", async () => {
  const mode = enableViteHubTestMode()
  const disposed: string[] = []
  let created = 0
  const create = () => ({ id: ++created })

  const first = mode.backend("kv", create, value => disposed.push(`kv ${value.id}`))
  expect(mode.backend("kv", create)).toBe(first)
  expect(mode.peek("kv")).toBe(first)
  mode.env.MAIL_FROM = "hello@example.com"
  const directory = await mode.directory("blob:default")
  expect(existsSync(directory)).toBe(true)

  await mode.reset()

  expect(disposed).toEqual(["kv 1"])
  expect(mode.peek("kv")).toBeUndefined()
  expect(mode.env).toEqual({})
  expect(existsSync(directory)).toBe(false)
  expect(mode.backend("kv", create)).toEqual({ id: 2 })
})

it("keeps temporary folders under each app root in the same process", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-test-roots-"))
  const first = enableViteHubTestMode({ root: join(root, "first") })
  const second = enableViteHubTestMode({ root: join(root, "second") })
  try {
    const firstDirectory = await first.directory("kv")
    const secondDirectory = await second.directory("blob")
    expect(relative(first.root, firstDirectory)).toMatch(/^\.vitehub[/\\]test[/\\]/)
    expect(relative(second.root, secondDirectory)).toMatch(/^\.vitehub[/\\]test[/\\]/)
    await first.reset()
    expect(existsSync(firstDirectory)).toBe(false)
    expect(existsSync(secondDirectory)).toBe(true)
  }
  finally {
    await first.reset()
    await second.reset()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(["kv", "blob"])("keeps %s stores with different punctuation separate", async (primitive) => {
  const mode = enableViteHubTestMode()
  try {
    const first = await mode.directory(`${primitive}-foo/bar`)
    const second = await mode.directory(`${primitive}-foo:bar`)
    await writeFile(join(first, "value"), "first store")

    expect(existsSync(join(second, "value"))).toBe(false)
    expect(await mode.directory(`${primitive}-foo/bar`)).toBe(first)
    expect(await mode.directory(`${primitive}-foo:bar`)).toBe(second)
  }
  finally {
    await mode.reset()
  }
})
