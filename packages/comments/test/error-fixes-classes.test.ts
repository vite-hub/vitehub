import { expect, it } from "vitest"

import { createCommentsRestRequest } from "../src/rest-transport.ts"
import { commentsErrorDiagnostics } from "../src/operations-core/errors.ts"
import { createRpcTransport } from "../src/operations-core/rpc.ts"

/** The codes that replaced the Comments error classes. */
const codes = ["COMMENTS_GITHUB_CREDENTIALS_MISSING", "COMMENTS_GITHUB_SYNC_FAILED", "COMMENTS_R0013"] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  const create = commentsErrorDiagnostics[code] as (params: { reason: string, request: string, status: number }) => Error & { docs?: string, fix?: string }
  const error = create({ reason: "Bad credentials", request: "GET /repos", status: 401 })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/comments/diagnostics/${code.toLowerCase()}`)
})

it("throws the code, fix, and status of a REST answer, and COMMENTS_R0013 when no server answers", async () => {
  const answered = createCommentsRestRequest({ fetch: async () => Response.json({ error: { code: "COMMENTS_R0004", fix: "Sign in as the author.", why: "Only the author can edit it." } }, { status: 403 }) })
  await expect(answered("/threads")).rejects.toMatchObject({ code: "COMMENTS_R0004", fix: "Sign in as the author.", message: "Only the author can edit it.", status: 403 })
  const offline = createCommentsRestRequest({ fetch: async () => { throw new TypeError("Failed to fetch") } })
  await expect(offline("/threads")).rejects.toMatchObject({ cause: expect.objectContaining({ message: "Failed to fetch" }), code: "COMMENTS_R0013", fix: expect.stringContaining("connection"), status: 0 })
})

it("throws COMMENTS_R0013 from the RPC transport when no server answers", async () => {
  const transport = createRpcTransport({ fetch: async () => { throw new TypeError("Failed to fetch") } })
  await expect(transport.list({})).rejects.toMatchObject({ code: "COMMENTS_R0013", status: 0 })
})
