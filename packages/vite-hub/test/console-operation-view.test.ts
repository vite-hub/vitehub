import { afterEach, describe, expect, it, vi } from "vitest"

import { parseConsoleSectionContent } from "../src/console/runtime/definitions.ts"
import { operationCell, operationItems, operationLink, operationValue } from "../src/console/runtime/client/operation-view.ts"
import { ConsoleRequestError, requestConsoleOperation } from "../src/console/runtime/client/request.ts"
import { installConsoleDefinitions } from "../src/console/runtime/server/definitions.ts"
import { describeViteHubConsoleSection, readViteHubConsoleSection } from "@vite-hub/internal/console"

import type { ViteHubConsoleOperationSection } from "@vite-hub/internal/console"

const section: ViteHubConsoleOperationSection = {
  description: "Fixture.",
  icon: "i-lucide-list",
  id: "fixtures",
  label: "Fixtures",
  view: {
    columns: [{ key: "name|id", label: "Name" }, { format: "datetime", key: "at", label: "At" }, { format: "excerpt", key: "text", label: "Text" }],
    filters: [{ id: "all", input: {}, label: "All" }, { id: "mine", input: { mine: true }, label: "Mine" }],
    kind: "operation-view",
    link: { label: "Open", template: "/items/{id}", when: { equals: "page", path: "kind" } },
    notice: "From the fixtures.list operation.",
    operation: "fixtures.list",
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("operation view", () => {
  it("reads values by dot path, with fallbacks, and formats cells", () => {
    const item = { at: Date.UTC(2026, 0, 2, 3, 4), id: "7", kind: "page", messages: [{ body: "First" }], text: "word ".repeat(40) }
    expect(operationValue(item, "messages.0.body")).toBe("First")
    expect(operationValue(item, "name|id")).toBe("7")
    expect(operationValue(item, "missing.deep")).toBeUndefined()
    expect(operationCell(item, { format: "datetime", key: "at", label: "" })).toBe("2026-01-02 03:04")
    expect(operationCell(item, { format: "excerpt", key: "text", label: "" }).length).toBeLessThanOrEqual(90)
    expect(operationCell(item, { key: "nothing", label: "" })).toBe("")
  })

  it("links only the rows that match, and only when every placeholder has a value", () => {
    if (section.view.kind !== "operation-view") throw new Error("expected an operation view")
    expect(operationLink({ id: "7", kind: "page" }, section.view)).toBe("/items/7")
    expect(operationLink({ id: "7", kind: "content" }, section.view)).toBeUndefined()
    expect(operationLink({ kind: "page" }, section.view)).toBeUndefined()
  })

  it("takes the objects of an operation result", () => {
    expect(operationItems([{ id: 1 }, null, "x", [1]])).toEqual([{ id: 1 }])
    expect(operationItems({ id: 1 })).toEqual([])
  })

  it("has no build-time data, and survives the section catalog and the client parser", async () => {
    expect(await readViteHubConsoleSection(section, undefined)).toEqual({ kind: "operation-view" })
    const described = describeViteHubConsoleSection(section)
    expect(described.view).toEqual(section.view)
    expect(() => describeViteHubConsoleSection({ ...section, view: { ...section.view, operation: "nope" } as never })).toThrowError(/operation name/)
    expect(parseConsoleSectionContent({ kind: "operation-view", section: "fixtures" }, "fixtures")).toEqual({ kind: "operation-view" })
    const catalog = installConsoleDefinitions("/operation-view-test", { fixtures: { kind: "operation-view" } }, [described as never])
    expect(catalog.sections[0]!.view).toEqual(section.view)
    expect(catalog.content.fixtures).toEqual({ kind: "operation-view" })
  })

  it("calls the operation over the RPC and keeps the failure fields", async () => {
    const calls: Array<{ body: string, url: string }> = []
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body), url })
      return JSON.parse(String(init?.body)).input.fail
        ? Response.json({ code: "COMMENTS_R0006", fix: "Add authorize.", message: "No policy.", ok: false, status: 403 }, { status: 403 })
        : Response.json({ ok: true, value: [{ id: "a" }] })
    })
    expect(await requestConsoleOperation("/portal/api/_vitehub/console/definitions", "fixtures.list", { mine: true })).toEqual([{ id: "a" }])
    expect(calls[0]).toEqual({ body: '{"operation":"fixtures.list","input":{"mine":true}}', url: "/portal/_vitehub/rpc/__call" })
    const failure = await requestConsoleOperation("/api/_vitehub/console/definitions", "fixtures.list", { fail: true }).catch(error => error)
    expect(failure).toBeInstanceOf(ConsoleRequestError)
    expect(failure).toMatchObject({ code: "COMMENTS_R0006", fix: "Add authorize.", status: 403 })
  })
})
