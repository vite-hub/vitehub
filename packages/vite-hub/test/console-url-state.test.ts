import { createRenderer, h, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Component } from "vue"
import type { RouteRecordRaw, Router } from "vue-router"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  blobGet: vi.fn(),
  operation: vi.fn(),
  peek: vi.fn(),
  request: vi.fn(),
}))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsole: mocks.request,
}))
vi.mock("../src/console/runtime/client/auth-management", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/auth-management")>(),
  readAuthConsole: mocks.auth,
}))
vi.mock("../src/console/runtime/client/operation-view", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/operation-view")>(),
  loadOperationItems: mocks.operation,
}))
vi.mock("../src/console/runtime/client/rate-limit", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/rate-limit")>(),
  peekConsoleRateLimit: mocks.peek,
}))
vi.mock("../src/console/runtime/client/blob-media", () => ({
  createConsoleBlobMediaClient: () => ({ get: mocks.blobGet, object: () => ({}) }),
}))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: async () => false }))
vi.mock("../src/console/runtime/client/sections", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/sections")>(),
  loadConsoleNavigation: async () => undefined,
}))
for (const name of ["console-frame", "console-search", "console-media-browser", "console-blob-detail", "console-media-detail", "console-env-details", "console-auth-activity"]) {
  vi.doMock(`../src/console/runtime/components/${name}.vue`, () => ({ default: {} }))
}

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

const unmounts: Array<() => void> = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

/** Runs the setup of a page under a router at `path`, without rendering, and spies on its navigations. */
async function mountPage<State>(component: Component, props: Record<string, unknown>, path: string, routes: RouteRecordRaw[]) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  const push = vi.spyOn(router, "push")
  const replace = vi.spyOn(router, "replace")
  const app = renderer.createApp({ ...component, render: () => null }, props)
  app.use(router)
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  unmounts.push(() => app.unmount())
  await nextTick()
  // SAFETY: tests read and write the setup state of the page they mount.
  const state = (instance.$ as unknown as { setupState: State }).setupState
  return { push, replace, router, state }
}

async function settle(router: Router, query: Record<string, string>) {
  await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual(query))
}

const bases = { agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections" }

describe("Logs", async () => {
  const Logs = (await import("../src/console/runtime/components/console-logs.vue")).default
  const routes = [{ component: {}, name: "vitehub-console-logs", path: "/logs" }]

  it("restores the view, search, level, and open event, and writes them back", async () => {
    mocks.request.mockResolvedValue({ source: null })
    const { push, replace, router, state } = await mountPage<{ entry: string | undefined, level: string, mode: string, selectedId: string | undefined, text: string }>(
      Logs, { logsBase: "/logs-api", sectionsBase: "/sections" }, "/logs?q=boom&level=warn&view=stream&entry=e2", routes,
    )
    expect([state.text, state.level, state.mode, state.selectedId]).toEqual(["boom", "warn", "stream", "e2"])
    await vi.waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith("/logs-api", expect.objectContaining({ query: { level: "warn", limit: "200", text: "boom" } })))
    state.level = "error"
    await settle(router, { entry: "e2", level: "error", q: "boom", view: "stream" })
    expect(replace).toHaveBeenCalledOnce()
    state.selectedId = "e3"
    await settle(router, { entry: "e3", level: "error", q: "boom", view: "stream" })
    expect(push).toHaveBeenCalledOnce()
    router.back()
    await vi.waitFor(() => expect(state.selectedId).toBe("e2"))
  })
})

