import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { consoleContributedSections, describeConsoleContributedSections, isConsoleContributedSectionId } from "../src/console/contributions.ts"
import { parseConsoleContributedSection, parseConsoleSectionContent } from "../src/console/runtime/definitions.ts"
import { consoleBuiltinSectionIds, consoleSectionRouteName, isConsoleBuiltinSectionId, isConsoleSectionId, resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"

describe("Console section contributions", () => {
  it("registers the owner sections with valid ids that do not replace built-in sections", () => {
    expect([...consoleContributedSections.keys()]).toEqual(["rate-limits", "sandboxes", "workspaces", "workflows", "queues", "schedules"])
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

  it("serializes descriptors that the Console UI can parse", () => {
    for (const descriptor of describeConsoleContributedSections([...consoleContributedSections.keys()])) {
      expect(parseConsoleContributedSection(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor)
    }
  })

  it("preserves runnable Schedule metadata for the Console UI", () => {
    const definition = { fields: [], file: "server/schedules/sync.ts", name: "sync", runnable: true, source: "server-schedules" }
    const content = { definitions: [definition], kind: "definition-catalog", section: "schedules" }

    expect(parseConsoleSectionContent(JSON.parse(JSON.stringify(content)), "schedules")).toEqual({
      definitions: [definition],
      kind: "definition-catalog",
    })
    expect(parseConsoleSectionContent({ ...content, definitions: [{ ...definition, runnable: "true" }] }, "schedules")).toEqual({
      definitions: [{ ...definition, runnable: undefined }],
      kind: "definition-catalog",
    })
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
