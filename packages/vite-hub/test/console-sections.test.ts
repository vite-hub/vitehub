import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  consoleBuiltinSectionIds,
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
  it("derives enabled primitive sections, including Agent-enabled Workflow", () => {
    expect(resolveConsoleSectionIds({ agent: true, blob: true, database: true, kv: true, queue: true, rateLimit: true, sandbox: true, schedule: true, workflow: true, workspace: true })).toEqual([
      "agents",
      "usage",
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
    expect(resolveConsoleSectionIds({ agent: true })).toEqual(["agents", "usage", "workflows"])
    expect(resolveConsoleSectionIds({ agent: true, preset: "netlify" })).toEqual(["agents", "usage"])
    expect(resolveConsoleSectionIds({ agent: true, preset: "netlify", workflow: { provider: "vercel" } })).toEqual([
      "agents",
      "usage",
      "workflows",
    ])
    expect(resolveConsoleSectionIds({ agent: true, workflow: false })).toEqual(["agents", "usage"])
    expect(resolveConsoleSectionIds({ agent: true, queue: false, schedule: false, workflow: false })).toEqual(["agents", "usage"])
    expect(resolveConsoleSectionIds({})).toEqual([])
    expect(resolveConsoleSectionIds({ env: true })).toEqual(["env"])
    expect(resolveConsoleSectionIds({ env: false })).toEqual([])
    expect(resolveConsoleSectionIds({ connections: true })).toEqual(["connections"])
    expect(resolveConsoleSectionIds({ connections: { management: true }, env: true, agent: true })).toEqual(["env", "connections", "agents", "usage", "workflows"])
    expect(resolveConsoleSectionIds({ connections: false })).toEqual([])
  })

  it("prioritizes the last active section without losing configured sections", () => {
    expect(prioritizeConsoleSectionIds(["agents", "usage", "kv"], "kv")).toEqual(["kv", "agents", "usage"])
    expect(prioritizeConsoleSectionIds(["agents", "usage", "blob", "databases", "kv", "rate-limits", "sandboxes", "workspaces", "workflows", "queues", "schedules"], "schedules")).toEqual([
      "schedules",
      "agents",
      "usage",
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
    expect(prioritizeConsoleSectionIds(["agents", "usage", "kv"], undefined)).toEqual(["agents", "usage", "kv"])
  })

  it("persists and validates the last section", () => {
    const storage = memoryStorage()

    expect(readLastConsoleSection(storage)).toBeUndefined()
    rememberConsoleSection("schedules", storage)
    expect(readLastConsoleSection(storage)).toBe("schedules")
    expect(readLastConsoleSection(memoryStorage("future-primitive"))).toBe("future-primitive")
    expect(readLastConsoleSection(memoryStorage("Future Primitive"))).toBeUndefined()
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

describe("Console section routes", () => {
  it("gives every built-in section a client route and adds owner contributions dynamically", () => {
    const client = readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")
    const routedSections = new Set([...client.matchAll(/consoleSection: "([^"]+)"/g)].map(match => match[1]))

    expect([...routedSections].sort()).toEqual([...consoleBuiltinSectionIds].sort())
    expect(client).toContain("subscribeConsoleNavigation(sectionsBase, addContributedRoutes)")
    expect(client).toContain("const name = consoleSectionRouteName(section)")
  })
})
