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

  it("accepts an own structural get method on header records", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const options = { serverId: "own-get-test" }
    const token = await refreshWorkspaceDevToken(root, options)
    const headers = { get: (name: string) => name === workspaceDevTokenHeader ? token : null }

    await expect(validateWorkspaceDevToken(root, headers, options)).resolves.toBe(true)
  })

  it("does not call an inherited get method on plain header records", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const options = { serverId: "prototype-get-test" }
    const token = await refreshWorkspaceDevToken(root, options)
    const headers = Object.create({ get: () => token }) as Record<string, string | string[] | undefined>

    await expect(validateWorkspaceDevToken(root, headers, options)).resolves.toBe(false)
  })

  it("rejects throwing header accessors", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const options = { serverId: "throwing-get-test" }
    await refreshWorkspaceDevToken(root, options)
    const headers = Object.defineProperty({}, "get", {
      get() { throw new Error("malformed headers") },
    }) as Record<string, string | string[] | undefined>

    await expect(validateWorkspaceDevToken(root, headers, options)).resolves.toBe(false)
  })

  it("rejects headers whose prototype lookup throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const options = { serverId: "throwing-prototype-test" }
    await refreshWorkspaceDevToken(root, options)
    const headers = new Proxy({}, {
      getPrototypeOf() { throw new Error("malformed headers") },
    }) as Record<string, string | string[] | undefined>

    await expect(validateWorkspaceDevToken(root, headers, options)).resolves.toBe(false)
  })

  it("rejects forged Headers branding on inherited getters", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const options = { serverId: "forged-headers-test" }
    const token = await refreshWorkspaceDevToken(root, options)
    const headers = Object.create({ get: () => token }) as Record<string, string | string[] | undefined>
    Object.defineProperty(headers, Symbol.toStringTag, { value: "Headers" })

    await expect(validateWorkspaceDevToken(root, headers, options)).resolves.toBe(false)
  })

  it("rejects a caller-defined Headers prototype getter", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const options = { serverId: "forged-constructor-test" }
    const token = await refreshWorkspaceDevToken(root, options)
    class Headers {
      get() { return token }
    }
    const headers = Object.create(Headers.prototype) as Record<string, string | string[] | undefined>

    await expect(validateWorkspaceDevToken(root, headers, options)).resolves.toBe(false)
  })

  it("rejects receiver-sensitive inherited Headers getters", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const options = { serverId: "receiver-sensitive-test" }
    const token = await refreshWorkspaceDevToken(root, options)
    let probe: object | undefined
    class Headers {
      constructor() { probe = this }
      get() { return this === probe ? null : token }
    }
    const headers = Object.create(Headers.prototype) as Record<string, string | string[] | undefined>

    await expect(validateWorkspaceDevToken(root, headers, options)).resolves.toBe(false)
  })

  it("accepts own record tokens and case-insensitive Headers tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-header-"))
    roots.push(root)
    const options = { serverId: "own-header-test" }
    const token = await refreshWorkspaceDevToken(root, options)
    const record = Object.assign(Object.create(null), { [workspaceDevTokenHeader]: token })
    const headers = new Headers({ [workspaceDevTokenHeader.toUpperCase()]: token })

    await expect(validateWorkspaceDevToken(root, record, options)).resolves.toBe(true)
    await expect(validateWorkspaceDevToken(root, headers, options)).resolves.toBe(true)
  })
})