describe("Databases", async () => {
  const Database = (await import("../src/console/runtime/components/console-database.vue")).default
  const routes = [{ component: {}, name: "vitehub-console-databases", path: "/databases/:database/:table" }]

  it("keeps URL state active when the mounted Schema view opens Data", async () => {
    mocks.request.mockResolvedValue({ database: "main", databases: ["main"], direction: "asc", limit: 50, offset: 0, relationships: [], rows: [], search: "", table: "users", tables: [], total: 200 })
    const { replace, router, state } = await mountPage<{ direction: string, filter: string, offset: number, sort: string }>(
      Database, { ...bases, databaseBase: "/database", view: "schema" }, "/databases/main/schema/diagram", [
        ...routes, { component: {}, name: "vitehub-console-databases-schema", path: "/databases/:database/schema/diagram" },
      ],
    )
    await router.push("/databases/main/users")
    state.filter = "alice"
    await settle(router, { q: "alice" })
    state.sort = "id"
    await settle(router, { q: "alice", sort: "id" })
    state.direction = "desc"
    await settle(router, { dir: "desc", q: "alice", sort: "id" })
    expect(replace).toHaveBeenCalledTimes(3)
    state.offset = 50
    await settle(router, { dir: "desc", offset: "50", q: "alice", sort: "id" })
    router.back()
    await vi.waitFor(() => expect(state.offset).toBe(0))
    router.back()
    await vi.waitFor(() => expect([state.filter, state.sort, state.direction]).toEqual(["", "", "asc"]))
    router.forward()
    await vi.waitFor(() => expect([state.filter, state.sort, state.direction]).toEqual(["alice", "id", "desc"]))
  })

  it("loads the filter, sort, and page of the URL and walks pages with Back", async () => {
    mocks.request.mockImplementation(async (_url: string, { query }: { query: Record<string, unknown> }) => ({
      database: "main", databases: ["main"], direction: query.direction, limit: 50, offset: query.offset, relationships: [],
      rows: [], search: query.search ?? "", table: query.table, total: 200,
      tables: [{ columns: [{ key: "id", name: "id", type: "integer" }], name: "users" }],
    }))
    const { push, replace, router, state } = await mountPage<{ direction: string, filter: string, movePage: (delta: 1) => void, offset: number, sort: string, toggleDirection: () => void }>(
      Database, { ...bases, databaseBase: "/database", view: "data" }, "/databases/main/users?q=alice&sort=id&dir=desc&offset=50", routes,
    )
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/database", expect.objectContaining({
      query: expect.objectContaining({ direction: "desc", offset: 50, search: "alice", sort: "id", table: "users" }),
    })))
    expect(state.filter).toBe("alice")
    state.movePage(1)
    await settle(router, { dir: "desc", offset: "100", q: "alice", sort: "id" })
    expect(push).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith("/database", expect.objectContaining({ query: expect.objectContaining({ offset: 100 }) })))
    router.back()
    await vi.waitFor(() => expect(state.offset).toBe(50))
    await vi.waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith("/database", expect.objectContaining({ query: expect.objectContaining({ offset: 50 }) })))
    state.offset = 0
    await settle(router, { dir: "desc", q: "alice", sort: "id" })
    state.toggleDirection()
    await settle(router, { q: "alice", sort: "id" })
    expect(replace).toHaveBeenCalledOnce()
  })
})

describe("Auth", async () => {
  const Auth = (await import("../src/console/runtime/components/console-auth.vue")).default
  const routes = [{ component: {}, name: "vitehub-console-auth", path: "/auth/:page(overview|users|sessions|organizations|agents|activity)?" }]
  const description = { access: [], actions: {}, events: { enabled: true }, fields: [], pages: ["overview", "users", "organizations"], storage: { enabled: true } }

  it("restores an organization across Auth pages without changing Back or Forward history", async () => {
    mocks.auth.mockImplementation(async (kind: string) => kind === "describe" ? description : kind === "organization" ? { id: "o1", invitations: [], invitationsTotal: 0, members: [], membersTotal: 0, name: "Acme" } : { items: [], total: 0 })
    const { push, replace, router, state } = await mountPage<{ navigate(page: "users"): void, selectedOrg?: { id: string }, selectedOrgId: string | undefined }>(
      Auth, { sectionsBase: "/sections" }, "/auth/organizations?org=o1", routes,
    )
    await vi.waitFor(() => expect(state.selectedOrg?.id).toBe("o1"))
    state.navigate("users")
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe("/auth/users")
      expect(state.selectedOrg).toBeUndefined()
      expect(state.selectedOrgId).toBeUndefined()
    })
    expect(push).toHaveBeenCalledOnce()
    push.mockClear()
    router.back()
    await vi.waitFor(() => expect(state.selectedOrg?.id).toBe("o1"))
    expect(state.selectedOrgId).toBe("o1")
    expect(router.currentRoute.value.fullPath).toBe("/auth/organizations?org=o1")
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    router.forward()
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe("/auth/users")
      expect(state.selectedOrg).toBeUndefined()
      expect(state.selectedOrgId).toBeUndefined()
    })
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("restores the user search, filter, page, and open user and organization", async () => {
    mocks.auth.mockImplementation(async (kind: string) => kind === "describe" ? description : kind === "organization" ? { id: "o1", invitations: [], invitationsTotal: 0, members: [], membersTotal: 0, name: "Acme" } : { items: [], total: 80 })
    const { push, replace, router, state } = await mountPage<{ filter: string, offset: number, search: string, selectedOrg?: { id: string }, selectedOrgId: string | undefined, selectedUser: string | undefined }>(
      Auth, { sectionsBase: "/sections" }, "/auth/users?q=ann&filter=admins&offset=25&user=u1", routes,
    )
    await vi.waitFor(() => expect(mocks.auth).toHaveBeenCalledWith("users", { query: { filter: "admins", limit: 25, offset: 25, search: "ann" } }, expect.anything()))
    expect(state.selectedUser).toBe("u1")
    state.offset = 50
    await settle(router, { filter: "admins", offset: "50", q: "ann", user: "u1" })
    expect(push).toHaveBeenCalledOnce()
    state.filter = "banned"
    await settle(router, { filter: "banned", offset: "50", q: "ann", user: "u1" })
    expect(replace).toHaveBeenCalledOnce()
    state.selectedOrgId = "o1"
    await vi.waitFor(() => expect(state.selectedOrg?.id).toBe("o1"))
    router.back()
    await vi.waitFor(() => expect(state.selectedOrg).toBeUndefined())
  })
})

