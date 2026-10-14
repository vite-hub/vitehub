import { describe, expect, it } from "vitest"

import {
  createViteHubConsoleActionError,
  describeViteHubConsoleDocumentActions,
  describeViteHubConsoleRuntimeReader,
  describeViteHubConsoleSection,
  isViteHubConsoleDocumentEditorSection,
  isViteHubConsoleRuntimeSection,
  isViteHubConsoleSectionId,
  readViteHubConsoleActionFailure,
  readViteHubConsoleSection,
  viteHubConsoleDocumentActionNames,
} from "../src/console.ts"

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

const runtimeTable: ViteHubConsoleSectionContribution<{ rootDir: string }> = {
  description: "Inspect widget jobs.",
  icon: "i-ph-clock-light",
  id: "widget-jobs",
  label: "Widget Jobs",
  read: ({ rootDir }) => [{ cells: { job: "static" }, fields: [{ label: "Root", value: rootDir }], id: "definition:static" }],
  runtime: { export: "readWidgetJobRecords", module: "@vite-hub/widget/runtime/console" },
  view: { columns: [{ key: "job", label: "Job" }], kind: "record-table", notice: "Runtime jobs are read on each request." },
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

  it("keeps the runtime reader out of the descriptor and the build-time content", async () => {
    expect(isViteHubConsoleRuntimeSection(runtimeTable)).toBe(true)
    expect(isViteHubConsoleRuntimeSection(table)).toBe(false)
    expect(describeViteHubConsoleSection(runtimeTable)).toEqual({
      description: "Inspect widget jobs.",
      icon: "i-ph-clock-light",
      id: "widget-jobs",
      label: "Widget Jobs",
      view: { columns: [{ key: "job", label: "Job" }], kind: "record-table", notice: "Runtime jobs are read on each request." },
    })
    expect(describeViteHubConsoleRuntimeReader(runtimeTable)).toEqual({ export: "readWidgetJobRecords", module: "@vite-hub/widget/runtime/console" })
    expect(describeViteHubConsoleRuntimeReader(table)).toBeUndefined()
    await expect(readViteHubConsoleSection(runtimeTable, { rootDir: "/app" })).resolves.toEqual({
      kind: "record-table",
      records: [{ cells: { job: "static" }, fields: [{ label: "Root", value: "/app" }], id: "definition:static" }],
    })
    const { read: _read, ...runtimeOnly } = runtimeTable
    await expect(readViteHubConsoleSection(runtimeOnly, { rootDir: "/app" })).resolves.toEqual({ kind: "record-table", records: [] })
  })

  it("rejects runtime readers that the host cannot import safely", () => {
    expect(() => describeViteHubConsoleRuntimeReader({ ...runtimeTable, runtime: { export: "read", module: "./local.ts" } })).toThrow(TypeError)
    expect(() => describeViteHubConsoleRuntimeReader({ ...runtimeTable, runtime: { export: "read-records", module: "@vite-hub/widget" } })).toThrow(TypeError)
  })

  it("describes a document editor without its entry finder or actions", async () => {
    const editor: ViteHubConsoleSectionContribution<{ rootDir: string }> = {
      actions: { export: "createWidgetDocumentActions", module: "@vite-hub/widget/runtime/console" },
      description: "Edit widget documents.",
      entry: ({ rootDir }) => `${rootDir}/server/widgets.ts`,
      icon: "i-lucide-file-pen-line",
      id: "widget-docs",
      label: "Widget Docs",
      view: { kind: "document-editor", notice: "Documents live in the widget store." },
    }
    expect(isViteHubConsoleDocumentEditorSection(editor)).toBe(true)
    expect(isViteHubConsoleDocumentEditorSection(table)).toBe(false)
    expect(describeViteHubConsoleSection(editor)).toEqual({
      description: "Edit widget documents.",
      icon: "i-lucide-file-pen-line",
      id: "widget-docs",
      label: "Widget Docs",
      view: { kind: "document-editor", notice: "Documents live in the widget store." },
    })
    expect(describeViteHubConsoleDocumentActions(editor)).toEqual({ export: "createWidgetDocumentActions", module: "@vite-hub/widget/runtime/console" })
    expect(describeViteHubConsoleDocumentActions(table)).toBeUndefined()
    expect(describeViteHubConsoleRuntimeReader(editor)).toBeUndefined()
    // Collections are read from the owner actions on each request.
    await expect(readViteHubConsoleSection(editor, { rootDir: "/app" })).resolves.toEqual({ collections: [], kind: "document-editor" })
    expect(() => describeViteHubConsoleDocumentActions({ ...editor, actions: { export: "create", module: "../local.ts" } })).toThrow(TypeError)
    expect(viteHubConsoleDocumentActionNames).toEqual(["get", "list", "publish", "raw", "remove", "restore", "revisions", "save"])
  })

  it("marks action failures that the Console may return", () => {
    const error = createViteHubConsoleActionError({ code: "CONTENT_INVALID", details: { issues: [] }, message: "Invalid.", status: 422 })
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("Invalid.")
    expect(readViteHubConsoleActionFailure(error)).toEqual({ code: "CONTENT_INVALID", details: { issues: [] }, message: "Invalid.", status: 422 })
    expect(Object.keys(error)).toEqual([])
    expect(readViteHubConsoleActionFailure(new Error("plain"))).toBeUndefined()
    expect(readViteHubConsoleActionFailure(Object.assign(new Error("forged"), { code: "X", status: 422 }))).toBeUndefined()
    expect(readViteHubConsoleActionFailure(undefined)).toBeUndefined()
  })
})
