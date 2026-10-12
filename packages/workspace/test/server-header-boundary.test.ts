import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  refreshWorkspaceDevToken,
  validateWorkspaceDevToken,
  workspaceDevTokenHeader,
} from "../src/server.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("workspace dev token headers", () => {
  it("does not accept a token inherited from the header object prototype", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const token = await refreshWorkspaceDevToken(root, { serverId: "prototype-test" })
    const prototype = { [workspaceDevTokenHeader]: token }
    const headers = Object.create(prototype) as Record<string, string | string[] | undefined>

    await expect(validateWorkspaceDevToken(root, headers, { serverId: "prototype-test" })).resolves.toBe(false)
  })
})
