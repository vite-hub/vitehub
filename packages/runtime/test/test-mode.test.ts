import { existsSync } from "node:fs"

import { afterEach, expect, it } from "vitest"

import { enableViteHubTestMode, getViteHubTestMode } from "../src/internal/test-mode.ts"

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
