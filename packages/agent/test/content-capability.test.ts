import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { defineContent, documents, singleton } from "../../content/src/index.ts"
import { historyWorkspace } from "../../content/test/history-workspace.ts"
import { content } from "../src/capabilities.ts"
import { createAgentInspectionMetadata, defineAgent } from "../src/index.ts"
import { applyAgentToolPolicies } from "../src/tool-runtime.ts"

import type { ContentAuthorize } from "../../content/src/index.ts"
import type { ContentCapabilityOptions } from "../src/capabilities.ts"
import type { AgentActor, AgentCapabilityDefinition, AgentToolDefinition } from "../src/types.ts"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** Actors as `authenticated()` resolves them: the Auth user id is in `meta.authUserId`. */
const editor: AgentActor = { id: "user_1", kind: "authUser", label: "editor@example.com", meta: { authUserId: "user_1" } }
const viewer: AgentActor = { id: "user_2", kind: "authUser", label: "viewer@example.com", meta: { authUserId: "user_2" } }
const anonymous: AgentActor = { id: "anonymous:http", kind: "anonymous" }

/** Auth users by id, as the `auth` primitive from `@vite-hub/auth/agent` reads them. */
const authUsers: Record<string, Record<string, unknown>> = {
  user_1: { email: "editor@example.com", id: "user_1", role: "editor" },
  user_2: { email: "viewer@example.com", id: "user_2", role: "viewer" },
}
const auth = {
  user: async (actor: AgentActor | undefined) => {
    const id = actor?.meta?.authUserId
    return String(id) === id ? authUsers[id] ?? null : null
  },
}

/** Editors may do anything. Other signed-in users may read. */
const editorsOnly: ContentAuthorize = ({ user, action }) => user?.role === "editor" || (action === "read" && Boolean(user))

const fields = {
  title: z.string().min(1),
  date: z.coerce.date(),
  tags: z.array(z.string()).default([]),
}

async function setup({ authorize = editorsOnly, sessions = false, workspace }: { authorize?: ContentAuthorize | null, sessions?: boolean, workspace?: string } = {}) {
  workspace ??= await historyWorkspace(cleanup, { sessions })
  const runtime = defineContent({
    workspace,
    collections: {
      posts: documents({ path: "posts/**/*.md", fields }),
      pages: documents({ path: "pages/*.md", fields: { title: z.string() } }),
    },
    ...(authorize ? { authorize } : {}),
    logger: false,
  })
  cleanup.push(() => runtime.dispose())
  return runtime
}

/** A Markdown collection, a YAML collection, and a JSON singleton. */
async function setupMixed() {
  const runtime = defineContent({
    workspace: await historyWorkspace(cleanup),
    collections: {
      posts: documents({ path: "posts/*.md", fields: { title: z.string().min(1) } }),
      authors: documents({ path: "authors/*.yaml", fields: { name: z.string().min(1) }, label: { singular: "Author", plural: "People" } }),
      settings: singleton({ path: "settings.json", fields: { title: z.string().min(1), tagline: z.string().optional() } }),
    },
    authorize: editorsOnly,
    logger: false,
  })
  cleanup.push(() => runtime.dispose())
  return runtime
}

async function tools(
  capability: AgentCapabilityDefinition,
  runtime: unknown,
  actor: AgentActor = editor,
  primitives: Record<string, unknown> = { auth },
): Promise<Record<string, AgentToolDefinition>> {
  if (!(capability.tools instanceof Function)) throw new Error("content() must resolve tools from the Invocation context")
  // SAFETY: The Content tools read only the fields that this context sets.
  return await capability.tools({
    actor,
    agentIdentity: { name: "editor" },
    capabilities: { ...primitives, content: runtime },
    context: new Map(),
  } as never) as Record<string, AgentToolDefinition>
}

