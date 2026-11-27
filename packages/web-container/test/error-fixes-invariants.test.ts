import { expect, it } from "vitest"

import { defineConnect } from "../src/connect.ts"
import { webContainerErrorDiagnostics } from "../src/error-diagnostics.ts"
import { toFileSystemTree } from "../src/index.ts"
import { packSnapshot } from "../src/snapshot.ts"

const codes = [
  "WEB_CONTAINER_CONNECT_PROVIDER_UNKNOWN",
  "WEB_CONTAINER_DEV_RUNNING",
  "WEB_CONTAINER_FILE_PATH_INVALID",
  "WEB_CONTAINER_SNAPSHOT_DAMAGED",
  "WEB_CONTAINER_SNAPSHOT_LINKS_FAILED",
  "WEB_CONTAINER_SNAPSHOT_PART_BYTES_INVALID",
  "WEB_CONTAINER_SNAPSHOT_PART_FAILED",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  const create = webContainerErrorDiagnostics[code] as (params: { choices: string, code: number, detail: string, name: string, path: string, reason: "invalid", status: number, url: string }) => Error & { docs?: string, fix?: string }
  const error = create({ choices: "github", code: 1, detail: "m", name: "gitlab", path: "/a", reason: "invalid", status: 404, url: "/parts/0" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/web-container/diagnostics/${code.toLowerCase()}`)
})

it("reports a bad file path of toFileSystemTree() with its code and fix", () => {
  expect(() => toFileSystemTree({ "a": "x", "a/b": "y" })).toThrow(expect.objectContaining({
    code: "WEB_CONTAINER_FILE_PATH_INVALID",
    fix: expect.stringContaining("`files`"),
    message: "WebContainer path a/b goes through the file a.",
  }))
})

it("reports an unknown defineConnect() provider with its code and fix", () => {
  expect(() => defineConnect(JSON.parse("{\"gitlab\":true}"))).toThrow(expect.objectContaining({
    code: "WEB_CONTAINER_CONNECT_PROVIDER_UNKNOWN",
    fix: expect.stringContaining("defineConnect()"),
  }))
})

it("reports a bad packSnapshot() partBytes with its code and fix", () => {
  expect(() => packSnapshot(new Uint8Array([1]), { partBytes: 0 })).toThrow(expect.objectContaining({
    code: "WEB_CONTAINER_SNAPSHOT_PART_BYTES_INVALID",
    fix: expect.stringContaining("`partBytes`"),
  }))
})