describe("Env", async () => {
  const Env = (await import("../src/console/runtime/components/console-env.vue")).default
  const routes = [{ component: {}, name: "vitehub-console-env", path: "/env" }]
  const entries = ["token", "label"].map(name => ({ hasDefault: false, path: `env.server.${name}`, required: true, secret: false, source: "env" }))

  it("restores the search, source, and open variable", async () => {
    mocks.request.mockResolvedValue({ entries })
    const { push, router, state } = await mountPage<{ search: string, selected?: { path: string }, source: string }>(
      Env, { ...bases, envBase: "/env-api" }, "/env?q=tok&source=Host%20environment&variable=env.server.token", routes,
    )
    await vi.waitFor(() => expect(state.selected?.path).toBe("env.server.token"))
    expect([state.search, state.source]).toEqual(["tok", "Host environment"])
    state.selected = entries[1]!
    await settle(router, { q: "tok", source: "Host environment", variable: "env.server.label" })
    expect(push).toHaveBeenCalled()
    router.back()
    await vi.waitFor(() => expect(state.selected?.path).toBe("env.server.token"))
  })

  it("drops a source that the variables do not have", async () => {
    mocks.request.mockResolvedValue({ entries })
    const { router, state } = await mountPage<{ source: string }>(Env, { ...bases, envBase: "/env-api" }, "/env?source=Vault", routes)
    await vi.waitFor(() => expect(state.source).toBe("all"))
    await settle(router, {})
  })
})

describe("Operation views such as Comments", async () => {
  const View = (await import("../src/console/runtime/components/console-operation-view.vue")).default
  const routes = [{ component: {}, name: "vitehub-console-comments", path: "/comments" }]
  const details = { id: "comments", label: "Comments", view: { columns: [], filters: [{ id: "open", input: { status: "open" }, label: "Open" }, { id: "resolved", input: { status: "resolved" }, label: "Resolved" }], kind: "operation-view", operation: "comments.list" } }

  it("loads the filter of the URL and leaves the first filter out of it", async () => {
    mocks.operation.mockResolvedValue([])
    const { replace, router, state } = await mountPage<{ choose: (id: string) => void }>(View, { definitionsBase: "/definitions", details, sectionsBase: "/sections" }, "/comments?filter=resolved", routes)
    await vi.waitFor(() => expect(mocks.operation).toHaveBeenLastCalledWith(details.view, { status: "resolved" }, expect.anything()))
    state.choose("open")
    await settle(router, {})
    expect(replace).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(mocks.operation).toHaveBeenLastCalledWith(details.view, { status: "open" }, expect.anything()))
  })
})

