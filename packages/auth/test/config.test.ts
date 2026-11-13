import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverAuthAbilities, discoverAuthDefinition, discoverAuthDefinitions } from "../src/discovery.ts"
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

describe("discoverAuthAbilities", () => {
  it("finds shared/abilities.ts next to the server directory", async () => {
    const rootDir = await createTempProject()
    const file = await writeAuthSource(rootDir, "shared/abilities.ts", ["export default {}"])

    expect(discoverAuthAbilities(rootDir)).toBe(file)
    // Nuxt passes its server directory. The shared/ folder sits next to it, not in the Vite root (app/).
    expect(discoverAuthAbilities(join(rootDir, "app"), { serverDirs: [join(rootDir, "server")] })).toBe(file)
    expect(resolveAuthViteConfig(undefined, rootDir)).toBeUndefined()
    await writeAuth(rootDir, "server/auth.ts", [])
    expect(resolveAuthViteConfig(undefined, rootDir)?.abilities).toBe(file)
  })

  it("uses a layer's rules when the app has none, and lets the app replace them", async () => {
    const rootDir = await createTempProject()
    const layer = join(rootDir, "layers/base")
    const definition = await writeAuth(layer, "server/auth.ts", [])
    const layerRules = await writeAuthSource(layer, "shared/abilities.mts", ["export default {}"])
    const options = { serverDirs: [join(rootDir, "server"), join(layer, "server")] }

    expect(resolveAuthViteConfig(undefined, rootDir, options)).toMatchObject({ abilities: layerRules, definition: { handler: definition } })
    const appRules = await writeAuthSource(rootDir, "shared/abilities.ts", ["export default {}"])
    expect(resolveAuthViteConfig(undefined, rootDir, options)?.abilities).toBe(appRules)
  })

  it("rejects rules in two layers unless the app replaces them", async () => {
    const rootDir = await createTempProject()
    const layers = ["layers/base", "layers/other"]
    for (const layer of layers) await writeAuthSource(rootDir, `${layer}/shared/abilities.ts`, ["export default {}"])
    const options = { serverDirs: [join(rootDir, "server"), ...layers.map(layer => join(rootDir, layer, "server"))] }

    expect(() => discoverAuthAbilities(rootDir, options)).toThrow(/Only one abilities file/)
    const appRules = await writeAuthSource(rootDir, "shared/abilities.ts", ["export default {}"])
    expect(discoverAuthAbilities(rootDir, options)).toBe(appRules)
  })

  it("finds nothing without the file, and rejects two files", async () => {
    const rootDir = await createTempProject()
    expect(discoverAuthAbilities(rootDir)).toBeUndefined()
    await writeAuth(rootDir, "server/auth.ts", [])
    expect(resolveAuthViteConfig(undefined, rootDir)).not.toHaveProperty("abilities")

    await writeAuthSource(rootDir, "shared/abilities.ts", ["export default {}"])
    await writeAuthSource(rootDir, "shared/abilities.js", ["export default {}"])
    expect(() => discoverAuthAbilities(rootDir)).toThrow(/AUTH_C0060|Only one abilities file/)
  })
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

  it("keeps an explicitly empty server directory list", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [])
    const file = await writeAuth(rootDir, "server.auth.ts", [])

    expect(discoverAuthDefinitions(rootDir, { serverDirs: [] })).toEqual([{
      handler: file,
      name: "default",
      source: "server-auth-suffix",
    }])
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

  it("discovers Auth from a Nuxt layer", async () => {
    const rootDir = await createTempProject()
    const file = await writeAuth(rootDir, "layers/auth/server/auth.ts", [])
    const serverDirs = [join(rootDir, "server"), join(rootDir, "layers/auth/server"), join(rootDir, "layers/blog/server")]

    expect(discoverAuthDefinition(rootDir, { serverDirs })).toEqual({ handler: file, name: "default", source: "server-auth" })
    expect(resolveAuthViteConfig(undefined, rootDir, { serverDirs })?.definition.handler).toBe(file)
  })

  it("lets the application Auth Definition replace a layer Definition", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "layers/auth/server/auth.ts", [])
    const file = await writeAuth(rootDir, "server/auth.ts", [])

    expect(discoverAuthDefinitions(rootDir, { serverDirs: [join(rootDir, "server"), join(rootDir, "layers/auth/server")] })).toEqual([
      { handler: file, name: "default", source: "server-auth" },
    ])
  })

  it("rejects Auth Definitions in two layers until the application defines one", async () => {
    const rootDir = await createTempProject()
    const auth = await writeAuth(rootDir, "layers/auth/server/auth.ts", [])
    const admin = await writeAuth(rootDir, "layers/admin/server/auth.ts", [])
    const serverDirs = [join(rootDir, "server"), join(rootDir, "layers/auth/server"), join(rootDir, "layers/admin/server")]

    expect(() => discoverAuthDefinitions(rootDir, { serverDirs })).toThrow(`More than one Nuxt layer defines one:\n  - ${auth}\n  - ${admin}`)

    const file = await writeAuth(rootDir, "server.auth.ts", [])
    expect(discoverAuthDefinition(rootDir, { serverDirs })?.handler).toBe(file)
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
      definition: {
        handler: file,
        name: "default",
        source: "server-auth",
      },
      rootDir,
      route: "/api/auth",
      tables: false,
    })
  })

  it.each([
    "database: true",
    "database: { name: 'auth', dedicated: true }",
    "database: { dedicated: true }",
    "database: authDatabase",
  ])("rejects a static database that is not authDatabase(): %s", async (option) => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server.auth.ts", [`  ${option},`])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({
      code: "AUTH_C0014",
      fix: expect.stringContaining("authDatabase()"),
    }))
  })

  it.each(["secondaryStorage: true", "secondaryStorage: { store: 'auth' }", "secondaryStorage: kvStorage"])("rejects static secondary storage: %s", async (option) => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server.auth.ts", [`  ${option},`])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_C0017" }))
  })

  it.each([
    ["{ database: { name: 'auth' } }", "AUTH_C0014"],
    ["{ database: true }", "AUTH_C0014"],
    ["{ secondaryStorage: { store: 'auth' } }", "AUTH_C0017"],
  ])("rejects placement returned from a callback: %s", async (options, code) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from '@vite-hub/auth'",
      `export default defineAuth(() => (${options}))`,
    ])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code }))
  })

  it("accepts Better Auth adapters returned from a callback", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from '@vite-hub/auth'",
      "export default defineAuth(({ env }) => ({ database: { dialect: createDialect(env), type: 'sqlite' }, secondaryStorage: createStorage(env) }))",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toBe(false)
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

  it.each(["// Explain the next option", "/* Explain the next option */"])("resolves Auth metadata with %s comments", async (comment) => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      `  ${comment}`,
      "  basePath: '/auth',",
      "  access: {",
      `    ${comment}`,
      "    routes: [",
      `      ${comment}`,
      "      '/public',",
      "      {",
      `        ${comment}`,
      "        route: '/private',",
      `        ${comment}`,
      "        authorize({ user }) { return user.isAdmin },",
      "      },",
      "    ],",
      "  },",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      access: { routes: [{ route: "/public" }, { authorize: true, route: "/private" }] },
      basePath: "/auth",
      route: "/auth",
    })
  })

  it.each(["", "/* removed route */", "// removed route\n"])("rejects sparse route slots containing %s", async (comment) => {
    const rootDir = await createTempProject()
    for (const index of [0, 1, 2]) {
      const routes = ["'/first'", "'/second'"]
      routes.splice(index, 0, comment)
      await writeAuth(rootDir, "server/auth.ts", [`  access: { routes: [${routes.join(",")},] },`])

      expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(`access.routes[${index}]`)
    }
  })

  it.each(["/* trailing comment */", "// trailing comment\n"])("accepts %s after the final route", async (comment) => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [`  access: { routes: ['/first', ${comment}] },`])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access).toEqual({ routes: [{ route: "/first" }] })

    await writeAuth(rootDir, "server/auth.ts", [`  access: { routes: [${comment}] },`])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access).toEqual({ routes: [] })
  })

  it("resolves shorthand authorize callbacks", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  access: { routes: [",
      "    { authorize, route: '/app/**' },",
      "  ] },",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      access: { routes: [{ authorize: true, route: "/app/**" }] },
    })
  })

  it("marks every declared authorize policy for fail-closed runtime enforcement", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  access: { routes: [",
      "    { authorize: undefined, route: '/app/**' },",
      "    { authorize: enabled ? authorizeApp : void 0, route: '/admin/**' },",
      "    { authorize({ user }) { return user.isAdmin }, route: '/method/**' },",
      "    { async authorize({ user }) { return user.isAdmin }, route: '/async-method/**' },",
      "  ] },",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
      access: { routes: [
        { authorize: true, route: "/app/**" },
        { authorize: true, route: "/admin/**" },
        { authorize: true, route: "/method/**" },
        { authorize: true, route: "/async-method/**" },
      ] },
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

  it("resolves route opt-out", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  route: false,",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({ route: false })
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

  it("accepts comments before static Auth Definition options", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [
      "  // Keep the public route stable.",
      "  basePath: '/auth',",
      "  /* Better Auth reads this at runtime. */",
      "  route: false,",
    ])

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({ basePath: "/auth", route: false })
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

  it.each([
    "({ env }) => { if (env.other) return { database: authDatabase('other') }; return { database: authDatabase() } }",
    "({ env }) => { if (env.other) return { database: otherAdapter }; return { database: authDatabase() } }",
    "{ database: authDatabase('schema'), database: otherAdapter }",
    "{ database: authDatabase('schema'), 'database': otherAdapter }",
  ])("rejects ambiguous owned Database placement: %s", async (options) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      `export default defineAuth(${options})`,
    ])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/statically invariant Database/)
  })

  it.each([
    "{ database: authDatabase(), runtime: { database: authDatabase('other') } }",
    "{ advanced: { cookiePrefix: 'acme' }, runtime: () => ({ advanced: { trustedProxyHeaders: true } }) }",
    "() => ({ runtime: { secret: 'secret' } })",
  ])("rejects the removed runtime option at build time: %s", async (options) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      `export default defineAuth(${options})`,
    ])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_C0039" }))
  })

  it("uses the last duplicate database property when it owns the tables", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.js", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      "export default defineAuth({ database: otherAdapter, database: authDatabase('content') })",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toEqual({ database: "content" })
  })

  it.each([
    "{ database: authDatabase(), user: { additionalFields: { plan: { type: 'string' } } } }",
    "() => ({ database: authDatabase(), user: { additionalFields: { plan: { type: 'string' } } } })",
    "{ database: authDatabase(), user: { additionalFields: profileFields } }",
  ])("rejects user fields missing from the owned schema before table discovery: %s", async (options) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      `export default defineAuth(${options})`,
    ])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/user.additionalFields/)
  })

  it.each(["session", "account", "verification"])("rejects %s fields missing from the owned schema before table discovery", async (model) => {
    const rootDir = await createTempProject()
    for (const options of [
      `{ database: authDatabase(), ${model}: { additionalFields: { tenant: { type: 'string' } } } }`,
      `() => ({ database: authDatabase(), ${model}: { additionalFields: extraFields } })`,
    ]) {
      await writeAuthSource(rootDir, "server/auth.ts", [
        "import { defineAuth } from 'vite-hub/auth'",
        "import { authDatabase } from 'vite-hub/auth/database'",
        `export default defineAuth(${options})`,
      ])
      expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(`${model}.additionalFields`)
    }
  })

  it.each(["'serial'", "'uuid'", "false"])("rejects ID strategies incompatible with owned text IDs: %s", async (strategy) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      `export default defineAuth({ database: authDatabase(), advanced: { database: { generateId: ${strategy} } } })`,
    ])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/text IDs/)
  })

  it("finds authDatabase() and the Database that gets the Auth tables", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      "export default defineAuth({ database: authDatabase(), emailAndPassword: { enabled: true } })",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toEqual({ database: "default" })

    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from '@vite-hub/auth'",
      "import { authDatabase as appDatabase } from '@vite-hub/auth/database'",
      "export default defineAuth(({ env }) => ({ database: appDatabase('content'), secret: env.secret }))",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toEqual({ database: "content" })

    // A function with the same name from another module is not the Auth adapter.
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from '@vite-hub/auth'",
      "import { authDatabase } from './database'",
      "export default defineAuth(() => ({ database: authDatabase() }))",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toBe(false)

    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from '@vite-hub/auth'",
      "import { authDatabase } from '@vite-hub/auth/database'",
      "const name = 'content'",
      "export default defineAuth({ database: authDatabase(name) })",
    ])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(/one inline string literal/)
  })
})
