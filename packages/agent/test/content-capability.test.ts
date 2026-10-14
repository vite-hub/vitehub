import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { defineContent, documents } from "../../content/src/index.ts"
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

const editor: AgentActor = { id: "user_1", kind: "authUser", meta: { role: "editor" } }
const viewer: AgentActor = { id: "user_2", kind: "authUser", meta: { role: "viewer" } }
const anonymous: AgentActor = { id: "anonymous:http", kind: "anonymous" }

/** Editors may do anything. Other signed-in users may read drafts. */
const editorsOnly: ContentAuthorize = ({ user, action }) =>
  (user?.meta as { role?: string } | undefined)?.role === "editor" || (action === "read" && Boolean(user))

const fields = {
  title: z.string().min(1),
  date: z.coerce.date(),
  tags: z.array(z.string()).default([]),
}

async function setup({ authorize = editorsOnly }: { authorize?: ContentAuthorize | null } = {}) {
  const workspace = await historyWorkspace(cleanup)
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

async function tools(
  capability: AgentCapabilityDefinition,
  runtime: unknown,
  actor: AgentActor = editor,
): Promise<Record<string, AgentToolDefinition>> {
  if (!(capability.tools instanceof Function)) throw new Error("content() must resolve tools from the Invocation context")
  // SAFETY: The Content tools read only the fields that this context sets.
  return await capability.tools({
    actor,
    agentIdentity: { name: "editor" },
    capabilities: { content: runtime },
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

describe("content capability", () => {
  it("defines a write Capability over the content primitive and rejects invalid options", () => {
    expect(content()).toMatchObject({
      id: "content",
      metadata: { approval: ["content_publish"], collections: "all", operations: ["read", "write", "publish"] },
      mode: "write",
      requires: [{ primitive: "content" }],
    })
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
      "content_publish",
      "content_save_draft",
      "content_status",
    ])
    const save = all.content_save_draft!.inputSchema as any
    expect(save.required).toEqual(["collection", "id", "data", "body", "ifDigest"])
    expect(save.properties.collection.enum).toEqual(["posts", "pages"])
    expect(save.properties.data.anyOf.map((schema: any) => schema.title)).toEqual(["posts", "pages"])
    expect(save.properties.data.anyOf[0]).toMatchObject({
      properties: { tags: { items: { type: "string" }, type: "array" }, title: { minLength: 1, type: "string" } },
      required: ["title", "date"],
      type: "object",
    })

    const posts = await tools(content({ collections: ["posts"] }), runtime)
    const postsSave = posts.content_save_draft!.inputSchema as any
    expect(postsSave.properties.collection.enum).toEqual(["posts"])
    expect(postsSave.properties.data).toMatchObject({ required: ["title", "date"], type: "object" })
    expect(postsSave.properties.data.anyOf).toBeUndefined()

    expect(Object.keys(await tools(content({ operations: ["read"] }), runtime)).sort()).toEqual([
      "content_get_document",
      "content_list_collections",
      "content_list_documents",
      "content_status",
    ])
    expect(await rejection(tools(content({ collections: ["drafts"] }), runtime))).toMatchObject({ code: "AGENT_R1006" })
    expect(await rejection(tools(content(), { collections: () => [] }))).toMatchObject({ code: "AGENT_R1005" })
    expect(await rejection(tools(content(), undefined))).toMatchObject({ code: "AGENT_R0104" })
  })

  it("requires approval to publish by default and lets policy replace the defaults", async () => {
    const runtime = await setup()
    const guarded = applyAgentToolPolicies(await tools(content(), runtime))!
    const saved = await run(guarded.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "# Hello\n", ifDigest: null })
    expect(saved).toMatchObject({ ok: true, document: { collection: "posts", id: "hello" } })
    expect(await rejection(run(guarded.content_publish, { collection: "posts" }))).toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(await runtime.collection("posts").get("hello")).toBeNull()

    const approving = applyAgentToolPolicies(await tools(content({ policy: "require-approval" }), runtime))!
    expect(await rejection(run(approving.content_save_draft, { collection: "posts", id: "next", data: hello, body: "", ifDigest: null }))).toMatchObject({ code: "APPROVAL_REQUIRED" })

    const unattended = applyAgentToolPolicies(await tools(content({ policy: "allow" }), runtime))!
    expect(await run(unattended.content_publish, { collection: "posts" })).toMatchObject({
      ok: true,
      documents: [{ change: "add", collection: "posts", id: "hello" }],
    })
    expect(await runtime.collection("posts").get("hello")).toMatchObject({ data: { title: "Hello" } })
  })

  it("lists, reads, saves, compares, and publishes documents on the Blob + Database Store", async () => {
    const runtime = await setup()
    const editorTools = await tools(content({ collections: ["posts"] }), runtime)

    expect(await run(editorTools.content_list_collections, {})).toEqual({
      collections: [{ access: { publish: true, read: true, write: true }, fields: ["title", "date", "tags"], name: "posts", path: "posts/**/*.md" }],
    })
    const created = await run(editorTools.content_save_draft, { collection: "posts", id: "2026/hello", data: hello, body: "# Hello\n", ifDigest: null })
    expect(created).toMatchObject({ ok: true, document: { collection: "posts", id: "2026/hello", path: "posts/2026/hello.md", data: { tags: ["vue"], title: "Hello" } } })
    expect(created.document.body).toBeUndefined()

    expect(await run(editorTools.content_get_document, { collection: "posts", id: "2026/hello" })).toMatchObject({ ok: false, error: { code: "CONTENT_NOT_FOUND" } })
    const draft = await run(editorTools.content_get_document, { collection: "posts", id: "2026/hello", ref: "draft" })
    expect(draft).toMatchObject({ ok: true, ref: "draft", document: { body: "# Hello\n", digest: created.document.digest } })

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
      documents: [{ draft: updated.document.digest, id: "2026/hello", published: null, state: "draft" }],
    })

    const published = await run(editorTools.content_publish, { collection: "posts", ids: ["2026/hello"] })
    expect(published).toMatchObject({ ok: true, documents: [{ change: "add", id: "2026/hello" }], revision: expect.any(String) })
    expect(await run(editorTools.content_list_documents, { collection: "posts", filter: { tags: "vue" } })).toMatchObject({ items: [{ id: "2026/hello" }], total: 1 })
    expect(await run(editorTools.content_status, { collection: "posts", id: "2026/hello" })).toMatchObject({ documents: [{ state: "published" }] })

    const revisions = await runtime.revisions("posts", "2026/hello")
    expect(revisions.revisions[0]!.metadata).toMatchObject({ agent: { actor: "user_1", name: "editor" } })
  })

  it("returns validation issues and conflicts as results the model can act on", async () => {
    const runtime = await setup()
    const editorTools = await tools(content({ policy: "allow" }), runtime)

    const invalid = await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: { title: "", tags: "vue" }, body: "", ifDigest: null })
    expect(invalid).toMatchObject({ ok: false, error: { code: "CONTENT_INVALID", hint: expect.stringContaining("Fix the listed fields") } })
    expect(invalid.error.issues.map((issue: { field: string }) => issue.field).sort()).toEqual(["date", "tags", "title"])

    const first = await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "One\n", ifDigest: null })
    await runtime.collection("posts").save("hello", { data: hello, body: "Edited by someone else\n" })
    const conflict = await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Two\n", ifDigest: first.document.digest })
    const current = await runtime.collection("posts").get("hello", { ref: "draft" })
    expect(conflict).toMatchObject({ ok: false, error: { code: "WORKSPACE_CONFLICT", currentDigest: current!.digest, hint: expect.stringContaining("content_get_document") } })
    expect(await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Two\n", ifDigest: conflict.error.currentDigest })).toMatchObject({ ok: true })
    expect(await run(editorTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "Three\n", ifDigest: null })).toMatchObject({
      ok: false, error: { code: "WORKSPACE_CONFLICT" },
    })

    const head = await run(editorTools.content_publish, { collection: "posts" })
    await runtime.collection("posts").save("hello", { data: hello, body: "Four\n" })
    await runtime.publish({ collection: "posts" })
    const stale = await run(editorTools.content_publish, { collection: "posts", ifHead: head.revision })
    expect(stale).toMatchObject({ ok: false, error: { code: "WORKSPACE_CONFLICT", currentHead: expect.any(String) } })
    expect(stale.error.currentHead).not.toBe(head.revision)
    expect(await run(editorTools.content_publish, { collection: "posts", ids: ["missing"] })).toMatchObject({ ok: false, error: { code: "CONTENT_NOT_FOUND" } })
  })

  it("denies non-public actions through content.can() with the Actor as the user", async () => {
    const runtime = await setup()
    await runtime.collection("posts").save("hello", { data: hello, body: "Draft\n" })
    await runtime.publish()
    await runtime.collection("posts").save("hello", { data: { ...hello, title: "Unpublished" }, body: "Draft\n" })

    const viewerTools = await tools(content({ policy: "allow" }), runtime, viewer)
    expect(await run(viewerTools.content_get_document, { collection: "posts", id: "hello", ref: "draft" })).toMatchObject({ document: { data: { title: "Unpublished" } } })
    expect(await rejection(run(viewerTools.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "", ifDigest: null }))).toMatchObject({
      code: "CAPABILITY_DENIED", details: { action: "write", collection: "posts", id: "hello" },
    })
    expect(await rejection(run(viewerTools.content_publish, { collection: "posts" }))).toMatchObject({ code: "CAPABILITY_DENIED", details: { action: "publish" } })
    // Access is checked before approval, so a denied publish never waits for an approver.
    const guardedViewer = applyAgentToolPolicies(await tools(content(), runtime, viewer))!
    expect(await rejection(run(guardedViewer.content_publish, { collection: "posts", ids: ["hello"] }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await rejection(run(guardedViewer.content_save_draft, { collection: "posts", id: "hello", data: hello, body: "", ifDigest: null }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await run(viewerTools.content_list_collections, {})).toMatchObject({
      collections: [{ access: { publish: false, read: true, write: false }, name: "posts" }, { name: "pages" }],
    })

    // Anonymous Actors reach authorize as user: null, so they read only what the site already serves.
    const anonymousTools = await tools(content(), runtime, anonymous)
    expect(await run(anonymousTools.content_get_document, { collection: "posts", id: "hello" })).toMatchObject({ document: { data: { title: "Hello" } } })
    expect(await rejection(run(anonymousTools.content_get_document, { collection: "posts", id: "hello", ref: "draft" }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await rejection(run(anonymousTools.content_list_documents, { collection: "posts", ref: "draft" }))).toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await rejection(run(anonymousTools.content_status, { collection: "posts" }))).toMatchObject({ code: "CAPABILITY_DENIED" })

    // `user` maps the Actor to the application's user shape.
    const mapped = await tools(content({ policy: "allow", user: actor => ({ id: actor.id, meta: { role: actor.id === "user_2" ? "editor" : "none" } }) }), runtime, viewer)
    expect(await run(mapped.content_save_draft, { collection: "pages", id: "about", data: { title: "About" }, body: "", ifDigest: null })).toMatchObject({ ok: true })
  })

  it("denies every non-public action without an authorize policy", async () => {
    const runtime = await setup({ authorize: null })
    const editorTools = await tools(content({ policy: "allow" }), runtime)
    expect(await run(editorTools.content_list_collections, {})).toMatchObject({
      collections: [{ access: { publish: false, read: false, write: false } }, { access: { publish: false, read: false, write: false } }],
    })
    expect(await run(editorTools.content_list_documents, { collection: "posts" })).toMatchObject({ total: 0 })
    for (const [name, input] of [
      ["content_list_documents", { collection: "posts", ref: "draft" }],
      ["content_get_document", { collection: "posts", id: "hello", ref: "draft" }],
      ["content_status", { collection: "posts" }],
      ["content_save_draft", { collection: "posts", id: "hello", data: hello, body: "", ifDigest: null }],
      ["content_publish", { collection: "posts" }],
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
      commands: ["content_list_collections", "content_list_documents", "content_get_document", "content_status", "content_save_draft"],
      description: "Read, draft, and publish documents in the posts Content collections.",
      name: "content",
    }))
  })
})
