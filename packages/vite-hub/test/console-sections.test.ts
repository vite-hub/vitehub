import { describe, expect, it } from "vitest"

import {
  prioritizeConsoleSectionIds,
  readLastConsoleSection,
  rememberConsoleSection,
} from "../src/console/runtime/sections.ts"

function memoryStorage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
    },
  }
}

describe("Console section preferences", () => {
  it("prioritizes the last active section without losing configured sections", () => {
    expect(prioritizeConsoleSectionIds(["agents", "kv"], "kv")).toEqual(["kv", "agents"])
    expect(prioritizeConsoleSectionIds(["agents"], "kv")).toEqual(["agents"])
    expect(prioritizeConsoleSectionIds(["agents", "kv"], undefined)).toEqual(["agents", "kv"])
  })

  it("persists and validates the last section", () => {
    const storage = memoryStorage()

    expect(readLastConsoleSection(storage)).toBeUndefined()
    rememberConsoleSection("kv", storage)
    expect(readLastConsoleSection(storage)).toBe("kv")
    expect(readLastConsoleSection(memoryStorage("future-primitive"))).toBeUndefined()
  })

  it("keeps navigation usable when browser storage is unavailable", () => {
    const storage = {
      getItem: () => { throw new Error("Storage disabled") },
      setItem: () => { throw new Error("Storage disabled") },
    }

    expect(readLastConsoleSection(storage)).toBeUndefined()
    expect(() => rememberConsoleSection("agents", storage)).not.toThrow()
  })
})
