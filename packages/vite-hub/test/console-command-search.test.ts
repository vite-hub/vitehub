import { describe, expect, it } from "vitest"

import { consoleCommandResultLimit, filterConsoleCommandGroups } from "../src/console/runtime/client/command-search.ts"

const groups = [
  { id: "actions", label: "Actions", items: [{ label: "Toggle theme", keywords: ["dark"] }, { label: "Publish changes" }] },
  { id: "go-to", label: "Go to", items: [{ label: "Overview" }, { label: "KV", suffix: "Storage" }, { label: "Media", keywords: ["images"] }] },
  { id: "documents", label: "Recent documents", ignoreFilter: true, items: [{ label: "Welcome post" }] },
]

describe("Console command search", () => {
  it("shows every item for an empty query", () => {
    expect(filterConsoleCommandGroups(groups, "")).toEqual(groups)
  })

  it("puts the group of the best match first, and keeps a group that search does not filter after the groups before it", () => {
    const shown = filterConsoleCommandGroups(groups, "overview")
    expect(shown.map(group => group.id)).toEqual(["go-to", "documents"])
    expect(shown[0]!.items.map(item => item.label)).toEqual(["Overview"])
  })

  it("matches keywords and single words only when asked", () => {
    expect(filterConsoleCommandGroups(groups, "images").map(group => group.id)).toEqual(["documents"])
    expect(filterConsoleCommandGroups(groups, "images", { keywords: true })[0]!.items.map(item => item.label)).toEqual(["Media"])
    expect(filterConsoleCommandGroups(groups, "go to theme", { tokens: true }).flatMap(group => group.items.map(item => item.label))).toContain("Toggle theme")
  })

  it("keeps the group order with preserveGroupOrder", () => {
    const shown = filterConsoleCommandGroups(groups, "e", { preserveGroupOrder: true })
    expect(shown.map(group => group.id)).toEqual(groups.map(group => group.id).filter(id => shown.some(group => group.id === id)))
  })

  it("shows at most the result limit", () => {
    const many = [{ id: "keys", items: Array.from({ length: 40 }, (_, index) => ({ label: `cache key ${index}` })) }]
    expect(filterConsoleCommandGroups(many, "cache")[0]!.items).toHaveLength(consoleCommandResultLimit)
    expect(filterConsoleCommandGroups(many, "")[0]!.items).toHaveLength(consoleCommandResultLimit)
  })
})
