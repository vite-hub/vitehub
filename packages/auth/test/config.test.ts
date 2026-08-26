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

async function writeAuthSource(rootDir: string, path: string, source: string[]): Promise<string> {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [...source, ""].join("\n"))
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

  it("discovers Auth from an explicit framework server directory", async () => {
    const rootDir = await createTempProject()
    const serverDir = join(rootDir, "backend")
    const file = await writeAuth(rootDir, "backend/auth.ts", [])

    expect(discoverAuthDefinition(join(rootDir, "app"), { serverDirs: [serverDir] })).toEqual({
      handler: file,
      name: "default",
      source: "server-auth",
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
      access: {
        routes: [],
      },
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

  it("resolves static access route middleware config", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  access: {",
      "    routes: [",
      "      '/app',",
      "      '/app/**',",
      "      { authorize: ({ user }) => user.isAdmin === true, method: 'POST', route: '/api/app' },",
      "    ],",
      "  },",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      access: {
        routes: [
          { route: "/app" },
          { route: "/app/**" },
          { authorize: true, method: "POST", route: "/api/app" },
        ],
      },
    })
  })

  it("does not treat an undefined authorize property as a callback", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  access: { routes: [",
      "    { authorize: undefined, route: '/app/**' },",
      "    { authorize: enabled ? authorizeApp : undefined, route: '/admin/**' },",
      "  ] },",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      access: { routes: [{ route: "/app/**" }, { route: "/admin/**" }] },
    })
  })

  it("resolves static middleware config from a callback Auth Definition", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from '@vite-hub/auth'",
      "export default defineAuth(({ env, requestOrigin }) => ({",
      "  access: {",
      "    routes: [",
      "      '/app',",
      "      { method: 'POST', route: '/api/app' },",
      "    ],",
      "  },",
      "  appName: 'ViteHub',",
      "  baseURL: requestOrigin,",
      "  database: createDatabase(env),",
      "  secret: env.auth.secret.unseal(),",
      "}))",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      access: {
        routes: [
          { route: "/app" },
          { method: "POST", route: "/api/app" },
        ],
      },
      database: { mode: "default" },
    })
  })

  it("resolves static middleware config from a block callback Auth Definition", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from '@vite-hub/auth'",
      "export default defineAuth(({ env, requestOrigin }) => {",
      "  const secret = env.auth.secret.unseal()",
      "  return {",
      "    access: { routes: ['/app'] },",
      "    appName: 'ViteHub',",
      "    baseURL: requestOrigin,",
      "    secret,",
      "  }",
      "})",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      access: {
        routes: [
          { route: "/app" },
        ],
      },
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

  it("rejects non-static Auth Definition option keys", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  ...{ basePath: '/auth' },",
    ])

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/options must use static object keys/)

    await rm(join(rootDir, "server", "auth.ts"))
    await writeAuth(rootDir, "server/auth.ts", [
      "  ['basePath']: '/auth',",
    ])

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/options must use static object keys/)
  })

  it("rejects non-inline Auth Definition options", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server", "auth.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineAuth } from '@vite-hub/auth'",
      "const options = { basePath: '/auth' }",
      "export default defineAuth(options)",
      "",
    ].join("\n"))

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/options must be an inline object literal/)
  })

  it("rejects dynamic access route middleware config", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  access: { routes },",
    ])

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/access\.routes must be an inline array/)

    await rm(join(rootDir, "server", "auth.ts"))
    await writeAuth(rootDir, "server/auth.ts", [
      "  access: { routes: [{ route: routePath }] },",
    ])

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/access\.routes\[0\]\.route must be an inline string literal/)
  })

  it("rejects indirect Auth Definition exports instead of reading the first defineAuth call", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server", "auth.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineAuth } from '@vite-hub/auth'",
      "const unused = defineAuth({ appName: 'Unused', basePath: '/unused' })",
      "const exported = defineAuth({ appName: 'Exported', basePath: '/exported' })",
      "export default exported",
      "",
    ].join("\n"))

    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/options must be an inline object literal/)
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
