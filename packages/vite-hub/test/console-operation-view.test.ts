import { afterEach, describe, expect, it, vi } from "vitest"

import { parseConsoleContributedSection, parseConsoleSectionContent } from "../src/console/runtime/definitions.ts"
import { loadOperationItems, operationCell, operationItems, operationLink, operationStatus, operationTime, operationValue } from "../src/console/runtime/client/operation-view.ts"
import { consoleCommentsTransport, consoleCommentSubjectLabel, isConsoleCommentThread, readConsoleCommentSession } from "../src/console/runtime/client/comment-thread.ts"
import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { ConsoleRequestError, requestConsoleOperation } from "../src/console/runtime/client/request.ts"
import { installConsoleDefinitions } from "../src/console/runtime/server/definitions.ts"
import { describeViteHubConsoleSection, readViteHubConsoleSection } from "@vite-hub/internal/console"
import { operationRpcFetch, operationRpcRequest } from "../../internal/test-utils/operation-rpc.ts"

import type { ViteHubConsoleOperationSection } from "@vite-hub/internal/console"

const section: ViteHubConsoleOperationSection = {
  description: "Fixture.",
  icon: "i-lucide-list",
  id: "fixtures",
  label: "Fixtures",
  view: {
    columns: [{ key: "name|id", label: "Name" }, { format: "datetime", key: "at", label: "At" }, { format: "excerpt", key: "text", label: "Text" }],
    detail: { kind: "comment-thread" },
    filters: [{ id: "all", input: {}, label: "All" }, { id: "mine", input: { mine: true }, label: "Mine" }],
    kind: "operation-view",
    link: { label: "Open", template: "/items/{id}", when: { equals: "page", path: "kind" } },
    notice: "From the fixtures.list operation.",
    operation: "fixtures.list",
    pagination: { limit: 200, cursor: { id: "id", updatedAt: "updatedAt" } },
  },
}

const pageProject = consoleProject()

