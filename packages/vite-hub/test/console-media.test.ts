import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setBlobRuntimeConfig } from "@vite-hub/blob/runtime/state"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createBlobStorage } from "../../blob/src/storage.ts"
import { consoleBlobKey, consoleBlobRegistryKey, consoleBlobRootKey, consoleDocumentsKey, consoleDocumentsRegistryKey, consoleDocumentsRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey } from "../src/console/internal.ts"
import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleBlob } from "../src/console/runtime/server/blob.ts"
import { installConsoleDocuments } from "../src/console/runtime/server/documents.ts"
import { consoleMediaName } from "../src/console/runtime/server/media.ts"
import { handleConsoleRpcRequest } from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleDocumentActions, ConsoleMediaAccess } from "../src/console/runtime/server/documents.ts"

// SAFETY: Console state uses the same optional symbol keys in runtime and tests.
const scope = globalThis as ConsoleInvocationScope
const policyKey = Symbol.for("vitehub.console.access")
const keys = [consoleBlobKey, consoleBlobRegistryKey, consoleBlobRootKey, consoleDocumentsKey, consoleDocumentsRegistryKey, consoleDocumentsRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey, policyKey]

const roles: Record<string, ConsoleMediaAccess> = {
  editor: { manage: true, read: true, write: true },
  reader: { manage: false, read: true, write: false },
  stranger: { manage: false, read: false, write: false },
  writer: { manage: false, read: true, write: true },
}

let directory: string
let storage: BlobStorage
let role = "editor"
const references = vi.fn((input: unknown) => ({ input, references: {} }))

function actions(): ConsoleDocumentActions {
  const unused = () => {
    throw new Error("unused")
  }
  return {
    collections: () => [],
    get: unused,
    list: unused,
    mediaAccess: () => roles[role]!,
    overview: unused,
    publish: unused,
    raw: unused,
    references,
    remove: unused,
    restore: unused,
    revisions: unused,
    save: unused,
    schedule: unused,
    search: unused,
    unschedule: unused,
  }
}

function install(sections: readonly string[] = ["content", "blob"]): void {
  installConsoleSections("/app", sections)
  installConsoleDocuments("/app", { content: { actions: () => actions(), load: async () => ({}) } })
  installConsoleBlob("/app", storage)
}

async function respond(request: Request): Promise<{ body: Record<string, unknown>, status: number }> {
  const response = await withConsoleAccess((_event, access) => handleConsoleRpcRequest(request, { access }), { anySection: true })({ req: request })
  return { body: Object(await response.json()), status: response.status }
}

function media(action: string, body: Record<string, unknown> = {}, section = "content") {
  return respond(new Request("http://localhost/_vitehub/rpc/__call", {
    body: JSON.stringify({ input: { body, method: "POST", query: { action, section } }, method: consoleRpcMethods.media }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }))
}

function upload(fields: Record<string, string | File>, headers: Record<string, string> = { [consoleRpcHeader]: "1" }, section = "content") {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.set(name, value)
  return respond(new Request(`http://localhost/_vitehub/rpc/__upload?section=${section}`, { body: form, headers, method: "POST" }))
}

function file(name: string, text: string, type = "text/plain"): File {
  return new File([text], name, { type })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vitehub-console-media-"))
  storage = createBlobStorage(createDriver({ base: directory, driver: "fs" }), "default", { images: false, url: pathname => `/api/_vitehub/blob/${pathname}` })
  setBlobRuntimeConfig({ images: false, serve: { route: "/api/_vitehub/blob", store: "default" }, store: { base: directory, driver: "fs" } })
  role = "editor"
  references.mockClear()
  installConsoleAccess({ mode: "open" })
  install()
})

afterEach(async () => {
  for (const key of keys) Reflect.deleteProperty(scope, key)
  setBlobRuntimeConfig(undefined)
  await rm(directory, { force: true, recursive: true })
})