describe("Rate Limits", async () => {
  const RateLimit = (await import("../src/console/runtime/components/console-rate-limit.vue")).default
  const routes = [{ component: {}, name: "vitehub-console-rate-limits", path: "/rate-limits" }]

  it("reads a restored key against its destination definition in the reused counter component", async () => {
    const Definitions = (await import("../src/console/runtime/components/console-definitions.vue")).default
    mocks.request.mockResolvedValue({ definitions: ["login", "signup"].map(name => ({ file: `server/rate-limits/${name}.ts`, name, source: "server/rate-limits" })), kind: "definition-catalog", section: "rate-limits" })
    mocks.peek.mockImplementation(async (_base: string, name: string, key: string) => ({ counters: [], key, name, provider: "memory", status: "unused" }))
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push("/rate-limits?definition=login&key=alice")
    const Counter: Component = { ...RateLimit, render: () => null }
    const app = renderer.createApp({
      ...Definitions,
      // Render the real catalog's selected definition with its counter, leaving out the dashboard UI.
      render(_ctx: unknown, _cache: unknown, _props: unknown, state: { selectedDefinition?: { name: string } }) {
        return state.selectedDefinition ? h(Counter, { base: "/rate-limit", name: state.selectedDefinition.name }) : null
      },
    }, { ...bases, details: { id: "rate-limits", label: "Rate Limits", view: { kind: "definition-catalog" } } })
    app.use(router)
    app.provide(ssrContextKey, {})
    const instance = app.mount({})
    unmounts.push(() => app.unmount())
    // SAFETY: exercise the catalog action that the selection controls call.
    const catalog = (instance.$ as unknown as { setupState: { selectDefinition: (name: string) => void } }).setupState
    await vi.waitFor(() => expect(mocks.peek).toHaveBeenLastCalledWith("/rate-limit", "login", "alice", expect.anything()))
    const replace = vi.spyOn(router, "replace")
    mocks.peek.mockClear()
    catalog.selectDefinition("signup")
    await settle(router, { definition: "signup" })
    expect(mocks.peek).not.toHaveBeenCalled()
    router.back()
    await vi.waitFor(() => expect(mocks.peek).toHaveBeenLastCalledWith("/rate-limit", "login", "alice", expect.anything()))
    await settle(router, { definition: "login", key: "alice" })
    expect(mocks.peek).toHaveBeenCalledOnce()
    expect(replace).not.toHaveBeenCalled()
    await router.push("/rate-limits?definition=signup&key=bob")
    await vi.waitFor(() => expect(mocks.peek).toHaveBeenLastCalledWith("/rate-limit", "signup", "bob", expect.anything()))
    await settle(router, { definition: "signup", key: "bob" })
    router.back()
    await vi.waitFor(() => expect(mocks.peek).toHaveBeenLastCalledWith("/rate-limit", "login", "alice", expect.anything()))
    await settle(router, { definition: "login", key: "alice" })
    expect(replace).not.toHaveBeenCalled()
    router.forward()
    await vi.waitFor(() => expect(mocks.peek).toHaveBeenLastCalledWith("/rate-limit", "signup", "bob", expect.anything()))
    await settle(router, { definition: "signup", key: "bob" })
    expect(replace).not.toHaveBeenCalled()
  })

  it("reads the counter of the key in the URL and writes the key it reads", async () => {
    mocks.peek.mockImplementation(async (_base: string, name: string, key: string) => ({ counters: [], key, name, provider: "memory", status: "unused" }))
    const { router, state } = await mountPage<{ key: string, peek: () => Promise<void> }>(RateLimit, { base: "/rate-limit", name: "login" }, "/rate-limits?definition=login&key=1.2.3.4", routes)
    await vi.waitFor(() => expect(mocks.peek).toHaveBeenCalledWith("/rate-limit", "login", "1.2.3.4", expect.anything()))
    state.key = "user-7"
    await state.peek()
    await settle(router, { definition: "login", key: "user-7" })
  })
})

describe("KV", async () => {
  const KV = (await import("../src/console/runtime/components/console-kv.vue")).default
  const routes = [{ component: {}, name: "vitehub-console-kv", path: "/kv" }]

  it("keeps the key filter in the URL", async () => {
    mocks.request.mockResolvedValue({ keys: ["user:1", "post:1"], stores: ["default"] })
    const { replace, router, state } = await mountPage<{ keyFilter: string, visibleKeys: string[] }>(KV, bases, "/kv?q=user", routes)
    expect(state.keyFilter).toBe("user")
    await vi.waitFor(() => expect(state.visibleKeys).toEqual(["user:1"]))
    state.keyFilter = "post"
    await vi.waitFor(() => expect(router.currentRoute.value.query.q).toBe("post"))
    expect(replace).toHaveBeenCalledWith({ query: expect.objectContaining({ q: "post" }) })
  })
})

