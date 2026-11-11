import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { setBlobRuntimeConfig } from "@vite-hub/blob/runtime/state"
import { build } from "esbuild"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createBlobStorage } from "../../blob/src/storage.ts"
import { consoleState, consoleStateKey } from "../src/console/internal.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleBlob } from "../src/console/runtime/server/blob.ts"
import { installConsoleDocuments } from "../src/console/runtime/server/documents.ts"
import { consoleMediaName } from "../src/console/runtime/server/media.ts"
import { handleConsoleRpcRequest } from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { ConsoleDocumentActions, ConsoleMediaAccess } from "../src/console/runtime/server/documents.ts"
import { requestEvent } from "./console-event.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const policyKey = Symbol.for("vitehub.console.access")
const keys = [consoleStateKey, policyKey]

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
    preview: unused,
    publish: unused,
    raw: unused,
    references,
    remove: unused,
    resolve: unused,
    restore: unused,
    revisions: unused,
    save: unused,
    schedule: unused,
    search: unused,
    session: unused,
    sessions: unused,
    unschedule: unused,
  }
}

function install(sections: readonly string[] = ["content", "blob"]): void {
  installConsoleSections("/app", sections)
  installConsoleDocuments("/app", { content: { actions: () => actions(), load: async () => ({}) } })
  installConsoleBlob("/app", storage)
}

async function respond(request: Request): Promise<{ body: Record<string, unknown>, status: number }> {
  const response = await withConsoleAccess((_event, access) => handleConsoleRpcRequest(request, { access }), { anySection: true })(requestEvent(request))
  return { body: Object(await operationRpcResponseResult(response)), status: response.status }
}

function media(action: string, body: Record<string, unknown> = {}, section = "content") {
  return respond(new Request("http://localhost/_vitehub/rpc", {
    body: operationRpcBody("media.action", { action, body, section }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }))
}

async function upload(fields: { crop?: string, file: File, folder?: string, pathname?: string }, headers: Record<string, string> = {}, section = "content") {
  const { file, ...rest } = fields
  const input = { ...rest, data: Buffer.from(await file.arrayBuffer()).toString("base64"), filename: file.name, section, ...(file.type ? { contentType: file.type } : {}) }
  return respond(new Request("http://localhost/_vitehub/rpc", {
    body: operationRpcBody("media.upload", input),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...headers },
    method: "POST",
  }))
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
  for (const key of keys) Reflect.deleteProperty(globalThis, key)
  setBlobRuntimeConfig(undefined)
  await rm(directory, { force: true, recursive: true })
})