async function run(tool: AgentToolDefinition | undefined, input: unknown): Promise<any> {
  if (!tool?.execute) throw new Error("expected an executable tool")
  return await tool.execute(input as never, {})
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

const hello = { title: "Hello", date: "2026-10-14", tags: ["vue"] }
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

describe("content capability", () => {
  it("defines a write Capability over the content primitive and rejects invalid options", () => {
    expect(content()).toMatchObject({
      id: "content",
      metadata: { approval: ["content_publish", "content_schedule", "content_unschedule"], collections: "all", operations: ["read", "write", "publish"] },
      mode: "write",
      requires: [{ primitive: "content" }],
    })
    expect(content().metadata).not.toHaveProperty("lease")
    expect(content({ lease: "override" }).metadata).toMatchObject({ lease: "override" })
    expect(content({ operations: ["read"] })).toMatchObject({ metadata: { approval: [], operations: ["read"] }, mode: "read" })
    expect(content({ collections: ["posts"], policy: "allow" })).toMatchObject({ metadata: { approval: "allow", collections: ["posts"] } })
    expect(content({ policy: () => "deny" }).metadata).toMatchObject({ approval: "custom" })
    for (const options of [
      { operations: [] },
      { operations: ["delete"] },
      { collections: [] },
      { collections: ["posts", "posts"] },
      { policy: "maybe" },
      { user: "editor" },
      { lease: "always" },
      { mode: "write" },
    ]) {
      expect(() => content(options as ContentCapabilityOptions), JSON.stringify(options)).toThrow(expect.objectContaining({ code: "AGENT_C0012" }))
    }
  })

  it("derives tool input schemas from each collection's fields", async () => {
    const runtime = await setup()
    const all = await tools(content(), runtime)
    expect(Object.keys(all).sort()).toEqual([
      "content_get_document",
      "content_list_collections",
      "content_list_documents",
      "content_list_schedules",
      "content_publish",
      "content_save_draft",
      "content_schedule",
      "content_status",
      "content_unschedule",
    ])
    const save = all.content_save_draft!.inputSchema as any
    expect(save.type).toBe("object")
    expect(save.anyOf).toBeUndefined()
    expect(save.required).toEqual(["collection", "id", "data", "body", "ifDigest"])
    expect(save.properties.collection.enum).toEqual(["posts", "pages"])
    expect(save.properties.data.anyOf.map((schema: any) => schema.title)).toEqual(["posts", "pages"])
    expect(save.properties.data.anyOf[0]).toMatchObject({
      properties: { tags: { items: { type: "string" }, type: "array" }, title: { minLength: 1, type: "string" } },
      required: ["title", "date"],
      type: "object",
    })
    expect((all.content_publish!.inputSchema as any).properties.documents.items.required).toEqual(["collection", "id", "digest"])
    expect((all.content_schedule!.inputSchema as any).required).toEqual(["at", "documents"])
    expect((all.content_unschedule!.inputSchema as any).required).toEqual(["schedule"])

    const posts = await tools(content({ collections: ["posts"] }), runtime)
    const postsSave = posts.content_save_draft!.inputSchema as any
    expect(postsSave.properties.collection.enum).toEqual(["posts"])
    expect(postsSave.properties.data).toMatchObject({ required: ["title", "date"], type: "object" })
    expect(postsSave.properties.data.anyOf).toBeUndefined()

    expect(Object.keys(await tools(content({ operations: ["read"] }), runtime)).sort()).toEqual([
      "content_get_document",
      "content_list_collections",
      "content_list_documents",
      "content_list_schedules",
      "content_status",
    ])
    expect(await rejection(tools(content({ collections: ["drafts"] }), runtime))).toMatchObject({ code: "AGENT_R1006" })
    expect(await rejection(tools(content(), { collections: () => [] }))).toMatchObject({ code: "AGENT_R1005" })
    expect(await rejection(tools(content(), undefined))).toMatchObject({ code: "AGENT_R0104" })
  })

  it("requires approval to publish, schedule, and unschedule by default and lets policy replace the defaults", async () => {
    const runtime = await setup()
    const guarded = applyAgentToolPolicies(await tools(content(), runtime))!
    const saved = await run(guarded.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "# Hello\n", ifDigest: null })
    expect(saved).toMatchObject({ ok: true, document: { collection: "posts", id: "hello" } })
    const reviewed = { documents: [{ collection: "posts", digest: saved.document.digest, id: "hello" }] }
    expect(await rejection(run(guarded.content_publish, reviewed))).toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(await rejection(run(guarded.content_schedule, { ...reviewed, at: inAnHour() }))).toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(await runtime.collection("posts").get("hello")).toBeNull()
    expect(await runtime.schedules()).toEqual([])
    const scheduled = await runtime.schedule({ at: inAnHour(), expect: [{ collection: "posts", id: "hello", digest: saved.document.digest }] })
    expect(await rejection(run(guarded.content_unschedule, { schedule: scheduled.id }))).toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(await runtime.schedules()).toHaveLength(1)

    const approving = applyAgentToolPolicies(await tools(content({ policy: "require-approval" }), runtime))!
    expect(await rejection(run(approving.content_save_draft, { collection: "posts", id: "next", data: hello, body: "", ifDigest: null }))).toMatchObject({ code: "APPROVAL_REQUIRED" })

    const unattended = applyAgentToolPolicies(await tools(content({ policy: "allow" }), runtime))!
    expect(await run(unattended.content_unschedule, { schedule: scheduled.id })).toEqual({ ok: true, schedule: scheduled.id })
    expect(await run(unattended.content_publish, reviewed)).toMatchObject({
      ok: true,
      documents: [{ change: "add", collection: "posts", id: "hello" }],
    })
    expect(await runtime.collection("posts").get("hello")).toMatchObject({ data: { title: "Hello" } })
  })

  it("lists, reads, saves, compares, and publishes documents on the Blob + Database Store", async () => {
    const runtime = await setup()
    const editorTools = await tools(content({ collections: ["posts"] }), runtime)

    expect(await run(editorTools.content_list_collections, {})).toEqual({
      collections: [{
        access: { publish: true, read: true, write: true },
        fields: ["title", "date", "tags"],
        format: "markdown",
        kind: "documents",
        label: "Posts",
        name: "posts",
        path: "posts/**/*.md",
        titleField: "title",
      }],
    })
    const created = await run(editorTools.content_save_draft, { collection: "posts", id: "2026/hello", data: hello, body: "# Hello\n", ifDigest: null })
    expect(created).toMatchObject({ ok: true, document: { collection: "posts", id: "2026/hello", path: "posts/2026/hello.md", data: { tags: ["vue"], title: "Hello" } } })
    expect(created.document.body).toBeUndefined()
    expect(created.issues).toBeUndefined()

    expect(await run(editorTools.content_get_document, { collection: "posts", id: "2026/hello" })).toMatchObject({ ok: false, error: { code: "CONTENT_NOT_FOUND" } })
    const draft = await run(editorTools.content_get_document, { collection: "posts", id: "2026/hello", ref: "draft" })
    expect(draft).toMatchObject({ ok: true, ref: "draft", document: { body: "# Hello\n", digest: created.document.digest, updatedAt: expect.any(String) } })

    const updated = await run(editorTools.content_save_draft, {
      collection: "posts", id: "2026/hello", data: { ...hello, title: "Hello again" }, body: "# Hello again\n", ifDigest: draft.document.digest,
    })
    expect(updated).toMatchObject({ ok: true, document: { data: { title: "Hello again" } } })
    expect(await run(editorTools.content_list_documents, { collection: "posts", ref: "draft", search: "again" })).toMatchObject({
      items: [{ id: "2026/hello" }], nextCursor: null, ref: "draft", total: 1,
    })
    expect(await run(editorTools.content_list_documents, { collection: "posts" })).toMatchObject({ items: [], ref: "published", total: 0 })
    expect(await run(editorTools.content_status, { collection: "posts" })).toEqual({
      collection: "posts",
      documents: [{ collection: "posts", draft: updated.document.digest, id: "2026/hello", published: null, state: "draft" }],
    })

    const published = await run(editorTools.content_publish, { documents: [{ collection: "posts", digest: updated.document.digest, id: "2026/hello" }] })
    expect(published).toMatchObject({ ok: true, documents: [{ change: "add", id: "2026/hello" }], revision: expect.any(String) })
    expect(await run(editorTools.content_list_documents, { collection: "posts", filter: { tags: "vue" } })).toMatchObject({ items: [{ id: "2026/hello" }], total: 1 })
    expect(await run(editorTools.content_status, { collection: "posts", id: "2026/hello" })).toMatchObject({ documents: [{ state: "published" }] })

    const revisions = await runtime.revisions("posts", "2026/hello")
    expect(revisions.revisions[0]!.metadata).toMatchObject({ agent: { actor: "user_1", name: "editor" } })
    expect(revisions.revisions[1]!.metadata).toMatchObject({ agent: { actor: "user_1", name: "editor" } })
  })

  it("saves drafts with field issues and refuses to publish or schedule them", async () => {
    const runtime = await setup()
    const editorTools = await tools(content({ policy: "allow" }), runtime)

    const invalid = await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: { title: "", tags: "vue" }, body: "", ifDigest: null })
    expect(invalid).toMatchObject({ ok: true, document: { id: "hello" }, hint: expect.stringContaining("cannot be published") })
    expect(invalid.issues.map((issue: { field: string }) => issue.field).sort()).toEqual(["date", "tags", "title"])
    expect(await run(editorTools.content_status, { collection: "posts", id: "hello" })).toMatchObject({ documents: [{ id: "hello", issues: 3 }] })
    expect(await run(editorTools.content_get_document, { collection: "posts", id: "hello", ref: "draft" })).toMatchObject({
      ok: true, document: { issues: expect.any(Array) }, hint: expect.stringContaining("field issues"),
    })

    const pinned = { documents: [{ collection: "posts", digest: invalid.document.digest, id: "hello" }] }
    const refused = await run(editorTools.content_publish, pinned)
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "CONTENT_INVALID", documents: [{ collection: "posts", id: "hello", path: "posts/hello.md", issues: expect.any(Array) }], hint: expect.stringContaining("content_save_draft") },
    })
    expect(await run(editorTools.content_schedule, { ...pinned, at: inAnHour() })).toMatchObject({
      ok: false, error: { code: "CONTENT_INVALID", documents: [{ collection: "posts", id: "hello" }] },
    })
    expect(await runtime.collection("posts").get("hello")).toBeNull()
    expect(await runtime.schedules()).toEqual([])

    const fixed = await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "", ifDigest: invalid.document.digest })
    expect(fixed).toMatchObject({ ok: true })
    expect(fixed.issues).toBeUndefined()
    expect(await run(editorTools.content_publish, { documents: [{ collection: "posts", digest: fixed.document.digest, id: "hello" }] })).toMatchObject({ ok: true })

    // Data that cannot be stored at all is still an input error.
    expect(await run(editorTools.content_save_draft, { collection: "posts", id: "broken", data: "title", body: "", ifDigest: null })).toMatchObject({
      ok: false, error: { code: "CONTENT_INVALID" },
    })
  })

  it("returns conflicts as results the model can act on", async () => {
    const runtime = await setup()
    const editorTools = await tools(content({ policy: "allow" }), runtime)

    const first = await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "One\n", ifDigest: null })
    await runtime.collection("posts").save("hello", { data: hello, body: "Edited by someone else\n" })
    const conflict = await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Two\n", ifDigest: first.document.digest })
    const current = await runtime.collection("posts").get("hello", { ref: "draft" })
    expect(conflict).toMatchObject({ ok: false, error: { code: "WORKSPACE_CONFLICT", currentDigest: current!.digest, hint: expect.stringContaining("content_get_document") } })
    expect(await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Two\n", ifDigest: conflict.error.currentDigest })).toMatchObject({ ok: true })
    expect(await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Three\n", ifDigest: null })).toMatchObject({
      ok: false, error: { code: "WORKSPACE_CONFLICT" },
    })
    expect(await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, ifDigest: null })).toMatchObject({
      ok: false, error: { code: "CONTENT_INVALID", issues: [{ path: ["body"] }] },
    })

    // The publish call names the reviewed digest. A save after the call publishes nothing and names the changed draft.
    const [reviewed] = (await run(editorTools.content_status, { collection: "posts", id: "hello" })).documents
    await runtime.collection("posts").save("hello", { data: hello, body: "Saved after review\n" })
    const changed = await run(editorTools.content_publish, { documents: [{ collection: "posts", digest: reviewed.draft, id: "hello" }] })
    const latest = await runtime.collection("posts").get("hello", { ref: "draft" })
    expect(changed).toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_CONFLICT",
        documents: [{ actual: latest!.digest, collection: "posts", expected: reviewed.draft, id: "hello" }],
        hint: expect.stringContaining("content_status"),
      },
    })
    expect(await run(editorTools.content_schedule, { at: inAnHour(), documents: [{ collection: "posts", digest: reviewed.draft, id: "hello" }] })).toMatchObject({
      ok: false, error: { code: "WORKSPACE_CONFLICT", documents: [{ collection: "posts", id: "hello" }] },
    })
    expect(await runtime.collection("posts").get("hello")).toBeNull()
    expect(await run(editorTools.content_publish, { documents: [{ collection: "posts", digest: latest!.digest, id: "hello" }] })).toMatchObject({
      ok: true, documents: [{ change: "add", id: "hello" }],
    })
    expect(await run(editorTools.content_publish, { documents: [{ collection: "posts", digest: null, id: "missing" }] })).toMatchObject({ ok: true, documents: [] })
    expect(await run(editorTools.content_publish, { documents: [] })).toMatchObject({ ok: false, error: { code: "CONTENT_INVALID" } })
    expect(await run(editorTools.content_publish, { documents: [{ collection: "posts", digest: null }] })).toMatchObject({
      ok: false, error: { code: "CONTENT_INVALID", issues: [{ path: ["documents.0.id"] }] },
    })
    expect(await run(editorTools.content_publish, {
      documents: [{ collection: "posts", digest: null, id: "hello" }, { collection: "posts", digest: null, id: "hello" }],
    })).toMatchObject({ ok: false, error: { code: "CONTENT_R0009" } })
  })

  it("returns a published document that no longer validates as text the model can repair", async () => {
    const workspace = await historyWorkspace(cleanup)
    const runtime = await setup({ workspace })
    await runtime.collection("posts").save("untagged", { data: { title: "Untagged", date: "2026-01-01" }, body: "Body\n" })
    await runtime.publish()
    // The field schema became stricter after the document was published.
    const stricter = defineContent({
      workspace,
      collections: { posts: documents({ path: "posts/**/*.md", fields: { ...fields, tags: z.array(z.string()).min(1) } }) },
      authorize: editorsOnly,
      logger: false,
    })
    cleanup.push(() => stricter.dispose())
    const editorTools = await tools(content({ collections: ["posts"], policy: "allow" }), stricter)

    const invalid = await run(editorTools.content_get_document, { collection: "posts", id: "untagged" })
    const { draft } = (await stricter.collection("posts").status("untagged"))!
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "CONTENT_INVALID", digest: draft, hint: expect.stringContaining("ifDigest"), text: expect.stringContaining("title: Untagged") },
    })
    expect(await run(editorTools.content_save_draft, {
      collection: "posts", id: "untagged", data: { title: "Untagged", date: "2026-01-01", tags: ["fixed"] }, body: "Body\n", ifDigest: invalid.error.digest,
    })).toMatchObject({ ok: true })
  })

  it("reads, saves, publishes, and schedules singletons and data collections without a body", async () => {
    const runtime = await setupMixed()
    const editorTools = await tools(content({ policy: "allow" }), runtime)

    expect((await run(editorTools.content_list_collections, {})).collections).toEqual([
      expect.objectContaining({ format: "markdown", kind: "documents", label: "Posts", name: "posts", titleField: "title" }),
      expect.objectContaining({ fields: ["name"], format: "yaml", kind: "documents", label: "People", name: "authors", titleField: "name" }),
      { access: { publish: true, read: true, write: true }, fields: ["title", "tagline"], format: "json", id: "settings", kind: "singleton", label: "Settings", name: "settings", path: "settings.json", titleField: "title" },
    ])
    const save = editorTools.content_save_draft!.inputSchema as any
    expect(save.type).toBe("object")
    expect(save.required).toEqual(["collection", "data", "ifDigest"])
    expect(save.properties.body.description).toContain("Omit it for a JSON or YAML collection")
    expect((editorTools.content_get_document!.inputSchema as any).required).toEqual(["collection"])
    expect((editorTools.content_publish!.inputSchema as any).properties.documents.items.required).toEqual(["collection", "digest"])

    // A singleton takes no id. Its own id works too; any other id is an input error.
    expect(await run(editorTools.content_save_draft, { collection: "settings", data: { title: "Site" }, body: "Text", ifDigest: null })).toMatchObject({
      ok: false, error: { code: "CONTENT_INVALID", issues: [{ path: ["body"] }] },
    })
    expect(await run(editorTools.content_save_draft, { collection: "settings", id: "other", data: { title: "Site" }, ifDigest: null })).toMatchObject({
      ok: false, error: { code: "CONTENT_INVALID", issues: [{ path: ["id"] }] },
    })
    expect(await run(editorTools.content_save_draft, { collection: "posts", data: { title: "Post" }, body: "", ifDigest: null })).toMatchObject({
      ok: false, error: { code: "CONTENT_INVALID", issues: [{ path: ["id"] }] },
    })
    const saved = await run(editorTools.content_save_draft, { collection: "settings", data: { title: "Site" }, body: "", ifDigest: null })
    expect(saved).toMatchObject({ ok: true, document: { collection: "settings", id: "settings", path: "settings.json", data: { title: "Site" } } })
    expect(await run(editorTools.content_get_document, { collection: "settings", ref: "draft" })).toMatchObject({ ok: true, document: { id: "settings", body: "" } })
    expect(await run(editorTools.content_get_document, { collection: "settings", id: "settings", ref: "draft" })).toMatchObject({ ok: true })
    expect(await run(editorTools.content_status, { collection: "settings" })).toMatchObject({ documents: [{ id: "settings", state: "draft", draft: saved.document.digest }] })
    expect(await run(editorTools.content_list_documents, { collection: "settings", ref: "draft" })).toMatchObject({ items: [{ id: "settings" }], total: 1 })

    const author = await run(editorTools.content_save_draft, { collection: "authors", id: "ana", data: { name: "Ana" }, ifDigest: null })
    expect(author).toMatchObject({ ok: true, document: { path: "authors/ana.yaml" } })
    expect(await run(editorTools.content_save_draft, { collection: "authors", id: "ben", data: { name: "Ben" }, body: "Bio", ifDigest: null })).toMatchObject({
      ok: false, error: { code: "CONTENT_INVALID", issues: [{ path: ["body"] }] },
    })

    expect(await run(editorTools.content_publish, { documents: [{ collection: "settings", digest: saved.document.digest }] })).toMatchObject({
      ok: true, documents: [{ change: "add", collection: "settings", id: "settings" }],
    })
    expect(await runtime.collection("settings").get()).toMatchObject({ data: { title: "Site" } })

    const next = await run(editorTools.content_save_draft, { collection: "settings", data: { title: "Site", tagline: "Fast" }, ifDigest: saved.document.digest })
    const scheduled = await run(editorTools.content_schedule, {
      at: inAnHour(),
      documents: [{ collection: "settings", digest: next.document.digest }, { collection: "authors", id: "ana", digest: author.document.digest }],
    })
    expect(scheduled).toMatchObject({
      ok: true,
      schedule: { documents: [{ collection: "settings", id: "settings", digest: next.document.digest }, { collection: "authors", id: "ana" }], status: "pending" },
    })
    expect(await run(editorTools.content_status, { collection: "settings" })).toMatchObject({ documents: [{ schedule: { id: scheduled.schedule.id, status: "pending" } }] })
  })

  it("schedules reviewed drafts, lists schedules, and cancels them", async () => {
    const runtime = await setup()
    const editorTools = await tools(content({ policy: "allow" }), runtime)
    const saved = await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Hello\n", ifDigest: null })
    const documents = [{ collection: "posts", digest: saved.document.digest, id: "hello" }]

    expect(await run(editorTools.content_schedule, { at: "2000-01-01T00:00:00Z", documents })).toMatchObject({
      ok: false, error: { code: "CONTENT_R0011", hint: expect.stringContaining("future ISO timestamp"), message: expect.stringContaining("must be in the future") },
    })
    const at = inAnHour()
    const scheduled = await run(editorTools.content_schedule, { at, documents, message: "Launch" })
    expect(scheduled).toEqual({
      ok: true,
      schedule: { at: expect.any(String), createdAt: expect.any(String), documents, id: expect.any(String), message: "Launch", status: "pending" },
    })
    expect(new Date(scheduled.schedule.at).getTime()).toBe(new Date(at).getTime())
    expect((await runtime.schedules())[0]!.metadata).toMatchObject({ agent: { actor: "user_1", name: "editor" } })
    expect(await run(editorTools.content_list_schedules, {})).toEqual({ schedules: [scheduled.schedule] })
    expect(await run(editorTools.content_list_schedules, { collection: "posts", id: "hello", status: "pending" })).toEqual({ schedules: [scheduled.schedule] })
    expect(await run(editorTools.content_list_schedules, { collection: "pages" })).toEqual({ schedules: [] })
    expect(await run(editorTools.content_status, { collection: "posts", id: "hello" })).toMatchObject({
      documents: [{ schedule: { digest: saved.document.digest, id: scheduled.schedule.id, status: "pending" } }],
    })

    // A viewer may see the schedule but not cancel it, and is denied before any approval.
    const viewerTools = applyAgentToolPolicies(await tools(content(), runtime, viewer))!
    expect(await run(viewerTools.content_list_schedules, {})).toEqual({ schedules: [scheduled.schedule] })
    expect(await rejection(run(viewerTools.content_unschedule, { schedule: scheduled.schedule.id }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await rejection(run(viewerTools.content_schedule, { at, documents }))).toMatchObject({ code: "CAPABILITY_DENIED" })

    // A Capability scoped to other collections may not cancel a schedule that publishes posts.
    const pagesOnly = await tools(content({ collections: ["pages"], policy: "allow" }), runtime)
    expect(await run(pagesOnly.content_list_schedules, {})).toEqual({ schedules: [] })
    expect(await rejection(run(pagesOnly.content_unschedule, { schedule: scheduled.schedule.id }))).toMatchObject({ code: "CAPABILITY_DENIED" })

    expect(await run(editorTools.content_unschedule, { schedule: scheduled.schedule.id })).toEqual({ ok: true, schedule: scheduled.schedule.id })
    expect(await runtime.schedules()).toEqual([])
    expect(await run(editorTools.content_unschedule, { schedule: scheduled.schedule.id })).toMatchObject({ ok: false, error: { code: "CONTENT_NOT_FOUND" } })
  })

  it("honours edit leases unless the definition opts in to override them", async () => {
    const runtime = await setup({ sessions: true })
    const saved = await runtime.collection("posts").save("hello", { data: hello, body: "Hello\n" })
    const lease = await runtime.sessions.acquire("posts", "hello", { session: "tab-ana-0001", user: { id: "ana", name: "Ana" } })
    expect(lease.editing).toBe(true)

    const honouring = await tools(content({ policy: "allow" }), runtime)
    const held = await run(honouring.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Agent\n", ifDigest: saved.digest })
    expect(held).toEqual({
      ok: false,
      error: {
        code: "CONTENT_LEASE_HELD",
        hint: expect.stringContaining("wait until the lease expires"),
        holder: { expiresAt: expect.any(String), kind: "edit", name: "Ana", since: expect.any(String) },
        message: expect.stringContaining("Ana"),
      },
    })
    expect((await runtime.collection("posts").get("hello", { ref: "draft" }))!.body).toBe("Hello\n")
    // The model cannot pass the override itself.
    expect(await run(honouring.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Agent\n", ifDigest: saved.digest, lease: "override" })).toMatchObject({
      ok: false, error: { code: "CONTENT_LEASE_HELD" },
    })

    const overriding = await tools(content({ lease: "override", policy: "allow" }), runtime)
    expect(await run(overriding.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Agent\n", ifDigest: saved.digest })).toMatchObject({ ok: true })
    expect((await runtime.collection("posts").get("hello", { ref: "draft" }))!.body).toBe("Agent\n")
  })

  it("never shows a document that authorize hides from the user", async () => {
    // Everyone signed in may read, except the `secret` post, which only editors may read.
    const runtime = await setup({
      authorize: ({ user, action, id }) => user?.role === "editor" || (action === "read" && Boolean(user) && id !== "secret"),
    })
    const posts = runtime.collection("posts")
    await posts.save("hello", { data: { ...hello, title: "Hello launch" }, body: "Hello\n" })
    await posts.save("secret", { data: { ...hello, title: "Secret launch" }, body: "Secret\n" })
    await runtime.publish()
    const visible = await posts.save("hello", { data: { ...hello, title: "Hello launch" }, body: "Hello again\n" })
    const secret = await posts.save("secret", { data: { ...hello, title: "Secret launch" }, body: "Secret again\n" })
    const extra = await runtime.collection("pages").save("about", { data: { title: "About" } })
    const both = await runtime.schedule({ at: inAnHour(), expect: [{ collection: "posts", id: "hello", digest: visible.digest }, { collection: "posts", id: "secret", digest: secret.digest }] })
    const alone = await runtime.schedule({ at: inAnHour(), expect: [{ collection: "pages", id: "about", digest: extra.digest }] })
    expect((await runtime.schedules()).map(schedule => schedule.id).sort()).toEqual([alone.id, both.id].sort())

    const viewerTools = await tools(content({ operations: ["read"] }), runtime, viewer)
    for (const ref of ["draft", "published"]) {
      const listed = await run(viewerTools.content_list_documents, { collection: "posts", ref })
      expect(listed, ref).toMatchObject({ items: [{ id: "hello" }], total: 1 })
      expect(await run(viewerTools.content_list_documents, { collection: "posts", ref, search: "launch" }), ref).toMatchObject({ items: [{ id: "hello" }], total: 1 })
      expect(await run(viewerTools.content_list_documents, { collection: "posts", ref, search: "secret" }), ref).toMatchObject({ items: [], total: 0 })
      expect(await run(viewerTools.content_list_documents, { collection: "posts", ref, filter: { id: ["secret"] } }), ref).toMatchObject({ items: [], total: 0 })
      expect(await rejection(run(viewerTools.content_get_document, { collection: "posts", id: "secret", ref })), ref).toMatchObject({ code: "CAPABILITY_DENIED" })
    }
    expect((await run(viewerTools.content_status, { collection: "posts" })).documents.map((status: { id: string }) => status.id)).toEqual(["hello"])
    expect(await rejection(run(viewerTools.content_status, { collection: "posts", id: "secret" }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect((await run(viewerTools.content_list_schedules, {})).schedules.map((schedule: { id: string }) => schedule.id)).toEqual([alone.id])
    expect(await run(viewerTools.content_list_schedules, { collection: "posts", id: "secret" })).toEqual({ schedules: [] })
    expect(JSON.stringify(await run(viewerTools.content_list_schedules, {}))).not.toContain("secret")

    const editorTools = await tools(content({ operations: ["read"] }), runtime)
    expect(await run(editorTools.content_list_documents, { collection: "posts" })).toMatchObject({ total: 2 })
    expect((await run(editorTools.content_list_schedules, {})).schedules).toHaveLength(2)
  })

  it("denies actions through content.can() with the Auth user behind the Actor", async () => {
    const runtime = await setup()
    await runtime.collection("posts").save("hello", { data: hello, body: "Draft\n" })
    await runtime.publish()
    const unpublished = await runtime.collection("posts").save("hello", { data: { ...hello, title: "Unpublished" }, body: "Draft\n" })
    const reviewed = { documents: [{ collection: "posts", digest: unpublished.digest, id: "hello" }] }

    const viewerTools = await tools(content({ policy: "allow" }), runtime, viewer)
    expect(await run(viewerTools.content_get_document, { collection: "posts", id: "hello", ref: "draft" })).toMatchObject({ document: { data: { title: "Unpublished" } } })
    expect(await rejection(run(viewerTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "", ifDigest: null }))).toMatchObject({
      code: "CAPABILITY_DENIED", details: { action: "write", collection: "posts", id: "hello" },
    })
    expect(await rejection(run(viewerTools.content_publish, reviewed))).toMatchObject({ code: "CAPABILITY_DENIED", details: { action: "publish", id: "hello" } })
    // Access is checked before approval, so a denied publish never waits for an approver.
    const guardedViewer = applyAgentToolPolicies(await tools(content(), runtime, viewer))!
    expect(await rejection(run(guardedViewer.content_publish, reviewed))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await rejection(run(guardedViewer.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "", ifDigest: null }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await run(viewerTools.content_list_collections, {})).toMatchObject({
      collections: [{ access: { publish: false, read: true, write: false }, name: "posts" }, { name: "pages" }],
    })

    // Anonymous Actors reach authorize as user: null. This policy lets them read nothing, published documents included.
    const anonymousTools = await tools(content(), runtime, anonymous)
    expect(await rejection(run(anonymousTools.content_get_document, { collection: "posts", id: "hello" }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await rejection(run(anonymousTools.content_get_document, { collection: "posts", id: "hello", ref: "draft" }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await rejection(run(anonymousTools.content_list_documents, { collection: "posts" }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await rejection(run(anonymousTools.content_status, { collection: "posts" }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await run(anonymousTools.content_list_schedules, {})).toEqual({ schedules: [] })

    // Without Auth, there is no user behind the Actor.
    const withoutAuth = await tools(content({ policy: "allow" }), runtime, editor, {})
    expect(await rejection(run(withoutAuth.content_status, { collection: "posts" }))).toMatchObject({ code: "CAPABILITY_DENIED" })

    // `user` replaces the Auth lookup with the application's own mapping.
    const mapped = await tools(content({ policy: "allow", user: actor => ({ id: actor.id, role: actor.id === "user_2" ? "editor" : "none" }) }), runtime, viewer)
    expect(await run(mapped.content_save_draft, { collection: "pages", id: "about", data: { title: "About" }, body: "", ifDigest: null })).toMatchObject({ ok: true })
  })

  it("passes the Auth user and the Actor to authorize", async () => {
    const decisions: unknown[] = []
    const runtime = await setup({
      authorize: (context) => {
        decisions.push(context)
        return context.actor?.kind === "authUser"
      },
    })
    await runtime.collection("pages").save("about", { data: { title: "About" } })
    const editorTools = await tools(content({ policy: "allow" }), runtime)
    await run(editorTools.content_status, { collection: "posts", id: "hello" })
    await run(editorTools.content_status, { collection: "pages" })
    expect(decisions).toEqual([
      { action: "read", actor: editor, collection: "posts", id: "hello", user: authUsers.user_1 },
      { action: "read", actor: editor, collection: "pages", user: authUsers.user_1 },
      { action: "read", actor: editor, collection: "pages", id: "about", user: authUsers.user_1 },
    ])
  })

  it("denies every action without an authorize policy", async () => {
    const runtime = await setup({ authorize: null })
    const saved = await runtime.collection("posts").save("hello", { data: hello })
    const scheduled = await runtime.schedule({ at: inAnHour(), expect: [{ collection: "posts", id: "hello", digest: saved.digest }] })
    const editorTools = await tools(content({ policy: "allow" }), runtime)
    expect(await run(editorTools.content_list_collections, {})).toMatchObject({
      collections: [{ access: { publish: false, read: false, write: false } }, { access: { publish: false, read: false, write: false } }],
    })
    expect(await run(editorTools.content_list_schedules, {})).toEqual({ schedules: [] })
    for (const [name, input] of [
      ["content_list_documents", { collection: "posts" }],
      ["content_list_documents", { collection: "posts", ref: "draft" }],
      ["content_get_document", { collection: "posts", id: "hello" }],
      ["content_status", { collection: "posts" }],
      ["content_save_draft", { collection: "posts", id: "hello", data: hello, body: "", ifDigest: null }],
      ["content_publish", { documents: [{ collection: "posts", digest: null, id: "hello" }] }],
      ["content_schedule", { at: inAnHour(), documents: [{ collection: "posts", digest: null, id: "hello" }] }],
      ["content_unschedule", { schedule: scheduled.id }],
    ] as const) {
      expect(await rejection(run(editorTools[name], input)), name).toMatchObject({ code: "CAPABILITY_DENIED" })
    }
  })

  it("lists the Content tools in Agent inspection", () => {
    const inspected = createAgentInspectionMetadata(defineAgent({
      capabilities: [content({ collections: ["posts"], operations: ["read", "write"] })],
      driver: "codex",
      workspace: { mode: "write" },
    }))
    expect(inspected.tools).toContainEqual(expect.objectContaining({
      commands: ["content_list_collections", "content_list_documents", "content_get_document", "content_status", "content_list_schedules", "content_save_draft"],
      description: "Read, draft, publish, and schedule documents in the posts Content collections.",
      name: "content",
    }))
  })
})
