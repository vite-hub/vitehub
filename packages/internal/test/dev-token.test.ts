import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

import { createViteHubDevToken, readViteHubDevToken, removeViteHubDevToken, viteHubDevTokenFile } from "../src/dev-token.ts"

describe("private dev tokens", () => {
  it("isolates credentials by project, namespace, and server and removes only the closed server token", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-private-token-test-"))
    const first = await createViteHubDevToken(root, "schedule")
    const secondServerId = globalThis.crypto.randomUUID()
    const second = await createViteHubDevToken(root, "schedule", secondServerId)
    const scope = { namespace: "schedule", serverId: first.serverId }
    try {
      expect(first.token).not.toBe(second.token)
      expect(second.serverId).toBe(secondServerId)
      expect(await readViteHubDevToken(root, scope)).toBe(first.token)
      expect(await readViteHubDevToken(join(root, "other"), scope)).toBeUndefined()
      expect(await readViteHubDevToken(root, { ...scope, namespace: "workspace" })).toBeUndefined()
      expect(await readViteHubDevToken(root, { ...scope, serverId: "other" })).toBeUndefined()
      const file = await viteHubDevTokenFile(root, scope)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)
      await removeViteHubDevToken(root, scope)
      expect(await readViteHubDevToken(root, scope)).toBeUndefined()
      expect(await readViteHubDevToken(root, { ...scope, serverId: second.serverId })).toBe(second.token)
      await removeViteHubDevToken(root, { ...scope, serverId: second.serverId })
      expect(await readViteHubDevToken(root, { ...scope, serverId: second.serverId })).toBeUndefined()
    }
    finally {
      await removeViteHubDevToken(root, scope)
      await removeViteHubDevToken(root, { ...scope, serverId: second.serverId })
      await rm(root, { recursive: true, force: true })
    }
  })

  it("shares one token between registrations of the same server, however they race, until the last one closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-private-token-test-"))
    const scope = { namespace: "workspace-history", serverId: globalThis.crypto.randomUUID() }
    try {
      const [first, second] = await Promise.all([
        createViteHubDevToken(root, scope.namespace, scope.serverId),
        createViteHubDevToken(root, scope.namespace, scope.serverId),
      ])
      const third = await createViteHubDevToken(root, scope.namespace, scope.serverId)
      expect(second).toEqual(first)
      expect(third).toEqual(first)
      expect(await readViteHubDevToken(root, scope)).toBe(first.token)
      await removeViteHubDevToken(root, scope)
      await removeViteHubDevToken(root, scope)
      expect(await readViteHubDevToken(root, scope)).toBe(first.token)
      await removeViteHubDevToken(root, scope)
      expect(await readViteHubDevToken(root, scope)).toBeUndefined()
      const again = await createViteHubDevToken(root, scope.namespace, scope.serverId)
      expect(again.token).not.toBe(first.token)
    }
    finally {
      await removeViteHubDevToken(root, scope)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("never reuses a token file that another process created", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-private-token-test-"))
    const scope = { namespace: "workspace-history", serverId: globalThis.crypto.randomUUID() }
    try {
      const file = await viteHubDevTokenFile(root, scope)
      await mkdir(dirname(file), { mode: 0o700, recursive: true })
      await writeFile(file, "planted\n")
      await expect(createViteHubDevToken(root, scope.namespace, scope.serverId)).rejects.toMatchObject({ code: "EEXIST" })
      expect(await readViteHubDevToken(root, scope)).toBe("planted")
      // A failed creation leaves nothing behind for the next call to join.
      await expect(createViteHubDevToken(root, scope.namespace, scope.serverId)).rejects.toMatchObject({ code: "EEXIST" })
    }
    finally {
      await removeViteHubDevToken(root, scope)
      await rm(root, { recursive: true, force: true })
    }
  })
})
