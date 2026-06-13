import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverAuthDefinition, discoverAuthDefinitions } from "../src/discovery.ts"
import { resolveAuthViteConfig } from "../src/config.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-auth-config-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeAuth(rootDir: string, path: string, body: string[]): Promise<string> {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineAuth } from '@vite-hub/auth'",
    "export default defineAuth({",
    ...body,
    "})",
    "",
  ].join("\n"))
  return file
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("discoverAuthDefinition", () => {
  it("discovers the canonical server auth definition", async () => {
    const rootDir = await createTempProject()
    const file = await writeAuth(rootDir, "server/auth.ts", [])

    expect(discoverAuthDefinition(rootDir)).toEqual({
      handler: file,
      name: "default",
      source: "server-auth",
    })
  })

  it("discovers the server.auth.ts alias", async () => {
    const rootDir = await createTempProject()
    const file = await writeAuth(rootDir, "server.auth.ts", [])

    expect(discoverAuthDefinition(rootDir)).toEqual({
      handler: file,
      name: "default",
      source: "server-auth-suffix",
    })
  })

  it("rejects duplicate Auth Definitions", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [])
    await writeAuth(rootDir, "server.auth.ts", [])

    expect(() => discoverAuthDefinitions(rootDir)).toThrow(/Only one Auth Definition/)
  })
})

describe("resolveAuthViteConfig", () => {
  it("returns undefined when no Auth Definition exists", async () => {
    const rootDir = await createTempProject()

    expect(resolveAuthViteConfig(undefined, rootDir)).toBeUndefined()
  })

  it("resolves the default route and database placement", async () => {
    const rootDir = await createTempProject()
    const file = await writeAuth(rootDir, "server/auth.ts", [
      "  appName: 'ViteHub',",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toEqual({
      basePath: "/api/auth",
      database: { mode: "default" },
      definition: {
        handler: file,
        name: "default",
        source: "server-auth",
      },
      rootDir,
      route: "/api/auth",
      secondaryStorage: false,
    })
  })

  it("resolves named database and KV placement metadata", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server.auth.ts", [
      "  basePath: '/auth',",
      "  database: { name: 'auth', dedicated: true },",
      "  secondaryStorage: { store: 'auth' },",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      basePath: "/auth",
      database: { dedicated: true, mode: "named", name: "auth" },
      route: "/auth",
      secondaryStorage: { mode: "named", store: "auth" },
    })
  })

  it("resolves route opt-out and default secondary storage opt-in", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  database: true,",
      "  route: false,",
      "  secondaryStorage: true,",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      database: { mode: "default" },
      route: false,
      secondaryStorage: { mode: "default" },
    })
  })

  it("rejects dynamic ViteHub-owned config", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  database: authDatabase,",
    ])

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/database must be `true` or an inline object/)
  })

  it("requires names for object-shaped database and secondary storage config", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  database: { dedicated: true },",
    ])

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/database.name is required/)

    await rm(join(rootDir, "server", "auth.ts"))
    await writeAuth(rootDir, "server/auth.ts", [
      "  secondaryStorage: {},",
    ])

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/secondaryStorage.store is required/)
  })
})