describe("Console media library", () => {
  it("serves Content media operations while navigation shows only Setup", async () => {
    installConsoleSections("/app", ["setup", "content", "blob"], ["setup"])
    const navigation = await respond(new Request("http://localhost/_vitehub/rpc", {
      body: operationRpcBody("sections.list", {}),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }))
    expect(navigation).toMatchObject({ status: 200, body: { ok: true, value: { sections: ["setup"] } } })
    await expect(media("info")).resolves.toMatchObject({ status: 200, body: { ok: true, value: { store: "default", access: roles.editor } } })
  })

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

  it("stores a 32 MiB upload with a 256 MiB heap", async () => {
    const root = resolve(import.meta.dirname, "..")
    const result = await build({
      bundle: true,
      format: "esm",
      packages: "external",
      platform: "node",
      write: false,
      stdin: { resolveDir: root, contents: `
      import assert from "node:assert/strict"
      import { setBlobRuntimeConfig } from "@vite-hub/blob/runtime/state"
      import { createDriver } from "../blob/src/drivers/fs.ts"
      import { createBlobStorage } from "../blob/src/storage.ts"
      import { consoleOperationAccess, installConsoleAccess } from "./src/console/runtime/server/access.ts"
      import { installConsoleBlob } from "./src/console/runtime/server/blob.ts"
      import { installConsoleDocuments } from "./src/console/runtime/server/documents.ts"
      import { maximumConsoleMediaUploadBytes, uploadConsoleMedia } from "./src/console/runtime/server/media.ts"
      import { installConsoleSections } from "./src/console/runtime/server/sections.ts"

      const base = process.argv.at(-1)
      const storage = createBlobStorage(createDriver({ base, driver: "fs" }), "default", { images: false })
      setBlobRuntimeConfig({ images: false, store: { base, driver: "fs" } })
      installConsoleSections(base, ["content", "blob"])
      installConsoleBlob(base, storage)
      installConsoleDocuments(base, { content: { load: async () => ({}), actions: () => ({ mediaAccess: () => ({ manage: true, read: true, write: true }) }) } })
      installConsoleAccess({ mode: "open" })
      const access = await consoleOperationAccess({ access: { mode: "agent", sections: "all" }, surface: "agent" })
      const data = Buffer.alloc(maximumConsoleMediaUploadBytes, 120).toString("base64")
      const result = await uploadConsoleMedia({ data, filename: "valid.bin", contentType: "application/octet-stream", section: "content" }, access)
      assert.equal(result.duplicate, false)
      assert.equal(result.file.size, maximumConsoleMediaUploadBytes)
      const [error, stored] = await storage.get(result.file.pathname)
      assert.equal(error, undefined)
      assert(stored)
      const bytes = new Uint8Array(await stored.arrayBuffer())
      assert.equal(bytes.length, maximumConsoleMediaUploadBytes)
      assert(bytes.every(byte => byte === 120))
      console.log("stored 32 MiB")
      ` },
    })
    const execution = promisify(execFile)(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-", directory], { cwd: root, timeout: 30_000 })
    execution.child.stdin?.end(result.outputFiles[0]!.text)
    const { stdout } = await execution
    expect(stdout.trim()).toBe("stored 32 MiB")
  }, 40_000)

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

  it("rejects media actions and uploads when Blob was not installed", async () => {
    delete consoleState().blob
    const failure = {
      body: { message: "The media library needs Blob. Enable Blob in the ViteHub config." },
      status: 404,
    }
    await expect(media("list")).resolves.toMatchObject(failure)
    await expect(upload({ file: file("a.txt", "a") })).resolves.toMatchObject(failure)
  })

  it("keeps the picker on the served store for an editor with a store grant", async () => {
    const siteDirectory = await mkdtemp(join(tmpdir(), "vitehub-console-media-site-"))
    try {
      const site = createBlobStorage(createDriver({ base: siteDirectory, driver: "fs" }), "media", { images: false, url: pathname => `/media/${pathname}` })
      installConsoleBlob("/app", { ...storage, store: (name: string) => name === "media" ? site : storage }, ["default", "media"])
      setBlobRuntimeConfig({ images: false, serve: { route: "/media", store: "media" }, store: { base: directory, driver: "fs" }, stores: { default: { base: directory, driver: "fs" }, media: { base: siteDirectory, driver: "fs" } } })
      // The policy of an app whose private Content store is `default` and whose Media library is `media`.
      installConsoleAccess({ authorize: () => ({ sections: ["content", "comments", "blob:media"] }), mode: "open" })
      await expect(media("info")).resolves.toMatchObject({ body: { value: { served: "/media/", store: "media" } }, status: 200 })
      await expect(upload({ file: file("Hero.txt", "hero"), folder: "guides" })).resolves.toMatchObject({ body: { value: { file: { pathname: "guides/hero.txt", url: "/media/guides/hero.txt" } } }, status: 200 })
      await expect(media("list", { folder: "guides" })).resolves.toMatchObject({ body: { value: { items: [{ pathname: "guides/hero.txt" }], store: "media" } }, status: 200 })
      expect(await storage.head("guides/hero.txt")).toEqual([undefined, null])
    }
    finally {
      await rm(siteDirectory, { force: true, recursive: true })
    }
  })

  it("rejects cross-site and oversized uploads, and unknown actions", async () => {
    await expect(upload({ file: file("a.txt", "a") }, { origin: "https://evil.example" })).resolves.toMatchObject({ status: 403 })
    // The body limit of `media.upload` holds a 32 MiB file as base64. A larger body stops before the operation runs.
    const huge = new Request("http://localhost/_vitehub/rpc", { body: operationRpcBody("media.upload", { data: "A".repeat(45 * 1024 * 1024) }), headers: { "content-type": "application/json", [consoleRpcHeader]: "1" }, method: "POST" })
    await expect(respond(huge)).resolves.toMatchObject({ body: { code: "CONSOLE_REQUEST_INVALID" }, status: 413 })
    const malformed = new Request("http://localhost/_vitehub/rpc", {
      body: operationRpcBody("media.upload", { data: "not base64", filename: "a.txt", section: "content" }),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    })
    await expect(respond(malformed)).resolves.toMatchObject({ body: { code: "MEDIA_INPUT" }, status: 400 })
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
