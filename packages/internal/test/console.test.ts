import { describe, expect, it } from "vitest"

import { describeViteHubConsoleSection, isViteHubConsoleSectionId, readViteHubConsoleSection } from "../src/console.ts"

import type { ViteHubConsoleSectionContribution } from "../src/console.ts"

const catalog: ViteHubConsoleSectionContribution<{ rootDir: string }> = {
  description: "Inspect discovered Widget Definitions.",
  icon: "i-ph-cube-light",
  id: "widgets",
  label: "Widgets",
  read: async ({ rootDir }) => [{ fields: [{ label: "Root", value: rootDir }], file: "server/widgets/a.ts", name: "a", source: "server-widgets" }],
  view: { kind: "definition-catalog", notice: "Runtime widget state is not included." },
}

const table: ViteHubConsoleSectionContribution = {
  description: "Inspect recent widget runs.",
  icon: "i-ph-list-light",
  id: "widget-runs",
  label: "Widget Runs",
  read: () => [{ cells: { status: "done" }, fields: [{ label: "Status", value: "done" }], id: "run-1" }],
  view: { columns: [{ key: "status", label: "Status" }], kind: "record-table", notice: "Only the last 50 runs are shown." },
}

describe("Console section contributions", () => {
  it("accepts lowercase route segments as section ids", () => {
    expect(["queues", "rate-limits", "a1"].every(isViteHubConsoleSectionId)).toBe(true)
    expect(["", "Queues", "rate_limits", "-queues", "queues-", "a--b", "a/b", 1].some(isViteHubConsoleSectionId)).toBe(false)
  })

  it("returns only the serializable descriptor", () => {
    const descriptor = describeViteHubConsoleSection(table)
    expect(descriptor).toEqual({
      description: "Inspect recent widget runs.",
      icon: "i-ph-list-light",
      id: "widget-runs",
      label: "Widget Runs",
      view: { columns: [{ key: "status", label: "Status" }], kind: "record-table", notice: "Only the last 50 runs are shown." },
    })
    expect("read" in descriptor).toBe(false)
    expect(JSON.parse(JSON.stringify(describeViteHubConsoleSection(catalog)))).toEqual({
      description: "Inspect discovered Widget Definitions.",
      icon: "i-ph-cube-light",
      id: "widgets",
      label: "Widgets",
      view: { kind: "definition-catalog", notice: "Runtime widget state is not included." },
    })
  })

  it("rejects ids that are not route segments", () => {
    expect(() => describeViteHubConsoleSection({ ...table, id: "Widget Runs" })).toThrow(TypeError)
  })

  it("reads content that matches the view kind", async () => {
    await expect(readViteHubConsoleSection(catalog, { rootDir: "/app" })).resolves.toEqual({
      definitions: [{ fields: [{ label: "Root", value: "/app" }], file: "server/widgets/a.ts", name: "a", source: "server-widgets" }],
      kind: "definition-catalog",
    })
    await expect(readViteHubConsoleSection(table, undefined)).resolves.toEqual({
      kind: "record-table",
      records: [{ cells: { status: "done" }, fields: [{ label: "Status", value: "done" }], id: "run-1" }],
    })
  })
})