describe("Blob and Content media", async () => {
  const Blob = (await import("../src/console/runtime/components/console-blob.vue")).default
  const Media = (await import("../src/console/runtime/components/console-media-library.vue")).default
  const file = { contentType: "image/png", pathname: "img/cat.png", size: 1, uploadedAt: "2026-11-01T00:00:00.000Z" }

  it("restores the Blob folder, search, type, and open object", async () => {
    mocks.blobGet.mockResolvedValue(file)
    const { push, router, state } = await mountPage<{ active?: { pathname: string }, folder: string, open: (file: undefined) => void, search: string, store: string, type: string }>(
      Blob, { ...bases, blobBase: "/blob" }, "/blob?folder=img&q=cat&type=image&file=img/cat.png", [{ component: {}, name: "vitehub-console-blob", path: "/blob" }],
    )
    await vi.waitFor(() => expect(state.active?.pathname).toBe("img/cat.png"))
    expect([state.folder, state.search, state.type, state.store]).toEqual(["img", "cat", "image", "default"])
    state.open(undefined)
    await settle(router, { folder: "img", q: "cat", type: "image" })
    expect(push).toHaveBeenCalledOnce()
    router.back()
    await vi.waitFor(() => expect(state.active?.pathname).toBe("img/cat.png"))
  })

  it("restores the Content media search and type", async () => {
    const client = { get: vi.fn(async () => file) }
    const { replace, router, state } = await mountPage<{ search: string, type: string }>(
      Media, { client, label: "Media", section: "content" }, "/content/media?folder=img&q=cat&type=video", [{ component: {}, name: "media", path: "/content/media" }],
    )
    expect([state.search, state.type]).toEqual(["cat", "video"])
    state.type = "all"
    await settle(router, { folder: "img", q: "cat" })
    expect(replace).toHaveBeenCalledOnce()
  })
})

describe("Definition catalogs", async () => {
  const Definitions = (await import("../src/console/runtime/components/console-definitions.vue")).default
  const routes = [{ component: {}, name: "vitehub-console-queues", path: "/queues" }]
  const details = { id: "queues", label: "Queues", view: { kind: "definition-catalog" } }

  it("clears the counter key for a new Rate Limit selection and preserves it in Back history", async () => {
    mocks.request.mockResolvedValue({ definitions: ["login", "signup"].map(name => ({ file: `server/rate-limits/${name}.ts`, name, source: "server/rate-limits" })), kind: "definition-catalog", section: "rate-limits" })
    const { router, state } = await mountPage<{ selectDefinition: (name: string) => void, selectedName?: string }>(
      Definitions, { ...bases, details: { ...details, id: "rate-limits", label: "Rate Limits" } }, "/rate-limits?definition=login&key=alice", [{ component: {}, name: "vitehub-console-rate-limits", path: "/rate-limits" }],
    )
    await vi.waitFor(() => expect(state.selectedName).toBe("login"))
    state.selectDefinition("signup")
    await settle(router, { definition: "signup" })
    router.back()
    await vi.waitFor(() => expect(state.selectedName).toBe("login"))
    await settle(router, { definition: "login", key: "alice" })
  })

  it("adds a history entry for each selected definition", async () => {
    mocks.request.mockResolvedValue({ definitions: ["emails", "images"].map(name => ({ file: `server/queues/${name}.ts`, name, source: "server/queues" })), kind: "definition-catalog", section: "queues" })
    const { push, router, state } = await mountPage<{ selectDefinition: (name: string) => void, selectedName?: string }>(Definitions, { ...bases, details }, "/queues?definition=emails", routes)
    await vi.waitFor(() => expect(state.selectedName).toBe("emails"))
    state.selectDefinition("images")
    await settle(router, { definition: "images" })
    expect(push).toHaveBeenCalledOnce()
    router.back()
    await vi.waitFor(() => expect(state.selectedName).toBe("emails"))
  })
})
