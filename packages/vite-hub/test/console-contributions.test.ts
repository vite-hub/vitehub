import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { consoleContributedSections, consoleRuntimeReaderModule, describeConsoleContributedSections, describeConsoleRuntimeReaders, isConsoleContributedSectionId } from "../src/console/contributions.ts"
import { parseConsoleContributedSection, parseConsoleSectionContent } from "../src/console/runtime/definitions.ts"
import { consoleBuiltinSectionIds, consolePrimitives, consoleSectionRouteName, isConsoleBuiltinSectionId, isConsoleSectionId, resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"

describe("Console section contributions", () => {
  it("registers the owner sections with valid ids that do not replace built-in sections", () => {
    expect([...consoleContributedSections.keys()]).toEqual(["email", "rate-limits", "sandboxes", "workspaces", "workflows", "queues", "schedules"])
    for (const [id, section] of consoleContributedSections) {
      expect(section.descriptor.id).toBe(id)
      expect(isConsoleSectionId(id)).toBe(true)
      expect(isConsoleBuiltinSectionId(id)).toBe(false)
      expect(section.descriptor.label).not.toBe("")
      expect(section.descriptor.icon).toMatch(/^i-/)
      expect(section.descriptor.view.notice).not.toBe("")
    }
    for (const id of consoleBuiltinSectionIds) expect(isConsoleContributedSectionId(id)).toBe(false)
  })

  it("keeps navigation order and omits built-in sections", () => {
    const sections = resolveConsoleSectionIds({ agent: true, database: true, kv: true, queue: true, rateLimit: true, sandbox: true, schedule: true, workflow: true, workspace: true })

    expect(describeConsoleContributedSections(sections).map(section => section.id)).toEqual([
      "rate-limits",
      "sandboxes",
      "workspaces",
      "workflows",
      "queues",
      "schedules",
    ])
    expect(describeConsoleContributedSections(["agents", "kv", "databases"])).toEqual([])
    expect(consoleSectionRouteName("queues")).toBe("vitehub-console-queues")
  })

  it("maps request-time readers to vite-hub exports", async () => {
    const manifest: { exports: Record<string, unknown> } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

    expect(consoleRuntimeReaderModule("@vite-hub/schedule/runtime/console")).toBe("vite-hub/_internal/schedule/runtime/console")
    expect(describeConsoleRuntimeReaders(["agents", "email", "queues", "schedules"])).toEqual([
      { export: "readEmailOutboxConsoleRecords", module: "vite-hub/_internal/email/runtime/console", section: "email" },
      { export: "readScheduleConsoleRecords", module: "vite-hub/_internal/schedule/runtime/console", section: "schedules" },
    ])
    for (const reader of describeConsoleRuntimeReaders([...consoleContributedSections.keys()])) {
      expect(Object.hasOwn(manifest.exports, reader.module.replace(/^vite-hub\//, "./")), reader.module).toBe(true)
    }
  })

  it("preserves manual Schedule run metadata when parsing section content", () => {
    const definition = { fields: [], file: "sync.ts", name: "sync", runnable: true, source: "server-schedules" }
    expect(parseConsoleSectionContent({ definitions: [definition], kind: "definition-catalog", section: "schedules" }, "schedules")).toEqual({ definitions: [definition], kind: "definition-catalog" })
    const record = { cells: {}, fields: [], id: "definition:sync", runnable: true }
    expect(parseConsoleSectionContent({ records: [record], kind: "record-table", section: "schedules" }, "schedules")).toEqual({ records: [record], kind: "record-table" })
  })

  it("accepts runnable metadata only when it is true", () => {
    const definition = { fields: [], file: "sync.ts", name: "sync", source: "server-schedules" }
    for (const runnable of [false, "true", 1, undefined]) {
      expect(parseConsoleSectionContent({ definitions: [{ ...definition, runnable }], kind: "definition-catalog", section: "schedules" }, "schedules")).toEqual({ definitions: [definition], kind: "definition-catalog" })
    }
  })

  it("serializes descriptors that the Console UI can parse", () => {
    for (const descriptor of describeConsoleContributedSections([...consoleContributedSections.keys()])) {
      expect(parseConsoleContributedSection(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor)
    }
  })

  it("keeps the playground descriptors equal to the owner descriptors", async () => {
    // The playground is outside this package's TypeScript root, so load it at test time.
    const { playgroundConsoleContributions } = await vi.importActual<{
      playgroundConsoleContributions: ReadonlyArray<{ id: string }>
    }>("../../../playground/console/sections.ts")

    expect(playgroundConsoleContributions.length).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(playgroundConsoleContributions))).toEqual(
      describeConsoleContributedSections(playgroundConsoleContributions.map(section => section.id)),
    )
  })

  it("reads each owner section as serializable content", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-contributions-"))
    try {
      for (const [id, section] of consoleContributedSections) {
        const content = await section.read({ discoveryRoot: root, projectRoot: root })
        expect(content.kind, id).toBe(section.descriptor.view.kind)
        expect(parseConsoleSectionContent(JSON.parse(JSON.stringify({ ...content, section: id })), id), id).toEqual(content)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("Console primitive catalog", () => {
  it("lists every built-in and contributed section once, with the owner label and icon", () => {
    const ids = consolePrimitives.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...consoleBuiltinSectionIds, ...consoleContributedSections.keys()].sort())
    // The Overview shows primitives that are not enabled, so the catalog repeats the owner descriptor.
    for (const [id, section] of consoleContributedSections) {
      const entry = consolePrimitives.find(primitive => primitive.id === id)
      expect(entry?.label).toBe(section.descriptor.label)
      expect(entry?.icon).toBe(section.descriptor.icon)
    }
  })

  it("links each primitive to its documentation and setup guide", () => {
    for (const entry of consolePrimitives) {
      expect(entry.docs).toMatch(/^https:\/\/vitehub\.dev\/docs\/[a-z/-]+$/)
      expect(entry.setup).toMatch(/^https:\/\/vitehub\.dev\/docs\/[a-z/-]+$/)
      expect(entry.pitch.length).toBeGreaterThan(20)
    }
  })
})
