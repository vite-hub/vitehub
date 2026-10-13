import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  consoleSectionGroupIds,
  consoleSectionGroupLabels,
  groupConsoleSections,
  consoleBuiltinSectionIds,
  consoleGoToKey,
  consoleOverviewShortcut,
  consoleSectionDetails,
  consoleSectionShortcut,
  consoleSectionShortcutKeys,
  consoleSectionRouteName,
  isConsoleConnectionsEnabled,
  prioritizeConsoleSectionIds,
  readLastConsoleSection,
  rememberConsoleSection,
  resolveConsoleSectionGroup,
  resolveConsoleSectionIds,
} from "../src/console/runtime/sections.ts"
import { consoleContributedSections } from "../src/console/contributions.ts"

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
  it("only advertises Connections when management is mounted", () => {
    expect(isConsoleConnectionsEnabled({ connections: true }, true)).toBe(true)
    expect(isConsoleConnectionsEnabled({ connections: { management: false } }, true)).toBe(true)
    expect(isConsoleConnectionsEnabled({ connections: false }, true)).toBe(false)
    expect(isConsoleConnectionsEnabled({ connections: { management: true } })).toBe(true)
    expect(isConsoleConnectionsEnabled({ connections: true })).toBe(false)
    expect(isConsoleConnectionsEnabled({ connections: { management: false } })).toBe(false)
  })

  it("derives enabled primitive sections, including Agent-enabled Workflow", () => {
    expect(resolveConsoleSectionIds({ agent: true, blob: true, connections: true, database: true, kv: true, queue: true, rateLimit: true, sandbox: true, schedule: true, workflow: true, workspace: true })).toEqual([
      "connections",
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
    expect(resolveConsoleSectionIds({ connections: true })).toEqual(["connections"])
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
    expect(resolveConsoleSectionIds({ connections: true })).toEqual(["connections"])
    expect(resolveConsoleSectionIds({ connections: false })).toEqual([])
    expect(resolveConsoleSectionIds({ env: false })).toEqual([])
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
    for (const section of consoleBuiltinSectionIds) {
      expect(consoleSectionDetails[section].routeName).toBe(consoleSectionRouteName(section))
      expect(client).toContain(`name: "${consoleSectionDetails[section].routeName}"`)
    }
    expect(client).toContain("subscribeConsoleNavigation(sectionsBase, addContributedRoutes)")
    expect(client).toContain("const name = consoleSectionRouteName(section)")
    expect(client).toContain('return router.resolve(to.fullPath).matched.length > 0 ? to.fullPath : { name: "vitehub-console" }')
  })
})

describe("Console section groups", () => {
  it("groups the rail by purpose, keeps the navigation order, and puts unknown sections last", () => {
    const ids = ["env", "connections", "agents", "usage", "blob", "databases", "email", "kv", "rate-limits", "sandboxes", "workspaces", "workflows", "queues", "schedules", "custom-tool"]
    const groups = groupConsoleSections(ids.map(id => ({ id }))).map(group => group.map(section => section.id))
    expect(groups).toEqual([
      ["agents", "usage"],
      ["blob", "databases", "kv", "workspaces"],
      ["sandboxes", "workflows", "queues", "schedules"],
      ["env", "connections", "email", "rate-limits"],
      ["custom-tool"],
    ])
  })

  it("drops empty groups", () => {
    expect(groupConsoleSections([{ id: "kv" }, { id: "env" }]).map(group => group.map(section => section.id))).toEqual([["kv"], ["env"]])
  })

  it("does not read inherited keys as groups", () => {
    expect(groupConsoleSections([{ id: "constructor" }]).map(group => group.map(section => section.id))).toEqual([["constructor"]])
  })

  it("labels every group and resolves the group of one section", () => {
    expect(consoleSectionGroupIds.map(group => consoleSectionGroupLabels[group])).toEqual(["Agents", "Data", "Runtime", "Platform", "More"])
    expect(resolveConsoleSectionGroup("usage")).toBe("agents")
    expect(resolveConsoleSectionGroup("schedules")).toBe("runtime")
    expect(resolveConsoleSectionGroup("custom-tool")).toBe("more")
    expect(resolveConsoleSectionGroup("constructor")).toBe("more")
  })
})

describe("Console Go to shortcuts", () => {
  it("gives every built-in and contributed section one unique chord", () => {
    const known = [...consoleBuiltinSectionIds, ...consoleContributedSections.keys()]
    for (const section of known) expect(consoleSectionShortcut(section)?.[0]).toBe(consoleGoToKey)
    expect(Object.keys(consoleSectionShortcutKeys).sort()).toEqual([...new Set(known)].sort())
    const keys = [consoleOverviewShortcut[1], ...Object.values(consoleSectionShortcutKeys)]
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^[a-z]$/)
  })

  it("keeps the documented chords stable", () => {
    expect(consoleOverviewShortcut).toEqual(["g", "o"])
    expect(Object.fromEntries(Object.keys(consoleSectionShortcutKeys).map(section => [section, consoleSectionShortcut(section)?.join(" ")]))).toEqual({
      agents: "g a",
      usage: "g u",
      databases: "g d",
      kv: "g k",
      blob: "g b",
      workspaces: "g w",
      workflows: "g f",
      queues: "g q",
      schedules: "g s",
      sandboxes: "g x",
      env: "g e",
      connections: "g c",
      email: "g m",
      "rate-limits": "g r",
    })
  })

  it("gives no chord to unknown or inherited section ids", () => {
    expect(consoleSectionShortcut("custom-tool")).toBeUndefined()
    expect(consoleSectionShortcut("constructor")).toBeUndefined()
  })
})
