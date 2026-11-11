import { afterEach, describe, expect, it } from "vitest"
import { runOperation } from "@vite-hub/internal/operations"

import { consoleState } from "../src/console/internal.ts"
import { listConsoleDefinitions } from "../src/console/runtime/server/definitions.get.ts"
import { installConsoleDefinitions } from "../src/console/runtime/server/definitions.ts"
import { consoleOperationRegistry } from "../src/console/runtime/server/operation-contributions.ts"

import type { ConsoleDefinitionSummary, ConsoleSectionCatalog } from "../src/console/runtime/definitions.ts"
import { consoleAccess } from "./support/console-access.ts"

async function definitions(section: string) {
  return listConsoleDefinitions({ section }, await consoleAccess())
}

function catalog(name: string): ConsoleSectionCatalog["content"] {
  return Object.fromEntries(
    Object.entries(definitionSummaries(name)).map(([section, definitions]) => [section, { definitions, kind: "definition-catalog" as const }]),
  )
}

function definitionSummaries(name: string): Record<string, ConsoleDefinitionSummary[]> {
  return {
    databases: [{
      fields: [
        { label: "Mode", value: "Default" },
        { label: "Tables", value: "users, sessions" },
      ],
      file: `server/databases/${name}.ts`,
      name,
      source: "server-databases",
    }],
    queues: [{
      fields: [],
      file: `server/queues/${name}.ts`,
      name,
      source: "server-queues",
    }],
    "rate-limits": [{
      fields: [
        { label: "Limit", value: "10" },
        { label: "Window", value: "1m" },
        { label: "Enforcement", value: "Best effort" },
        { label: "Provider failure", value: "Deny" },
        { label: "Source location", value: "12:5" },
      ],
      file: `server/api/${name}.ts`,
      name,
      source: "require-rate-limit",
    }],
    schedules: [{
      fields: [
        { label: "Kind", value: "Static schedule" },
        { label: "Cron", value: "0 9 * * *" },
        { label: "Time zone", value: "UTC" },
      ],
      file: `server/schedules/${name}.ts`,
      name,
      source: "server-schedules",
    }],
    "sandbox-tasks": [{
      fields: [{ label: "Kind", value: "Definition" }],
      file: `src/${name}.sandbox-task.ts`,
      name,
      source: "vite-suffix",
    }],
    workflows: [{
      fields: [{ label: "Steps", value: "prepare, publish" }],
      file: `server/workflows/${name}.workflow.ts`,
      name,
      source: "server-workflows",
    }],
    workspaces: [{
      fields: [
        { label: "Kind", value: "Workspace Definition" },
        { label: "Source root", value: `server/workspaces/${name}` },
      ],
      file: `server/workspaces/${name}/workspace.ts`,
      name,
      source: "server-workspaces-directory-config",
    }],
  }
}

afterEach(() => {
  delete consoleState().definitions
})

