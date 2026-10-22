import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { createViteHubConsoleActionError } from "@vite-hub/internal/console"
import { afterEach, describe, expect, it, vi } from "vitest"

import { discoverConsoleBuildCatalog, withConsoleDocumentEditorSections } from "../src/console/build.ts"
import { consoleDocumentEditorSectionIds, describeConsoleDocumentEditors } from "../src/console/contributions.ts"
import { consoleDocumentsKey, consoleDocumentsRegistryKey, consoleDocumentsRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey } from "../src/console/internal.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import { insertConsoleSection } from "../src/console/runtime/sections.ts"
import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDocuments } from "../src/console/runtime/server/documents.ts"
import { handleConsoleRpcRequest } from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { installConsoleDefinitions } from "../src/console/runtime/server/definitions.ts"

import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"
import type { ConsoleDocumentActions } from "../src/console/runtime/server/documents.ts"

// SAFETY: Console state uses the same optional symbol keys in runtime and tests.
const scope = globalThis as ConsoleInvocationScope
const policyKey = Symbol.for("vitehub.console.access")
const roots: string[] = []

afterEach(async () => {
  for (const key of [consoleDocumentsKey, consoleDocumentsRegistryKey, consoleDocumentsRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey, policyKey]) {
    Reflect.deleteProperty(scope, key)
  }
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-documents-"))
  roots.push(root)
  return root
}

function fakeActions(overrides: Partial<ConsoleDocumentActions> = {}): ConsoleDocumentActions {
  const unused = () => {
    throw new Error("unused")
  }
  return {
    collections: () => [{ access: { publish: true, read: true, write: true }, label: "Posts", name: "posts", path: "posts/**/*.md", schema: { type: "object" } }],
    get: unused,
    list: unused,
    mediaAccess: () => ({ manage: true, read: true, write: true }),
    overview: unused,
    publish: unused,
    raw: unused,
    references: unused,
    remove: unused,
    restore: unused,
    revisions: unused,
    save: unused,
    schedule: unused,
    search: unused,
    session: unused,
    sessions: unused,
    unschedule: unused,
    ...overrides,
  }
}

function install(actions: ConsoleDocumentActions, sections: readonly string[] = ["content", "kv"]): void {
  installConsoleSections("/app", sections)
  installConsoleDocuments("/app", { content: { actions: () => actions, load: async () => ({}) } })
  installConsoleDefinitions("/app", { content: { collections: [], kind: "document-editor" } }, [])
}

async function call(method: string, input: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ body: Record<string, unknown>, status: number }> {
  const request = new Request("http://localhost/_vitehub/rpc/__call", {
    // The client puts the method first, so a large document body can be classified within the ordinary limit.
    body: JSON.stringify({ method, input }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...headers },
    method: "POST",
  })
  const response = await withConsoleAccess((_event, access) => handleConsoleRpcRequest(request, { access }), { anySection: true })({ req: request })
  const body: Record<string, unknown> = Object(await response.json())
  return { body, status: response.status }
}

const documents = (action: string, body: unknown, headers?: Record<string, string>) =>
  call(consoleRpcMethods.documents, { body, method: "POST", query: { action, section: "content" } }, headers)

describe("Console document editor route", () => {
  it("runs an owner action with the signed-in user, read only when the action needs it", async () => {
    const save = vi.fn((input: unknown, context: { user: Record<string, unknown> | null }) => ({ input, user: context.user }))
    const readUser = vi.fn(async () => ({ email: "ada@example.com", id: "ada" }))
    installConsoleAccess({ check: async () => undefined, mode: "auth", user: readUser })
    install(fakeActions({ save }))

    const sections = await call(consoleRpcMethods.sections, {})
    expect(sections.status).toBe(200)
    expect(sections.body.value).not.toHaveProperty("scoped")
    // Navigation does not read the user.
    expect(readUser).not.toHaveBeenCalled()

    const result = await documents("save", { collection: "posts", id: "hello" })
    expect(result).toEqual({ body: { ok: true, value: { input: { collection: "posts", id: "hello" }, user: { email: "ada@example.com", id: "ada" } } }, status: 200 })
    expect(readUser).toHaveBeenCalledOnce()
  })

  it("passes a null user when the access mode has none", async () => {
    installConsoleAccess({ mode: "open" })
    const get = vi.fn((_input: unknown, context: { user: unknown }) => ({ user: context.user }))
    install(fakeActions({ get }))
    await expect(documents("get", { collection: "posts", id: "a" })).resolves.toEqual({ body: { ok: true, value: { user: null } }, status: 200 })
  })

  it("returns 403 when the access scope leaves out the document section", async () => {
    installConsoleAccess({ authorize: () => ({ sections: ["kv"] }), mode: "open" })
    const save = vi.fn()
    install(fakeActions({ save }))
    await expect(documents("save", {})).resolves.toMatchObject({ body: { ok: false, status: 403 }, status: 403 })
    await expect(call(consoleRpcMethods.definitions, { query: { section: "content" } })).resolves.toMatchObject({ status: 403 })
    expect(save).not.toHaveBeenCalled()
  })

  it("serves only Content to an access scoped to Content", async () => {
    installConsoleAccess({ authorize: () => ({ sections: ["content"] }), mode: "open" })
    install(fakeActions({ list: () => ({ changes: [], items: [], nextCursor: null, states: { changed: 0, deleted: 0, draft: 0, published: 0 }, total: 0 }) }))
    await expect(documents("list", { collection: "posts" })).resolves.toMatchObject({ status: 200 })
    // `scoped` tells the Overview that other sections may exist but are hidden from this user.
    await expect(call(consoleRpcMethods.sections, {})).resolves.toMatchObject({ body: { value: { scoped: true, sections: ["content"] } } })
    for (const method of [consoleRpcMethods.kv, consoleRpcMethods.agents, consoleRpcMethods.env]) {
      await expect(call(method, {}), method).resolves.toMatchObject({ status: 403 })
    }
    await expect(call(consoleRpcMethods.definitions, { query: { section: "kv" } })).resolves.toMatchObject({ status: 403 })
  })

  it("serves the dashboard and search actions of every section page with the section access", async () => {
    // Pages have no access scope of their own: `{ sections: ['content'] }` reaches the dashboard, search, and Media.
    installConsoleAccess({ authorize: () => ({ sections: ["content"] }), mode: "open" })
    const overview = vi.fn(() => ({ activity: [], collections: [] }))
    const search = vi.fn((input: unknown) => ({ items: [], input }))
    install(fakeActions({ overview, search }))
    await expect(documents("overview", {})).resolves.toEqual({ body: { ok: true, value: { activity: [], collections: [] } }, status: 200 })
    await expect(documents("search", { query: "launch" })).resolves.toMatchObject({ body: { ok: true, value: { input: { query: "launch" } } }, status: 200 })

    installConsoleAccess({ authorize: () => ({ sections: ["kv"] }), mode: "open" })
    await expect(documents("overview", {})).resolves.toMatchObject({ status: 403 })
    await expect(documents("search", { query: "launch" })).resolves.toMatchObject({ status: 403 })
    expect(overview).toHaveBeenCalledOnce()
    expect(search).toHaveBeenCalledOnce()
  })

  it("reads the collections that the owner allows through the definitions route", async () => {
    installConsoleAccess({ mode: "open" })
    install(fakeActions())
    await expect(call(consoleRpcMethods.definitions, { query: { section: "content" } })).resolves.toMatchObject({
      body: { ok: true, value: { collections: [{ name: "posts" }], kind: "document-editor", section: "content" } },
      status: 200,
    })
  })

  it("merges the build-time and runtime setup hints of the owner", async () => {
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/app", ["content"])
    installConsoleDocuments("/app", { content: { actions: () => fakeActions({ collections: () => [], setup: () => ({ access: { message: "Add `authorize`.", docs: "https://vitehub.dev/docs/content/configure#access" } }) }), load: async () => ({}) } })
    installConsoleDefinitions("/app", { content: { collections: [], kind: "document-editor", setup: { schedule: { message: "Add a runner." } } } }, [])
    await expect(call(consoleRpcMethods.definitions, { query: { section: "content" } })).resolves.toMatchObject({
      body: { ok: true, value: { collections: [], kind: "document-editor", section: "content", setup: { access: { message: "Add `authorize`.", docs: "https://vitehub.dev/docs/content/configure#access" }, schedule: { message: "Add a runner." } } } },
      status: 200,
    })
  })

  it("returns owner failures with their code and details", async () => {
    installConsoleAccess({ mode: "open" })
    install(fakeActions({
      save: () => {
        throw createViteHubConsoleActionError({ code: "CONTENT_INVALID", details: { issues: [{ field: "title", message: "Required", path: [] }] }, message: "Some fields are invalid.", status: 422 })
      },
      remove: () => {
        throw createViteHubConsoleActionError({ code: "WORKSPACE_CONFLICT", details: { actual: "b", expected: "a" }, message: "Changed.", status: 409 })
      },
      publish: () => {
        throw createViteHubConsoleActionError({ code: "CONTENT_FORBIDDEN", message: "You cannot publish this collection.", status: 403 })
      },
    }))
    await expect(documents("save", {})).resolves.toEqual({
      body: { code: "CONTENT_INVALID", details: { issues: [{ field: "title", message: "Required", path: [] }] }, message: "Some fields are invalid.", ok: false, status: 422 },
      status: 422,
    })
    await expect(documents("remove", {})).resolves.toMatchObject({ body: { code: "WORKSPACE_CONFLICT", details: { actual: "b", expected: "a" } }, status: 409 })
    await expect(documents("publish", {})).resolves.toMatchObject({ body: { code: "CONTENT_FORBIDDEN", message: "You cannot publish this collection." }, status: 403 })
  })

  it("hides other action errors behind a fixed 500", async () => {
    installConsoleAccess({ mode: "open" })
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    install(fakeActions({
      get: () => {
        throw Object.assign(new Error("secret database path /var/app.db"), { code: "SECRET", details: { leak: true } })
      },
    }))
    const result = await documents("get", {})
    expect(result).toEqual({ body: { message: "The document action failed. Check the server log.", ok: false, status: 500 }, status: 500 })
    expect(log).toHaveBeenCalled()
  })

  it("rejects unknown actions and sections that are not installed", async () => {
    installConsoleAccess({ mode: "open" })
    install(fakeActions())
    await expect(documents("collections", {})).resolves.toMatchObject({ status: 400 })
    // The Console calls `mediaAccess` itself before media changes; the browser cannot.
    await expect(documents("mediaAccess", {})).resolves.toMatchObject({ status: 400 })
    await expect(call(consoleRpcMethods.documents, { body: {}, method: "POST", query: { action: "get", section: "kv" } })).resolves.toMatchObject({ status: 404 })
  })

  it("reports a module that fails to load as unavailable and retries it", async () => {
    installConsoleAccess({ mode: "open" })
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    installConsoleSections("/app", ["content"])
    let attempts = 0
    installConsoleDocuments("/app", {
      content: {
        actions: () => fakeActions({ get: () => ({ ok: attempts }) }),
        load: async () => {
          attempts++
          if (attempts === 1) throw new Error("syntax error in server/content.ts")
          return {}
        },
      },
    })
    await expect(documents("get", {})).resolves.toMatchObject({ body: { message: "The document editor is unavailable. Check the server log." }, status: 503 })
    await expect(documents("get", {})).resolves.toEqual({ body: { ok: true, value: { ok: 2 } }, status: 200 })
  })

  it("accepts a document body larger than the ordinary request limit", async () => {
    installConsoleAccess({ mode: "open" })
    const save = vi.fn((input: { body: string }) => ({ length: input.body.length }))
    install(fakeActions({ save: save as never }))
    const body = "x".repeat(200 * 1024)
    await expect(documents("save", { body })).resolves.toEqual({ body: { ok: true, value: { length: body.length } }, status: 200 })
    await expect(call(consoleRpcMethods.kv, { query: { padding: "x".repeat(200 * 1024) } })).resolves.toMatchObject({ status: 413 })
  })
})

describe("Console document editor discovery", () => {
  it("adds the Content section only when server/content.ts defines document collections", async () => {
    const root = await temporaryRoot()
    const empty = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["kv"] })
    expect(empty.documents).toEqual({})
    expect(withConsoleDocumentEditorSections(["kv"], empty)).toEqual(["kv"])

    await mkdir(join(root, "server"), { recursive: true })
    // Read-only Sources have nothing to edit.
    await writeFile(join(root, "server/content.ts"), `import { defineContent } from "vite-hub/content"\nexport const content = defineContent({ source: "content" })\n`)
    const sourcesOnly = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["kv"] })
    expect(sourcesOnly.documents).toEqual({})

    await writeFile(join(root, "server/content.ts"), `import { defineContent, documents } from "vite-hub/content"\nexport const content = defineContent({ workspace: "site", collections: { posts: documents({ path: "posts/*.md", fields: {} }) } })\n`)
    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["env", "kv"] })
    expect(catalog.documents).toEqual({ content: join(root, "server/content.ts") })
    // Without Schedule, nothing runs scheduled publishes, so Content names the fix.
    expect(catalog.content.content).toEqual({ collections: [], kind: "document-editor", setup: { schedule: expect.objectContaining({ message: expect.stringContaining("Enable Schedule") }) } })
    expect(withConsoleDocumentEditorSections(["env", "kv"], catalog)).toEqual(["content", "env", "kv"])
    expect(consoleDocumentEditorSectionIds).toEqual(["content"])
  })

  it("reads whether a Schedule Definition runs scheduled Content publishes", async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, "server/content.ts"), `import { defineContent, documents } from "vite-hub/content"\nexport const content = defineContent({ workspace: "site", collections: { posts: documents({ path: "posts/*.md", fields: {} }) } })\n`)
    await writeFile(join(root, "server/schedules/cleanup.ts"), `import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "0 * * * *", handler: () => {} })\n`)
    const without = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["schedules"] })
    expect(without.content.content).toMatchObject({ setup: { schedule: { message: "Nothing publishes scheduled documents. Add a Schedule Definition that calls `content.publishDue()`." } } })

    await writeFile(join(root, "server/schedules/content-publish.ts"), `import { defineSchedule } from "vite-hub/schedule"\nimport { content } from "../content"\nexport default defineSchedule({ cron: "* * * * *", handler: () => content.publishDue() })\n`)
    const withRunner = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["schedules"] })
    expect(withRunner.content.content).toEqual({ collections: [], kind: "document-editor" })
  })

  it("leads its navigation group", () => {
    expect(insertConsoleSection(["agents", "blob", "kv"], "content")).toEqual(["agents", "content", "blob", "kv"])
    expect(insertConsoleSection(["agents"], "content")).toEqual(["agents", "content"])
    expect(insertConsoleSection(["content", "kv"], "content")).toEqual(["content", "kv"])
  })

  it("imports the owner actions and loads the application module on first use", async () => {
    const root = await temporaryRoot()
    const plugin = join(root, "console.mjs")
    const entry = join(root, "server/content.ts")
    await writeConsoleNitroPlugin(plugin, root, ["kv"], [], { agents: [], content: { content: { collections: [], kind: "document-editor" } }, documents: { content: entry } }, [], ["default"])
    const source = await readFile(plugin, "utf8")

    expect(describeConsoleDocumentEditors(["content"], { content: entry })).toEqual([
      { entry, export: "createContentConsoleActions", module: "vite-hub/_internal/content/runtime/console", section: "content" },
    ])
    expect(source).toContain(`import { installConsoleDocuments } from "vite-hub/console/documents"`)
    expect(source).toContain(`import { createContentConsoleActions as vitehubConsoleDocumentActions0 } from "vite-hub/_internal/content/runtime/console"`)
    expect(source).toContain(`installConsoleDocuments(${JSON.stringify(root)}, { "content": { actions: vitehubConsoleDocumentActions0, load: () => import(${JSON.stringify(pathToFileURL(entry).href)}) } })`)
    expect(source).toContain(`installConsoleSections(${JSON.stringify(root)}, ["content","kv"])`)
    expect(source).toContain(`"id":"content"`)

    await writeConsoleNitroPlugin(plugin, root, ["kv"], [], { agents: [], content: {} }, [], ["default"])
    const without = await readFile(plugin, "utf8")
    expect(without).not.toContain("installConsoleDocuments")
    expect(without).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"])`)
  })
})

describe("Console access user", () => {
  it("reads the user from the original request once per access", async () => {
    const readUser = vi.fn(async () => ({ id: "ada" }))
    const policy: ConsoleAccessPolicy = { check: async () => undefined, mode: "auth", user: readUser }
    installConsoleAccess(policy)
    const { readConsoleAccessUser } = await import("../src/console/runtime/server/access.ts")
    const route = withConsoleAccess(async (_event, access) => [await readConsoleAccessUser(access), await readConsoleAccessUser(access)], { anySection: true })
    await expect(route({ req: new Request("http://localhost/_vitehub") })).resolves.toEqual([{ id: "ada" }, { id: "ada" }])
    expect(readUser).toHaveBeenCalledOnce()
    await expect(readConsoleAccessUser(Object.freeze({ mode: "auth", sections: "all", user: { id: "forged" } }) as never)).resolves.toBeUndefined()
  })
})
