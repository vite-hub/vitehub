import { describe, expect, it } from "vitest"

import {
  prioritizeConsoleSectionIds,
  readLastConsoleSection,
  rememberConsoleSection,
  resolveConsoleSectionIds,
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
  it("derives only explicitly configured primitive sections", () => {
    expect(resolveConsoleSectionIds({ agent: true, blob: true, database: true, kv: true, queue: true, rateLimit: true, sandbox: true, schedule: true, workflow: true, workspace: true })).toEqual([
      "agents",
      "blob",
      "databases",
      "kv",
      "rate-limits",
      "sandboxes",
      "workspaces",
      "workflows",
      "queues",
      "schedules",
    ])
    expect(resolveConsoleSectionIds({ agent: true, queue: false, schedule: false, workflow: false })).toEqual(["agents"])
    expect(resolveConsoleSectionIds({})).toEqual([])
  })

  it("prioritizes the last active section without losing configured sections", () => {
    expect(prioritizeConsoleSectionIds(["agents", "blob", "databases", "kv", "rate-limits", "sandboxes", "workspaces", "workflows", "queues", "schedules"], "schedules")).toEqual([
      "schedules",
      "agents",
      "blob",
      "databases",
      "kv",
      "rate-limits",
      "sandboxes",
      "workspaces",
      "workflows",
      "queues",
    ])
    expect(prioritizeConsoleSectionIds(["agents"], "kv")).toEqual(["agents"])
    expect(prioritizeConsoleSectionIds(["agents", "kv"], undefined)).toEqual(["agents", "kv"])
  })

  it("persists and validates the last section", () => {
    const storage = memoryStorage()

    expect(readLastConsoleSection(storage)).toBeUndefined()
    rememberConsoleSection("schedules", storage)
    expect(readLastConsoleSection(storage)).toBe("schedules")
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
