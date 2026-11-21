import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverAuthAbilities, discoverAuthDefinition, discoverAuthDefinitions } from "../src/discovery.ts"
import { resolveAuthViteConfig } from "../src/config.ts"
import { defineAuth } from "../src/definition.ts"
import { checkBuiltAuthPages } from "../src/runtime/server.ts"
import { resolveAuthOptions } from "../src/runtime-options.ts"
import { writeNuxtAuthDefinition } from "../src/vite.ts"

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

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({
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

  it("accepts database: \"memory\" as an explicit memory store", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", ["  database: 'memory',"])
    const config = resolveAuthViteConfig(undefined, rootDir)
    expect(config?.tables).toBe(false)
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

  it("resolves static public routes, and leaves them out when there are none", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", ["  access: { routes: ['/**'], public: ['/', '/login', '/api/auth/**'] },"])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access).toEqual({ routes: [{ route: "/**" }], public: ["/", "/login", "/api/auth/**"] })

    await writeAuth(rootDir, "server/auth.ts", ["  access: { routes: ['/**'], public: [] },"])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access).toEqual({ routes: [{ route: "/**" }] })
  })

  it("resolves the sign-in page or provider, and afterSignIn, for the Nuxt page guard", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", ["  access: { signIn: '/sign-in', afterSignIn: '/dashboard' },"])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access).toEqual({ routes: [], signIn: { page: "/sign-in" }, afterSignIn: "/dashboard" })

    await writeAuth(rootDir, "server/auth.ts", ["  access: { routes: ['/**'], signIn: { provider: 'github', scopes: ['read:org'] } },"])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access).toEqual({ routes: [{ route: "/**" }], signIn: { provider: true } })
  })

  it("resolves access.pages for the Nuxt page guard", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", ["  access: { pages: { '/dashboard/**': 'user', \"/dashboard/pricing\": false, '/login': `guest` } },"])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access).toEqual({ routes: [], pages: { "/dashboard/**": "user", "/dashboard/pricing": false, "/login": "guest" } })
  })

  it.each([
    "pages: pageMap",
    "pages: { ...pageMap }",
    "pages: { [path]: 'user' }",
    "pages: { '/dashboard/**': mode }",
    "pages: { '/dashboard/**': 'admin' }",
    "pages: { '/account/:id?': 'user' }",
    // A spread or a computed key in `access` can hide `pages` from the build.
    "...pageAccess",
    "['pages']: { '/dashboard/**': 'user' }",
  ])("rejects access.%s", async (value) => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [`  access: { ${value} },`])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_PAGE_ROUTES_INVALID" }))
  })

  it.each([
    "defineAuth({ access: sharedAccess })",
    "defineAuth({ access })",
    "defineAuth({ access: makeAccess() })",
    "defineAuth(() => ({ access: sharedAccess }))",
  ])("stops the build when it cannot read access in %s", async (call) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", ["import { defineAuth } from '@vite-hub/auth'", `export default ${call}`])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_PAGE_ROUTES_INVALID" }))
  })

  it.each([
    "defineAuth(({ env }) => { if (env.PREVIEW) return { secret: env.AUTH_SECRET }\n  return { secret: env.AUTH_SECRET, access: { pages: { '/dashboard/**': 'user' } } } })",
    "defineAuth(({ env }) => { if (env.PREVIEW) return { access: sharedAccess }\n  return {} })",
  ])("stops the build when a branch of %s can set access.pages", async (call) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", ["import { defineAuth } from '@vite-hub/auth'", `export default ${call}`])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_PAGE_ROUTES_INVALID" }))
  })

  it.each([
    "defineAuth({ access: undefined })",
    "defineAuth(({ env }) => { if (env.PREVIEW) return { secret: env.AUTH_SECRET }\n  return { secret: env.AUTH_SECRET, access: { routes: ['/api/**'] } } })",
  ])("builds %s without pages", async (call) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", ["import { defineAuth } from '@vite-hub/auth'", `export default ${call}`])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access.pages).toBeUndefined()
  })

  it.each([
    "defineAuth(({ env }) => ({ secret: env.AUTH_SECRET }))",
    "defineAuth(() => ({ access: { signIn: '/login', pages: { '/dashboard/**': 'user' } } as const }))",
  ])("reads the pages of %s", async (call) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", ["import { defineAuth } from '@vite-hub/auth'", `export default ${call}`])
    expect(resolveAuthViteConfig(undefined, rootDir)?.access.pages).toEqual(call.includes("pages") ? { "/dashboard/**": "user" } : undefined)
  })

  it("stops the server when the Definition has access.pages that the build did not read", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [])
    // The server loads the generated Definition module at startup.
    expect(await readFile(await writeNuxtAuthDefinition(rootDir, resolveAuthViteConfig(undefined, rootDir)!), "utf8")).toContain("checkBuiltAuthPages(definition, {})")

    const sharedAccess = { pages: { "/dashboard/**": "user" } } as const
    const invalid = expect.objectContaining({ code: "AUTH_PAGE_ROUTES_INVALID" })
    expect(() => checkBuiltAuthPages(defineAuth({ access: sharedAccess }), {})).toThrow(invalid)
    const callback = defineAuth(() => ({ access: sharedAccess }))
    checkBuiltAuthPages(callback, {})
    expect(() => resolveAuthOptions(callback)).toThrow(invalid)
    expect(() => checkBuiltAuthPages(defineAuth({ access: sharedAccess }), { "/dashboard/**": "user" })).not.toThrow()
  })

  it.each([
    ["signIn: signInPage", "AUTH_C0028"],
    ["signIn: 'login'", "AUTH_C0028"],
    ["signIn: { provider: 'github', callbackURL: '/app' }", "AUTH_SIGN_IN_CALLBACK_URL_MOVED"],
    ["afterSignIn: '//evil.example'", "AUTH_AFTER_SIGN_IN_INVALID"],
  ])("rejects access.%s", async (value, code) => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [`  access: { ${value} },`])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code }))
  })

  it("resolves components.prefix for the Nuxt component names", async () => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", ["  components: { prefix: 'Custom' },"])
    expect(resolveAuthViteConfig(undefined, rootDir)?.components).toEqual({ prefix: "Custom" })

    await writeAuth(rootDir, "server/auth.ts", ["  components: {},"])
    expect(resolveAuthViteConfig(undefined, rootDir)).not.toHaveProperty("components")
  })

  it.each(["prefix", "{ prefix }", "{ prefix: '' }", "{ prefix: ' Custom' }", "{ prefix: 'Custom', global: true }", "{ ...options }"])("rejects components written as %s", async (value) => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [`  components: ${value},`])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_COMPONENTS_INVALID" }))
  })

  it.each(["publicRoutes", "['/', publicRoute]", "['/', ...more]", "['login']", "['/', ,'/x']"])("rejects access.public written as %s", async (value) => {
    const rootDir = await createTempProject()
    await writeAuth(rootDir, "server/auth.ts", [`  access: { routes: ['/**'], public: ${value} },`])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_C0064" }))
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

  it("reads the Definition of an exported const, such as one annotated for a composite TypeScript project", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server", "auth.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { apiKey } from '@better-auth/api-key'",
      "import { defineAuth, type AuthDefinition, type AuthDefinitionResolver } from '@vite-hub/auth'",
      "import { authDatabase } from '@vite-hub/auth/database'",
      "const unused = defineAuth({ appName: 'Unused', basePath: '/unused' })",
      "const auth: AuthDefinition<AuthDefinitionResolver<{ plugins: [ReturnType<typeof apiKey>] }>> = defineAuth(() => ({",
      "  basePath: '/exported',",
      "  database: authDatabase(),",
      "  plugins: [apiKey()],",
      "}))",
      "export default auth",
      "",
    ].join("\n"))

    expect(resolveAuthViteConfig(undefined, rootDir)).toMatchObject({ basePath: "/exported", tables: { database: "default", schema: { plugins: ["apiKey"] } } })
  })

  it.each([
    ["a let", "let auth = defineAuth({ basePath: '/auth' })\nexport default auth"],
    ["a const that holds no defineAuth call", "const auth = makeAuth({ basePath: '/auth' })\nexport default auth"],
  ])("rejects an exported %s", async (_label, body) => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server", "auth.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `import { defineAuth } from '@vite-hub/auth'\n${body}\n`)

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

  it("reads the additional fields and the plugins that add Auth tables", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { apiKey } from '@better-auth/api-key'",
      "import { twoFactor as secondFactor, username } from 'better-auth/plugins'",
      "import type { lastLoginMethod } from 'better-auth/plugins'",
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      "const plugins = [apiKey(), secondFactor()]",
      "export default defineAuth(() => ({",
      "  database: authDatabase(),",
      "  plugins,",
      "  user: { additionalFields: {",
      "    login: { type: 'string', required: false },",
      "    language: { type: ['en', 'es'], required: false, defaultValue: 'en' },",
      "    credits: { type: 'number', required: true, defaultValue: () => 0, input: false },",
      "  } },",
      "  session: { additionalFields: { device: { type: 'string', index: true } } },",
      "}))",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toEqual({
      database: "default",
      schema: {
        plugins: ["apiKey", "twoFactor"],
        additionalFields: {
          user: { login: { type: "string" }, language: { type: "string", defaultValue: "en" }, credits: { type: "number", required: true } },
          session: { device: { type: "string", index: true } },
        },
      },
    })
  })

  it("reads the plugins that a local module of the Definition calls", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "src/server/auth-plugins.ts", [
      "import { stripe } from '@better-auth/stripe'",
      "import { jwt } from 'better-auth/plugins'",
      "export { twoFactorPlugins } from './two-factor'",
      "export function authPlugins(stripeClient) {",
      "  return [jwt(), stripe({ stripeClient, stripeWebhookSecret: '' })]",
      "}",
    ])
    await writeAuthSource(rootDir, "src/server/two-factor.ts", [
      "import { twoFactor } from 'better-auth/plugins'",
      "export const twoFactorPlugins = () => [twoFactor()]",
    ])
    await writeAuthSource(rootDir, "src/server/types.ts", [
      "import { username } from 'better-auth/plugins'",
      "export const unused = () => username()",
    ])
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      "import type { Plan } from '../src/server/types.ts'",
      "import { authPlugins, twoFactorPlugins } from '../src/server/auth-plugins.ts'",
      "export default defineAuth(({ env }) => ({",
      "  database: authDatabase(),",
      "  plugins: [...authPlugins(env.stripe), ...twoFactorPlugins()],",
      "}))",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toEqual({ database: "default", schema: { plugins: ["stripe", "twoFactor"] } })
  })

  it("reads only the exports that the Definition uses, from the files that Vite resolves", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/plugins/index.mjs", [
      "import { twoFactor, username } from 'better-auth/plugins'",
      "import { keys } from '../keys.js'",
      "const secondFactor = () => twoFactor()",
      "export const accountProtection = () => [secondFactor(), ...keys()]",
      "export const loginByUsername = () => [username()]",
    ])
    await writeAuthSource(rootDir, "server/keys.tsx", [
      "import { apiKey } from '@better-auth/api-key'",
      "export const keys = () => [apiKey()]",
    ])
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      "import { accountProtection } from './plugins'",
      "export default defineAuth({ database: authDatabase(), plugins: accountProtection() })",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toEqual({ database: "default", schema: { plugins: ["apiKey", "twoFactor"] } })
  })

  it.each([
    ["{ database: authDatabase(), user: { additionalFields: profileFields } }", /user.additionalFields must be an inline object literal/],
    ["{ database: authDatabase(), user: { additionalFields: { plan: planField } } }", /user.additionalFields.plan must be an inline object/],
    ["{ database: authDatabase(), user: { additionalFields: { plan: { type: planType } } } }", /user.additionalFields.plan.type must be one of/],
    ["{ database: authDatabase(), user: { additionalFields: { plan: { type: 'string', required: isRequired } } } }", /user.additionalFields.plan.required must be/],
    ["() => ({ database: authDatabase(), session: { additionalFields: extraFields } })", /session.additionalFields must be an inline object literal/],
  ])("asks for additional fields that the Vite plugin can read: %s", async (options, message) => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      `export default defineAuth(${options})`,
    ])
    expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_C0055", message: expect.stringMatching(message) }))
  })

  it("rejects a field that a table has with another type, and a renamed column", async () => {
    const rootDir = await createTempProject()
    for (const [fields, message] of [
      ["{ role: { type: 'number' } }", /user.additionalFields declares user.role as number/],
      ["{ login: { type: 'string', fieldName: 'github_login' } }", /fieldName cannot rename the column/],
    ] as const) {
      await writeAuthSource(rootDir, "server/auth.ts", [
        "import { defineAuth } from 'vite-hub/auth'",
        "import { authDatabase } from 'vite-hub/auth/database'",
        `export default defineAuth({ database: authDatabase(), user: { additionalFields: ${fields} } })`,
      ])
      expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_C0056", message: expect.stringMatching(message) }))
    }
  })

  it("keeps additional fields to Better Auth without authDatabase()", async () => {
    const rootDir = await createTempProject()
    await writeAuthSource(rootDir, "server/auth.ts", [
      "import { defineAuth } from 'vite-hub/auth'",
      "export default defineAuth(() => ({ database: adapter, user: { additionalFields: profileFields } }))",
    ])
    expect(resolveAuthViteConfig(undefined, rootDir)?.tables).toBe(false)
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