describe("Console media library", () => {
  it("names uploads for URLs and Markdown", () => {
    expect(consoleMediaName("Launch Day (final).PNG")).toBe("launch-day-final.png")
    expect(consoleMediaName("Café crème.jpg")).toBe("cafe-creme.jpg")
    expect(consoleMediaName("  ..hidden  ")).toBe("hidden")
  })

  it("uploads into a folder without overwriting, and reuses stored bytes", async () => {
    const first = await upload({ file: file("Cover Photo.txt", "one"), folder: "posts" })
    expect(first).toMatchObject({ status: 200, body: { ok: true, value: { duplicate: false, file: { name: "cover-photo.txt", pathname: "posts/cover-photo.txt", url: "/api/_vitehub/blob/posts/cover-photo.txt" } } } })
    // Another file with the same name gets its own pathname.
    await expect(upload({ file: file("cover photo.txt", "two"), folder: "posts" })).resolves.toMatchObject({ body: { value: { duplicate: false, file: { pathname: "posts/cover-photo-2.txt" } } } })
    // The same bytes return the stored file.
    await expect(upload({ file: file("again.txt", "one") })).resolves.toMatchObject({ body: { value: { duplicate: true, file: { pathname: "posts/cover-photo.txt" } } } })
  })

  it("lists one folder level and hides folder markers and ViteHub folders", async () => {
    await storage.put("vitehub/workspace-history/abc", "history")
    await media("createFolder", { name: "Blog Heroes" })
    await upload({ file: file("a.txt", "a") })
    await upload({ file: file("b.txt", "b"), folder: "blog-heroes" })
    const root = await media("list")
    expect(root.body.value).toMatchObject({
      access: roles.editor,
      folder: "",
      folders: ["blog-heroes"],
      items: [{ pathname: "a.txt" }],
      served: "/api/_vitehub/blob/",
      store: "default",
    })
    await expect(media("list", { folder: "blog-heroes" })).resolves.toMatchObject({ body: { value: { folder: "blog-heroes", folders: [], items: [{ pathname: "blog-heroes/b.txt" }] } } })
    // Search finds file names in every folder below the listed one.
    await expect(media("list", { search: "B." })).resolves.toMatchObject({ body: { value: { folders: [], items: [{ pathname: "blog-heroes/b.txt" }] } } })
    await expect(media("list", { search: "history" })).resolves.toMatchObject({ body: { value: { items: [] } } })
    await expect(media("info")).resolves.toMatchObject({ body: { value: { access: roles.editor, served: "/api/_vitehub/blob/", store: "default" } } })
  })

  it("updates details, renames, moves, and deletes files and folders", async () => {
    await upload({ file: file("a.txt", "a") })
    await expect(media("update", { alt: "  ", caption: "A note", pathname: "a.txt" })).resolves.toMatchObject({ body: { value: { caption: "A note", pathname: "a.txt" } } })
    const moved = await media("move", { moves: [{ from: "a.txt", to: "notes/Renamed File.txt" }, { from: "missing.txt", to: "notes/missing.txt" }] })
    expect(moved.body.value).toMatchObject({ failed: [{ pathname: "missing.txt" }], moved: [{ caption: "A note", pathname: "notes/renamed-file.txt" }] })
    await expect(media("moveFolder", { from: "notes", to: "Archive" })).resolves.toMatchObject({ body: { value: { moved: 1, path: "archive" } } })
    await expect(media("removeFolder", { path: "archive" })).resolves.toMatchObject({ body: { code: "BLOB_CONFLICT" }, status: 409 })
    await expect(media("removeFolder", { force: true, path: "archive" })).resolves.toMatchObject({ body: { value: { removed: 1 } } })
    await upload({ file: file("b.txt", "b") })
    await expect(media("remove", { pathnames: ["b.txt"] })).resolves.toMatchObject({ body: { value: { failed: [], removed: ["b.txt"] } } })
    await expect(media("get", { pathname: "b.txt" })).resolves.toMatchObject({ status: 404 })
  })

  it("asks the section owner which documents use files", async () => {
    await expect(media("usage", { pathnames: ["a.txt", "b.txt"] })).resolves.toMatchObject({ body: { value: { input: { pathnames: ["a.txt", "b.txt"] } } } })
    expect(references).toHaveBeenCalledOnce()
  })

  it("lets writers upload and describe files, and leaves moves and deletes to publishers", async () => {
    await upload({ file: file("a.txt", "a") })
    role = "writer"
    await expect(upload({ file: file("b.txt", "b") })).resolves.toMatchObject({ status: 200 })
    await expect(media("update", { alt: "Alt", pathname: "a.txt" })).resolves.toMatchObject({ status: 200 })
    await expect(media("createFolder", { name: "drafts" })).resolves.toMatchObject({ status: 200 })
    for (const [action, body] of [["move", { moves: [{ from: "a.txt", to: "b/a.txt" }] }], ["remove", { pathnames: ["a.txt"] }], ["moveFolder", { from: "drafts", to: "x" }], ["removeFolder", { path: "drafts" }]] as const) {
      await expect(media(action, body), action).resolves.toMatchObject({ body: { code: "MEDIA_FORBIDDEN" }, status: 403 })
    }
    role = "reader"
    await expect(media("list")).resolves.toMatchObject({ status: 200 })
    await expect(upload({ file: file("c.txt", "c") })).resolves.toMatchObject({ body: { code: "MEDIA_FORBIDDEN" }, status: 403 })
    await expect(media("update", { alt: "Alt", pathname: "a.txt" })).resolves.toMatchObject({ status: 403 })
    role = "stranger"
    await expect(media("list")).resolves.toMatchObject({ body: { code: "MEDIA_FORBIDDEN" }, status: 403 })
  })

  it("needs the section in the Console access and Blob in the project", async () => {
    installConsoleAccess({ authorize: () => ({ sections: ["kv"] }), mode: "open" })
    await expect(media("list")).resolves.toMatchObject({ status: 403 })
    await expect(upload({ file: file("a.txt", "a") })).resolves.toMatchObject({ status: 403 })
    // Blob access is not needed: Content users manage media through the Content section.
    installConsoleAccess({ authorize: () => ({ sections: ["content"] }), mode: "open" })
    await expect(media("list")).resolves.toMatchObject({ status: 200 })
    install(["content"])
    await expect(media("list")).resolves.toMatchObject({ status: 404 })
  })

  it("rejects cross-site and oversized uploads, and unknown actions", async () => {
    await expect(upload({ file: file("a.txt", "a") }, { origin: "https://evil.example" })).resolves.toMatchObject({ status: 403 })
    const huge = new Request("http://localhost/_vitehub/rpc/__upload?section=content", { body: new Uint8Array(33 * 1024 * 1024), headers: { "content-type": "multipart/form-data; boundary=x", [consoleRpcHeader]: "1" }, method: "POST" })
    await expect(respond(huge)).resolves.toMatchObject({ body: { code: "MEDIA_TOO_LARGE" }, status: 413 })
    await expect(media("collections")).resolves.toMatchObject({ status: 400 })
    await expect(media("list", { folder: "_vitehub/media" })).resolves.toMatchObject({ body: { value: { items: [] } } })
    await expect(upload({ file: file("a.txt", "a"), folder: "vitehub" })).resolves.toMatchObject({ status: 400 })
  })

  it("rejects paths that traverse above the media store", async () => {
    await expect(media("createFolder", { name: "../outside" })).resolves.toMatchObject({ status: 400 })
    await expect(media("remove", { pathnames: ["../a.txt"] })).resolves.toMatchObject({ status: 400 })
    await expect(upload({ file: file("a.txt", "a"), folder: "posts/../../outside" })).resolves.toMatchObject({ status: 400 })
  })
})