afterEach(() => {
  setConsoleProject(pageProject)
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

  it("opens a page link on the app origin when the Console forwards its calls", () => {
    if (section.view.kind !== "operation-view") throw new Error("expected an operation view")
    setConsoleProject({ app: { base: "", origin: "https://app.example.com" }, base: "/p/one", origin: "", remote: true })
    expect(operationLink({ id: "7", kind: "page" }, section.view)).toBe("https://app.example.com/items/7")
  })

  it("reads status and time cells", () => {
    const column = { format: "status", key: "status", label: "Status", tones: { resolved: "success" } } as const
    expect(operationStatus({ status: "resolved" }, column)).toEqual({ label: "Resolved", tone: "success" })
    expect(operationStatus({ status: "open" }, column)).toEqual({ label: "Open", tone: "neutral" })
    expect(operationStatus({ status: "toString" }, column)).toEqual({ label: "ToString", tone: "neutral" })
    expect(operationStatus({}, column)).toBeUndefined()
    expect(operationTime({ at: Date.UTC(2026, 0, 2, 3, 4) }, { format: "datetime", key: "at", label: "" })).toBe("2026-01-02T03:04:00.000Z")
    expect(operationTime({ at: "soon" }, { format: "datetime", key: "at", label: "" })).toBeUndefined()
  })

  it("keeps the status tones of a section and drops unknown ones", () => {
    const parsed = parseConsoleContributedSection({
      ...section,
      view: { columns: [{ format: "status", key: "status", label: "Status", tones: { done: "success", odd: "purple" } }], kind: "operation-view", notice: "N.", operation: "x.list" },
    })
    const view = parsed?.view.kind === "operation-view" ? parsed.view : undefined
    expect(view?.columns).toEqual([{ format: "status", key: "status", label: "Status", tones: { done: "success" } }])
  })

  it("takes the objects of an operation result", () => {
    expect(operationItems([{ id: 1 }, null, "x", [1]])).toEqual([{ id: 1 }])
    expect(operationItems({ id: 1 })).toEqual([])
  })

  it("loads older threads with the last item's cursor and preserves the filter", async () => {
    if (section.view.kind !== "operation-view") throw new Error("expected an operation view")
    const first = Array.from({ length: 200 }, (_, index) => ({ id: `thread-${index}`, updatedAt: 1000 - index }))
    const older = { id: "older", updatedAt: 0 }
    const requests: unknown[] = []
    vi.stubGlobal("fetch", operationRpcFetch(async (_url: string, init: RequestInit) => {
      requests.push(operationRpcRequest(init.body).input)
      return Response.json({ ok: true, value: requests.length === 1 ? first : [older] })
    }))
    expect(await loadOperationItems(section.view, { mine: true }, new AbortController().signal)).toEqual([...first, older])
    expect(requests).toEqual([{ mine: true, limit: 200 }, { mine: true, limit: 200, before: { id: "thread-199", updatedAt: 801 } }])
  })

  it("stops pagination when the filter's request is aborted", async () => {
    if (section.view.kind !== "operation-view") throw new Error("expected an operation view")
    const controller = new AbortController()
    const fetch = vi.fn(async () => {
      controller.abort()
      return Response.json({ ok: true, value: Array.from({ length: 200 }, (_, id) => ({ id, updatedAt: 1 })) })
    })
    vi.stubGlobal("fetch", operationRpcFetch(fetch))
    await expect(loadOperationItems(section.view, {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("has no build-time data, and survives the section catalog and the client parser", async () => {
    expect(await readViteHubConsoleSection(section, undefined)).toEqual({ kind: "operation-view" })
    const described = describeViteHubConsoleSection(section)
    expect(described.view).toEqual(section.view)
    expect(parseConsoleContributedSection(described)?.view).toEqual(section.view)
    expect(() => describeViteHubConsoleSection({ ...section, view: { ...section.view, operation: "nope" } as never })).toThrowError(/operation name/)
    expect(parseConsoleSectionContent({ kind: "operation-view", section: "fixtures" }, "fixtures")).toEqual({ kind: "operation-view" })
    const catalog = installConsoleDefinitions("/operation-view-test", { fixtures: { kind: "operation-view" } }, [described as never])
    expect(catalog.sections[0]!.view).toEqual(section.view)
    expect(catalog.content.fixtures).toEqual({ kind: "operation-view" })
  })

  it("drops a detail panel that the Console does not know", () => {
    const described = describeViteHubConsoleSection({ ...section, view: { ...section.view, detail: { kind: "chart" } } as never })
    expect(parseConsoleContributedSection(described)?.view).not.toHaveProperty("detail")
  })

  it("runs each comments transport call as its comments operation with the Console user", async () => {
    setConsoleProject({ origin: "", base: "/portal" })
    const calls: Array<{ input: unknown, operation: string }> = []
    vi.stubGlobal("fetch", operationRpcFetch(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/portal/_vitehub/rpc")
      const body = operationRpcRequest(init?.body)
      calls.push(body)
      if (body.operation === "comments.session") return Response.json({ ok: true, value: { canRead: true, canWrite: false, capabilities: { reply: false, resolve: true, deleteThread: false, edit: ["m1"], delete: ["m2"] }, user: { id: "u1", name: "Ann" } } })
      if (body.operation === "comments.reply") return Response.json({ code: "COMMENTS_R0009", message: "You may not write here.", ok: false, status: 403 }, { status: 403 })
      return Response.json({ ok: true, value: { id: "t1" } })
    }))
    const transport = consoleCommentsTransport()
    await transport.resolve({ threadId: "t1" })
    await transport.users({ query: "an" })
    await expect(transport.reply({ body: "Hi @Ann", mentions: ["u1"], threadId: "t1" })).rejects.toMatchObject({ code: "COMMENTS_R0009", message: "You may not write here.", status: 403 })
    expect(calls).toEqual([
      { input: { threadId: "t1" }, operation: "comments.resolve" },
      { input: { query: "an" }, operation: "comments.users" },
      { input: { body: "Hi @Ann", mentions: ["u1"], threadId: "t1" }, operation: "comments.reply" },
    ])
    expect(await readConsoleCommentSession({ id: "/pricing", kind: "page" }, undefined, "t1")).toEqual({ canWrite: false, capabilities: { reply: false, resolve: true, deleteThread: false, edit: ["m1"], delete: ["m2"] }, user: { id: "u1", name: "Ann" } })
    expect(calls.at(-1)).toEqual({ input: { subject: { id: "/pricing", kind: "page" }, threadId: "t1" }, operation: "comments.session" })
  })

  it("reads a signed-out comments session as read-only", async () => {
    vi.stubGlobal("fetch", operationRpcFetch(async () => Response.json({ ok: true, value: { canRead: false, canWrite: false, user: null } })))
    expect(await readConsoleCommentSession({ id: "/", kind: "page" })).toEqual({ canWrite: false, capabilities: { reply: false, resolve: false, deleteThread: false, edit: [], delete: [] }, user: undefined })
  })

  it("opens only list items that have the fields of a thread", () => {
    const thread = { author: { id: "u1" }, id: "t1", messages: [], n: 3, subject: { id: "/pricing", kind: "page" } }
    expect(isConsoleCommentThread(thread)).toBe(true)
    expect(isConsoleCommentThread({ ...thread, n: "3" })).toBe(false)
    expect(isConsoleCommentThread({ id: "t1" })).toBe(false)
    expect(consoleCommentSubjectLabel(thread.subject)).toBe("/pricing")
    expect(consoleCommentSubjectLabel({ id: "posts/hello", kind: "content" })).toBe("content posts/hello")
  })

  it("calls the operation over the RPC and keeps the failure fields", async () => {
    setConsoleProject({ origin: "", base: "/portal" })
    const calls: Array<{ body: string, url: string }> = []
    vi.stubGlobal("fetch", operationRpcFetch(async (url: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body), url })
      return Reflect.get(Object(operationRpcRequest(init?.body).input), "fail")
        ? Response.json({ code: "COMMENTS_R0006", fix: "Add authorize.", message: "No policy.", ok: false, status: 403 }, { status: 403 })
        : Response.json({ ok: true, value: [{ id: "a" }] })
    }))
    expect(await requestConsoleOperation("fixtures.list", { mine: true })).toEqual([{ id: "a" }])
    expect({ ...calls[0], body: operationRpcRequest(calls[0]!.body) }).toEqual({ body: { input: { mine: true }, operation: "fixtures.list" }, url: "/portal/_vitehub/rpc" })
    const failure = await requestConsoleOperation("fixtures.list", { fail: true }).catch(error => error)
    expect(failure).toBeInstanceOf(ConsoleRequestError)
    expect(failure).toMatchObject({ code: "COMMENTS_R0006", fix: "Add authorize.", status: 403 })
  })
})

describe("the Forms section", () => {
  it("links a page with its query and escapes as stored, and shows a feedback message", async () => {
    const { formsConsoleSection } = await import("@vite-hub/forms/vite")
    const view = formsConsoleSection.view
    expect(operationLink({ page: "/pricing?plan=pro" }, view)).toBe("/pricing?plan=pro")
    expect(operationLink({ page: "/docs/caf%C3%A9" }, view)).toBe("/docs/caf%C3%A9")
    expect(operationLink({ page: "//evil.test/x" }, view)).toBeUndefined()
    expect(operationCell({ data: { feedback: "Dark mode, please." } }, view.columns[2]!)).toBe("Dark mode, please.")
  })
})