describe("Console definition inspection", () => {
  it("returns the installed read-only Workflow Definition catalog", async () => {
    installConsoleDefinitions("/project", catalog("release"))

    expect(await definitions("workflows")).toEqual({
      definitions: [{
        fields: [{ label: "Steps", value: "prepare, publish" }],
        file: "server/workflows/release.workflow.ts",
        name: "release",
        source: "server-workflows",
      }],
      kind: "definition-catalog",
      section: "workflows",
    })
    expect(await definitions("databases")).toEqual({
      definitions: [{
        fields: [
          { label: "Mode", value: "Default" },
          { label: "Tables", value: "users, sessions" },
        ],
        file: "server/databases/release.ts",
        name: "release",
        source: "server-databases",
      }],
      kind: "definition-catalog",
      section: "databases",
    })
    expect(await definitions("rate-limits")).toEqual({
      definitions: [{
        fields: [
          { label: "Limit", value: "10" },
          { label: "Window", value: "1m" },
          { label: "Enforcement", value: "Best effort" },
          { label: "Provider failure", value: "Deny" },
          { label: "Source location", value: "12:5" },
        ],
        file: "server/api/release.ts",
        name: "release",
        source: "require-rate-limit",
      }],
      kind: "definition-catalog",
      section: "rate-limits",
    })
    expect(await definitions("workspaces")).toEqual({
      definitions: [{
        fields: [
          { label: "Kind", value: "Workspace Definition" },
          { label: "Source root", value: "server/workspaces/release" },
        ],
        file: "server/workspaces/release/workspace.ts",
        name: "release",
        source: "server-workspaces-directory-config",
      }],
      kind: "definition-catalog",
      section: "workspaces",
    })
    expect(await definitions("queues")).toEqual({
      definitions: [{
        fields: [],
        file: "server/queues/release.ts",
        name: "release",
        source: "server-queues",
      }],
      kind: "definition-catalog",
      section: "queues",
    })
    expect(await definitions("schedules")).toEqual({
      definitions: [{
        fields: [
          { label: "Kind", value: "Static schedule" },
          { label: "Cron", value: "0 9 * * *" },
          { label: "Time zone", value: "UTC" },
        ],
        file: "server/schedules/release.ts",
        name: "release",
        source: "server-schedules",
      }],
      kind: "definition-catalog",
      section: "schedules",
    })
    expect(await definitions("sandbox-tasks")).toEqual({
      definitions: [{
        fields: [{ label: "Kind", value: "Definition" }],
        file: "src/release.sandbox-task.ts",
        name: "release",
        source: "vite-suffix",
      }],
      kind: "definition-catalog",
      section: "sandbox-tasks",
    })
  })

  it("validates definition sections", async () => {
    installConsoleDefinitions("/project", { workflows: { definitions: [], kind: "definition-catalog" } })

    // Console access cannot scope a call without a section, so it rejects the call before the reader runs.
    await expect(runOperation(consoleOperationRegistry(), "definitions.list", { section: "" }, { access: await consoleAccess(), surface: "console", user: null })).resolves.toMatchObject({ ok: false, status: 403 })
    await expect(definitions("Future")).rejects.toThrow(expect.objectContaining({ statusCode: 400 }))
    await expect(definitions("future")).rejects.toThrow(expect.objectContaining({ statusCode: 404 }))
    await expect(definitions("constructor")).rejects.toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("merges request-time records into record-table sections", async () => {
    let runtimeRecords = [{ cells: { schedule: "digest" }, fields: [{ label: "State", value: "Enabled" }], id: "runtime:digest" }]
    installConsoleDefinitions("/project", {
      schedules: {
        kind: "record-table",
        records: [
          { cells: { schedule: "daily" }, fields: [], id: "definition:daily" },
          { cells: { schedule: "stale" }, fields: [], id: "runtime:digest" },
        ],
      },
      workflows: { definitions: [], kind: "definition-catalog" },
    }, [], {
      schedules: () => runtimeRecords,
      workflows: () => [{ cells: {}, fields: [], id: "ignored" }],
    })

    expect(await definitions("schedules")).toEqual({
      kind: "record-table",
      records: [
        { cells: { schedule: "daily" }, fields: [], id: "definition:daily" },
        { cells: { schedule: "digest" }, fields: [{ label: "State", value: "Enabled" }], id: "runtime:digest" },
      ],
      section: "schedules",
    })
    expect(await definitions("workflows")).toEqual({ definitions: [], kind: "definition-catalog", section: "workflows" })

    runtimeRecords = []
    expect(await definitions("schedules")).toEqual({
      kind: "record-table",
      records: [
        { cells: { schedule: "daily" }, fields: [], id: "definition:daily" },
        { cells: { schedule: "stale" }, fields: [], id: "runtime:digest" },
      ],
      section: "schedules",
    })
  })

  it("updates the cells and fields of a build-time record from its runtime record", async () => {
    installConsoleDefinitions("/project", {
      schedules: {
        kind: "record-table",
        records: [{
          cells: { manual: "No", schedule: "brief", timing: "15 6 * * 1-5 (Not a static string)" },
          fields: [{ label: "Kind", value: "Static schedule" }, { label: "Time zone", value: "Not a static string" }, { label: "File", value: "server/schedules/brief.ts" }],
          id: "definition:brief",
        }],
      },
    }, [], {
      schedules: () => [{
        cells: { schedule: "brief", timing: "15 6 * * 1-5 (Europe/Madrid)" },
        fields: [{ label: "Cron", value: "15 6 * * 1-5" }, { label: "Time zone", value: "Europe/Madrid" }],
        id: "definition:brief",
      }],
    })

    expect(await definitions("schedules")).toEqual({
      kind: "record-table",
      records: [{
        cells: { manual: "No", schedule: "brief", timing: "15 6 * * 1-5 (Europe/Madrid)" },
        fields: [{ label: "Kind", value: "Static schedule" }, { label: "Time zone", value: "Europe/Madrid" }, { label: "File", value: "server/schedules/brief.ts" }, { label: "Cron", value: "15 6 * * 1-5" }],
        id: "definition:brief",
      }],
      section: "schedules",
    })
  })

  it("hides request-time reader errors", async () => {
    installConsoleDefinitions("/project", { schedules: { kind: "record-table", records: [] } }, [], {
      schedules: async () => {
        throw new Error("postgres://user:secret@example.test failed")
      },
    })

    const failure = definitions("schedules")
    await expect(failure).rejects.toThrow(expect.objectContaining({ statusCode: 503, statusMessage: "Runtime records are unavailable." }))
    await expect(failure).rejects.not.toThrow(/secret/)
  })
})
