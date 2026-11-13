import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"
import { afterEach, describe, expect, it } from "vitest"
import { createServer, mergeConfig, optimizeDeps, resolveConfig } from "vite"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { AUTH_ABILITIES_ID, AUTH_CLIENT_ID, AUTH_DEFINITION_ID, AUTH_SERVER_ID, createAuthNitroConfig, hubAuth } from "../src/vite.ts"

const tempDirs: string[] = []
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

async function createTempProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-auth-vite-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeAuth(rootDir: string, path = "server/auth.ts", body: string[] = ["  appName: 'ViteHub',"]): Promise<string> {
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

async function resolvePluginConfig(plugin: ReturnType<typeof hubAuth>, root: string, plugins: Array<{ name: string }> = []): Promise<void> {
  await (plugin.configResolved as unknown as (config: { plugins: Array<{ name: string }>; root: string }) => Promise<void>)({ plugins, root })
}

function resolveAuthModule(plugin: ReturnType<typeof hubAuth>, id: string): string | undefined {
  return (plugin.resolveId as { handler: (id: string) => string | undefined }).handler(id)
}

function resolveAuthDefinition(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.resolveId as { handler: (id: string) => string | undefined }).handler(AUTH_DEFINITION_ID)
}

function resolveAuthServer(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.resolveId as { handler: (id: string) => string | undefined }).handler(AUTH_SERVER_ID)
}

function loadAuthDefinition(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.load as { handler: (id: string) => string | undefined }).handler(`\0${AUTH_DEFINITION_ID}`)
}

function loadAuthServer(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.load as { handler: (id: string) => string | undefined }).handler(`\0${AUTH_SERVER_ID}`)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubAuth", () => {
  it("preserves app rules when a non-linked Auth package is dependency-optimized", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    await mkdir(join(root, "shared"))
    await writeFile(join(root, "shared/abilities.ts"), 'export default { "app.rule": Object.assign(() => true, { guest: true }) }\n')
    await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>')
    await writeFile(join(root, "main.js"), 'import { Can, useAbility } from "@vite-hub/auth/vue"; console.log(Can, useAbility)')
    const installed = join(root, "node_modules/@vite-hub/auth")
    await mkdir(installed, { recursive: true })
    await cp(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true })
    await cp(join(packageRoot, "package.json"), join(installed, "package.json"))
    for (const dependency of ["vue", "better-auth", "nostics"]) {
      await symlink(await realpath(join(packageRoot, "node_modules", dependency)), join(root, "node_modules", dependency), "dir")
    }
    const server = await createServer({ root, configFile: false, logLevel: "silent", plugins: [hubAuth()], server: { watch: null } })
    try {
      const metadata = await optimizeDeps(server.config, true)
      expect(metadata.optimized).not.toHaveProperty("@vite-hub/auth/vue")
      expect(Object.keys(metadata.optimized).some(id => id.includes("better-auth/vue"))).toBe(true)
      const entry = await server.transformRequest("/main.js")
      expect(entry?.code).toContain("/node_modules/@vite-hub/auth/dist/vue.js")
      const vue = await server.transformRequest("/node_modules/@vite-hub/auth/dist/vue.js")
      expect(vue?.code).toContain("/@id/__x00__#vitehub/auth/abilities")
      const rules = await server.transformRequest("\0#vitehub/auth/abilities")
      expect(rules?.code).toContain("/shared/abilities.ts")
      expect((await server.ssrLoadModule(AUTH_ABILITIES_ID)).default["app.rule"](null)).toBe(true)
    }
    finally {
      await server.close()
    }
  }, 30_000)

  it("filters resolveId and load to the Auth virtual modules", () => {
    const plugin = hubAuth()
    const resolveFilter = (plugin.resolveId as { filter: { id: RegExp } }).filter.id
    const loadFilter = (plugin.load as { filter: { id: RegExp } }).filter.id

    expect([AUTH_ABILITIES_ID, AUTH_CLIENT_ID, AUTH_DEFINITION_ID, AUTH_SERVER_ID, "#vitehub/auth/other", "/app/server/auth.ts"].map(id => resolveFilter.test(id))).toEqual([true, true, true, true, false, false])
    expect([`\0${AUTH_ABILITIES_ID}`, `\0${AUTH_CLIENT_ID}`, `\0${AUTH_DEFINITION_ID}`, `\0${AUTH_SERVER_ID}`, AUTH_SERVER_ID, "/app/server/auth.ts"].map(id => loadFilter.test(id))).toEqual([true, true, true, true, false, false])
  })

  it("serves a stable virtual Auth Definition module", async () => {
    const root = await createTempProject()
    const definition = await writeAuth(root)

    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)

    expect(resolveAuthDefinition(plugin)).toBe(`\0${AUTH_DEFINITION_ID}`)
    expect(loadAuthDefinition(plugin)).toContain(`import definition from ${JSON.stringify(definition)}`)
  })

  it("serves an empty virtual module when no Auth Definition exists", async () => {
    const root = await createTempProject()
    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)

    expect(loadAuthDefinition(plugin)).toBe("export const definition = undefined\nexport default definition\n")
  })

  it("serves a stable virtual Auth server helper module", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)

    expect(resolveAuthServer(plugin)).toBe(`\0${AUTH_SERVER_ID}`)
    expect(loadAuthServer(plugin)).toContain(`export * from "@vite-hub/auth/server"`)
    expect(loadAuthServer(plugin)).toContain(`export { default } from "@vite-hub/auth/server"`)
    await expect(readFile(join(root, ".vitehub", "types", "auth-server.d.ts"), "utf8")).resolves.toContain("declare module \"#vitehub/auth/server\"")
  })

  it("serves shared/abilities.ts to the server and the app, and registers its type", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    const abilities = join(root, "shared", "abilities.ts")
    await mkdir(dirname(abilities), { recursive: true })
    await writeFile(abilities, "export default {}\n")

    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)
    const resolveId = (plugin.resolveId as { handler: (id: string) => string | undefined }).handler
    const load = (plugin.load as { handler: (id: string) => string | undefined }).handler

    expect(resolveId(AUTH_ABILITIES_ID)).toBe(`\0${AUTH_ABILITIES_ID}`)
    expect(load(`\0${AUTH_ABILITIES_ID}`)).toBe(`export { default } from ${JSON.stringify(abilities)}\n`)
    const ambientTypes = await readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")
    expect(ambientTypes).toContain("interface AuthRegistry { definition: typeof import(\"../../server/auth.js\").default; abilities: typeof import(\"../../shared/abilities.js\").default }")
  })

  it.each(["shared/abilities.ts", "shared/abilities.mts", "layers/base/shared/abilities.ts"])("reloads added and removed rules from %s in dev", async (path) => {
    const root = await createTempProject()
    await writeAuth(root)
    const abilities = join(root, path)
    await mkdir(dirname(abilities), { recursive: true })
    const plugin = hubAuth()
    const discovery = { [VITEHUB_SERVER_DIRS]: [join(root, "server"), join(root, "layers/base/server")] }
    const server = await createServer({
      ...discovery,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin],
      root,
      // Deliver notifications directly so watcher startup does not affect this regression test.
      server: { watch: null },
    })
    try {
      expect((await server.ssrLoadModule(AUTH_ABILITIES_ID)).default).toEqual({})
      const snapshot = async () => ({
        rules: Object.keys((await server.ssrLoadModule(AUTH_ABILITIES_ID)).default),
        typed: (await readFile(join(root, ".vitehub/types/auth.d.ts"), "utf8")).includes("; abilities:"),
      })

      await writeFile(abilities, 'export default { "posts.edit": () => true }\n')
      server.watcher.emit("add", abilities)
      await expect.poll(snapshot, { timeout: 5000 }).toEqual({ rules: ["posts.edit"], typed: true })
      expect(plugin.api.getConfig()?.abilities).toBe(abilities)

      await rm(abilities)
      server.watcher.emit("unlink", abilities)
      await expect.poll(snapshot, { timeout: 5000 }).toEqual({ rules: [], typed: false })
      expect(plugin.api.getConfig()?.abilities).toBeUndefined()
    }
    finally {
      await server.close()
    }
  }, 15_000)

  it("serves no rules without shared/abilities.ts or without an Auth Definition", async () => {
    const withoutRules = await createTempProject()
    await writeAuth(withoutRules)
    const plugin = hubAuth()
    await resolvePluginConfig(plugin, withoutRules)
    expect((plugin.load as { handler: (id: string) => string | undefined }).handler(`\0${AUTH_ABILITIES_ID}`)).toBe("export default {}\n")

    const withoutAuth = await createTempProject()
    await mkdir(join(withoutAuth, "shared"), { recursive: true })
    await writeFile(join(withoutAuth, "shared", "abilities.ts"), "export default {}\n")
    const unused = hubAuth()
    await resolvePluginConfig(unused, withoutAuth)
    expect((unused.load as { handler: (id: string) => string | undefined }).handler(`\0${AUTH_ABILITIES_ID}`)).toBe("export default {}\n")
  })

  it("writes generated files at the project root when Vite runs from app/", async () => {
    const root = await createTempProject()
    await mkdir(join(root, "app"))
    await writeFile(join(root, "package.json"), "{}")
    await writeAuth(root)

    const plugin = hubAuth()
    await resolvePluginConfig(plugin, join(root, "app"))

    await expect(readFile(join(root, ".vitehub", "types", "auth-server.d.ts"), "utf8")).resolves.toContain("declare module \"#vitehub/auth/server\"")
    await expect(readFile(join(root, ".vitehub", "auth", "route.ts"), "utf8")).resolves.toContain("#vitehub/auth/server")
    await expect(readFile(join(root, "app", ".vitehub", "auth", "route.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["server/auth.ts", "server.auth.ts"])("discovers app/%s while generating project-root handlers", async (path) => {
    const root = await createTempProject()
    const appRoot = join(root, "app")
    await writeFile(join(root, "package.json"), "{}")
    const definition = await writeAuth(appRoot, path, ["  access: { routes: ['/private/**'] },"])
    const plugin = hubAuth()
    const config = await resolveConfig({ configFile: false, plugins: [plugin], root: appRoot }, "serve")

    expect(loadAuthDefinition(plugin)).toContain(JSON.stringify(definition))
    expect(plugin.api.refresh()?.definition.handler).toBe(definition)
    expect(config).toMatchObject({
      nitro: { handlers: expect.arrayContaining([
        { handler: join(root, ".vitehub/auth/route.ts"), lazy: true, route: "/api/auth/**" },
        { handler: join(root, ".vitehub/auth/access-middleware.ts"), middleware: true, route: "/**" },
      ]) },
    })
    await expect(readFile(join(root, ".vitehub/auth/access-middleware.ts"), "utf8")).resolves.toContain("/private/**")
    await expect(readFile(join(appRoot, ".vitehub/auth/route.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("uses a configured package base in generated Auth runtime and type imports", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth(undefined, { importBase: "vite-hub/auth" })
    await resolvePluginConfig(plugin, root, [{ name: "@vite-hub/env/vite" }])

    expect(loadAuthServer(plugin)).toContain("from \"vite-hub/auth/server\"")
    expect(loadAuthServer(plugin)).not.toContain("@vite-hub/auth")
    const ambientTypes = await readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")
    const serverTypes = await readFile(join(root, ".vitehub", "types", "auth-server.d.ts"), "utf8")
    expect(ambientTypes).toContain("namespace ViteHub")
    expect(ambientTypes + serverTypes).not.toContain("@vite-hub/auth")
    expect(serverTypes).toContain("from \"vite-hub/auth/server\"")
    expect(serverTypes).not.toContain("from \"@vite-hub/auth/server\"")
  })

  it("registers the Auth Definition type in the generated declarations", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    await resolvePluginConfig(hubAuth(), root)

    const ambientTypes = await readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")
    expect(ambientTypes).toContain("interface AuthRegistry { definition: typeof import(\"../../server/auth.js\").default }")
  })

  it("types useAuth(event).api with the plugins of server/auth.ts through the generated declarations", async () => {
    // Inside the package, so `better-auth/plugins` resolves for the app's Auth Definition.
    await mkdir(join(packageRoot, ".vitest-tmp"), { recursive: true })
    const root = await mkdtemp(join(packageRoot, ".vitest-tmp", "use-auth-"))
    tempDirs.push(root)
    // The project root of the generated declarations is the nearest package.json.
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }))
    await writeAuth(root, "server/auth.ts", ["  appName: 'ViteHub',", "  plugins: [admin(), organization()],"])
    const definitionFile = join(root, "server/auth.ts")
    await writeFile(definitionFile, `import { admin, organization } from 'better-auth/plugins'\n${await readFile(definitionFile, "utf8")}`)
    await writeFile(join(root, "server/route.ts"), [
      "import { useAuth } from '@vite-hub/auth/server'",
      "import type { H3Event } from 'h3'",
      "export async function handler(event: H3Event) {",
      "  const auth = useAuth(event)",
      "  await auth.api.banUser({ body: { userId: 'user-1' }, headers: event.req.headers })",
      "  await auth.api.createOrganization({ body: { name: 'Acme', slug: 'acme' }, headers: event.req.headers })",
      "  // @ts-expect-error The Definition has no such plugin endpoint.",
      "  void auth.api.notAnEndpoint",
      "}",
      "",
    ].join("\n"))

    const diagnosticsFor = (files: string[]) => {
      const { config } = ts.readConfigFile(join(packageRoot, "tsconfig.json"), ts.sys.readFile)
      const { options } = ts.parseJsonConfigFileContent(config, ts.sys, packageRoot)
      options.paths = { ...options.paths, "@vite-hub/auth": [join(packageRoot, "src/index.ts")] }
      const program = ts.createProgram(files, { ...options, noEmit: true, rootDir: undefined, skipLibCheck: true })
      return ts.getPreEmitDiagnostics(program)
        .filter(diagnostic => diagnostic.file?.fileName.startsWith(root))
        .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    }

    // Without the generated registry, the instance has no plugin endpoints.
    expect(diagnosticsFor([join(root, "server/route.ts")]).join("\n")).toMatch(/banUser/)

    await resolvePluginConfig(hubAuth(), root)
    expect(diagnosticsFor([join(root, ".vitehub/types/auth.d.ts"), join(root, "server/route.ts")])).toEqual([])
  }, 120_000)

  it("serves the app's auth.client.ts as the default client's options and registers its type", async () => {
    const root = await createTempProject()
    const appRoot = join(root, "app")
    await writeFile(join(root, "package.json"), "{}")
    await writeAuth(root)
    const client = join(appRoot, "auth.client.ts")
    await mkdir(appRoot)
    await writeFile(client, "import { defineAuthClient } from '@vite-hub/auth/vue'\nexport default defineAuthClient({ plugins: [] })\n")

    const plugin = hubAuth()
    // Nuxt runs Vite from `app/`.
    await resolvePluginConfig(plugin, appRoot)

    expect(resolveAuthModule(plugin, AUTH_CLIENT_ID)).toBe(client)
    const ambientTypes = await readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")
    expect(ambientTypes).toContain("interface AuthRegistry { definition: typeof import(\"../../server/auth.js\").default; client: typeof import(\"../../app/auth.client.js\").default }")
  })

  it("keeps the Vue client out of dependency prebundling when the app has auth.client.ts", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    const config = (plugin: ReturnType<typeof hubAuth>) => (plugin.config as (config: { root: string }) => { optimizeDeps?: unknown })({ root })

    await writeFile(join(root, "auth.client.ts"), "export default {}\n")
    // Vite prebundles without the plugin's resolveId, so `#vitehub/auth/client` would load the empty fallback in dev.
    // Vite excludes the subpaths of an excluded package, such as `vite-hub/auth/vue`.
    expect(config(hubAuth()).optimizeDeps).toEqual({ exclude: ["@vite-hub/auth", "vite-hub/auth"], include: ["@vite-hub/auth > better-auth/vue"] })
  })

  it.each([[{}], [false] as const])("serves no client options without auth.client.ts or with Auth %j", async (options) => {
    const root = await createTempProject()
    await writeAuth(root)
    if (options === false) await writeFile(join(root, "auth.client.ts"), "export default {}\n")

    const plugin = hubAuth(options)
    await resolvePluginConfig(plugin, root)

    expect(resolveAuthModule(plugin, AUTH_CLIENT_ID)).toBe(`\0${AUTH_CLIENT_ID}`)
    expect((plugin.load as { handler: (id: string) => string | undefined }).handler(`\0${AUTH_CLIENT_ID}`)).toBe("export default undefined\n")
    await expect(readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")).resolves.not.toContain("client:")
  })

  it("connects the virtual Auth Definition to ViteHub Env when available", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root, [{ name: "@vite-hub/env/vite" }])

    // The definition module sets the resolver, so code that imports `@vite-hub/auth/server` before the lazy Auth route gets it.
    expect(loadAuthDefinition(plugin)).toContain("setAuthRuntimeEnvResolver(useServerEnv, definition)")
    expect(loadAuthDefinition(plugin)).toContain("from \"@vite-hub/auth/runtime/server\"")
    expect(loadAuthDefinition(plugin)).toContain("from \"#vitehub/env/server\"")
    expect(loadAuthServer(plugin)).not.toContain("setAuthRuntimeEnvResolver")
    const ambientTypes = await readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")
    expect(ambientTypes).toContain("import type { ServerEnv } from \"#vitehub/env/server\"")
    expect(ambientTypes).toContain("interface AuthRuntimeEnv extends ServerEnv")
  })

  it("declares #vitehub/auth/server for a tsconfig that cannot resolve it", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    await mkdir(join(root, "node_modules/@vite-hub/auth"), { recursive: true })
    await writeFile(join(root, "node_modules/@vite-hub/auth/package.json"), JSON.stringify({ name: "@vite-hub/auth", exports: { ".": { types: "./index.d.ts" }, "./server": { types: "./server.d.ts" } } }))
    await writeFile(join(root, "node_modules/@vite-hub/auth/index.d.ts"), "export declare function defineAuth<T>(options: T): T\n")
    await writeFile(join(root, "node_modules/@vite-hub/auth/server.d.ts"), "export declare const marker: \"ok\"\ndeclare const authRoute: { fetch(request: Request): Promise<Response> }\nexport default authRoute\n")
    await mkdir(join(root, ".vitehub/env"), { recursive: true })
    await writeFile(join(root, ".vitehub/env/server.d.ts"), "export interface ServerEnv {}\n")

    // The Env integration makes the generated Auth types a module, the case that a plain declaration cannot cover.
    await resolvePluginConfig(hubAuth(), root, [{ name: "@vite-hub/env/vite" }])
    await writeFile(join(root, ".vitehub/types.d.ts"), '/// <reference path="./types/auth.d.ts" />\n/// <reference path="./types/auth-server.d.ts" />\n\nexport {}\n')
    await writeFile(join(root, "probe.ts"), 'import { marker } from "#vitehub/auth/server"\nexport const value: "ok" = marker\n')

    const program = ts.createProgram([join(root, ".vitehub/types.d.ts"), join(root, ".vitehub/auth/route.ts"), join(root, "probe.ts")], {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    expect(diagnostics).toEqual([])
  })

  it("disables the auth plugin with false", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth(false)
    await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root })

    expect(plugin.api.getConfig()).toBeUndefined()
    expect(loadAuthDefinition(plugin)).toBe("export const definition = undefined\nexport default definition\n")
  })

  it("marks the auth package as noExternal for Vite SSR module loading", () => {
    const plugin = hubAuth()
    const config = plugin.config as (config: { server?: { watch?: { ignored?: string[] } }, ssr?: { noExternal?: string[] } }) => unknown

    expect(config({})).toEqual({
      define: { __VITEHUB_AUTH_DEV__: "false" },
      optimizeDeps: {
        exclude: ["@vite-hub/auth", "vite-hub/auth"],
        include: ["@vite-hub/auth > better-auth/vue"],
      },
      server: {
        watch: {
          ignored: ["**/.vitehub/**"],
        },
      },
      ssr: {
        noExternal: ["@vite-hub/auth"],
      },
    })
    expect(config({ server: { watch: { ignored: ["**/.vitehub/**"] } }, ssr: { noExternal: ["existing", "@vite-hub/auth"] } })).toEqual({
      define: { __VITEHUB_AUTH_DEV__: "false" },
      optimizeDeps: {
        exclude: ["@vite-hub/auth", "vite-hub/auth"],
        include: ["@vite-hub/auth > better-auth/vue"],
      },
      server: {
        watch: {
          ignored: undefined,
        },
      },
      ssr: {
        noExternal: undefined,
      },
    })
  })

  it("keeps configured entries single after Vite resolves the Auth config", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    const middleware = { handler: "/app/middleware.ts", middleware: true, route: "/**" }

    const inlineConfig = {
      configFile: false as const,
      logLevel: "silent" as const,
      nitro: {
        cloudflare: { wrangler: { secrets: { required: ["VITEHUB_TOKEN"] } } },
        handlers: [middleware],
        plugins: ["/app/plugin.ts"],
      },
      plugins: [hubAuth()],
      root,
      server: { watch: { ignored: ["**/dist/**"] } },
      ssr: { noExternal: ["existing"] },
    }

    const resolved = await resolveConfig(inlineConfig, "build")
    // SAFETY: Vite keeps the open `nitro` key of the inline config on its resolved config.
    const nitro = (resolved as typeof resolved & { nitro: { cloudflare: { wrangler: { secrets: { required: string[] } } }, handlers: unknown[], plugins: string[] } }).nitro

    expect(nitro.cloudflare.wrangler.secrets.required).toEqual(["VITEHUB_TOKEN"])
    expect(nitro.plugins).toEqual(["/app/plugin.ts"])
    expect(createAuthNitroConfig(hubAuth(), { nitro: inlineConfig.nitro, projectRoot: root })).toEqual(nitro)
    expect(nitro.handlers).toEqual([middleware, { handler: resolve(root, ".vitehub/auth/route.ts"), lazy: true, route: "/api/auth/**" }])
    expect(resolved.server.watch?.ignored).toEqual(["**/dist/**", "**/.vitehub/**"])
    expect(resolved.ssr.noExternal).toEqual(["existing", "@vite-hub/auth"])
    expect(resolved.environments.ssr?.resolve.noExternal).toEqual(["existing", "@vite-hub/auth"])
  })

  it("composes the Nuxt Nitro helper without duplicating existing arrays or mutating its input", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    const middleware = { handler: "/app/middleware.ts", middleware: true, route: "/**" }
    const nitro = { handlers: [middleware], plugins: ["/app/plugin.ts"] }
    const composed = createAuthNitroConfig(hubAuth(), { nitro, projectRoot: root })
    expect(composed).toMatchObject({ handlers: [middleware, { handler: resolve(root, ".vitehub/auth/route.ts"), route: "/api/auth/**" }], plugins: ["/app/plugin.ts"] })
    expect(nitro).toEqual({ handlers: [middleware], plugins: ["/app/plugin.ts"] })
    const repeated = createAuthNitroConfig(hubAuth(), { nitro: composed, projectRoot: root })
    expect(repeated).toEqual(composed)
  })


  it("registers the discovered Auth route with Nitro", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    const plugin = hubAuth()
    const config = (input: { root: string }) => mergeConfig(input, (plugin.config as (config: { root: string }) => Record<string, unknown>)(input))

    expect(config({ root })).toMatchObject({
      nitro: {
        handlers: [{
          handler: resolve(root, ".vitehub/auth/route.ts"),
          route: "/api/auth/**",
        }],
      },
    })
  })

  it("registers configured access routes as Nitro middleware", async () => {
    const root = await createTempProject()
    await writeAuth(root, "server/auth.ts", [
      "  appName: 'ViteHub',",
      "  access: {",
      "    routes: [",
      "      '/app',",
      "      '/app/**',",
      "      { authorize: ({ user }) => user.isAdmin === true, method: 'POST', route: '/api/app' },",
      "    ],",
      "  },",
    ])
    const plugin = hubAuth()
    const config = (input: { root: string }) => mergeConfig(input, (plugin.config as (config: { root: string }) => Record<string, unknown>)(input))

    expect(config({ root })).toMatchObject({
      nitro: {
        handlers: [
          {
            handler: resolve(root, ".vitehub/auth/route.ts"),
            lazy: true,
            route: "/api/auth/**",
          },
          {
            handler: resolve(root, ".vitehub/auth/access-middleware.ts"),
            middleware: true,
            route: "/**",
          },
        ],
      },
    })

    await resolvePluginConfig(plugin, root)
    const middleware = await readFile(join(root, ".vitehub", "auth", "access-middleware.ts"), "utf8")
    expect(middleware).toContain('export default createLazyAuthAccessHandler([{"route":"/app"},{"route":"/app/**"},{"route":"/api/app","authorize":true,"method":"POST"}], () => import("#vitehub/auth/server"))')
  })

  it("uses custom Auth base paths for generated Nitro routes", async () => {
    const root = await createTempProject()
    await writeAuth(root, "server/auth.ts", [
      "  appName: 'ViteHub',",
      "  basePath: '/auth',",
    ])
    const plugin = hubAuth()
    const config = (input: { root: string }) => mergeConfig(input, (plugin.config as (config: { root: string }) => Record<string, unknown>)(input))

    expect(config({ root })).toMatchObject({
      nitro: {
        handlers: [{
          handler: resolve(root, ".vitehub/auth/route.ts"),
          lazy: true,
          route: "/auth/**",
        }],
      },
    })
  })

  it("keeps route opt-out for hosts that mount Auth themselves", async () => {
    const root = await createTempProject()
    await writeAuth(root, "server/auth.ts", [
      "  appName: 'ViteHub',",
      "  route: false,",
    ])
    const plugin = hubAuth()
    const config = plugin.config as (config: { root: string }) => { nitro?: unknown }

    expect(config({ root }).nitro).toBeUndefined()
  })

  it("writes the generated Nitro Auth route handler", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    const plugin = hubAuth()

    await resolvePluginConfig(plugin, root)

    await expect(readFile(join(root, ".vitehub", "auth", "route.ts"), "utf8")).resolves.toContain("export { default } from \"#vitehub/auth/server\"")
    const accessMiddleware = await readFile(join(root, ".vitehub", "auth", "access-middleware.ts"), "utf8")
    expect(accessMiddleware).toBe([
      'import { createLazyAuthAccessHandler } from "@vite-hub/auth/runtime/server"',
      "",
      'export default createLazyAuthAccessHandler([], () => import("#vitehub/auth/server"))',
      "",
    ].join("\n"))
  })

  it("invalidates the virtual definition module during auth definition hot updates", async () => {
    const root = await createTempProject()
    const definition = await writeAuth(root)
    const invalidated: string[] = []
    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        config: { root: string }
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>

    await handleHotUpdate({
      file: definition,
      server: {
        config: { root },
        moduleGraph: {
          getModuleById(id) {
            if (id === `\0${AUTH_DEFINITION_ID}`) return { id }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual([`\0${AUTH_DEFINITION_ID}`])
  })
})

describe("Auth tables in the app Database", () => {
  async function writeAuthDatabase(root: string, call: string) {
    const file = join(root, "server", "auth.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineAuth } from 'vite-hub/auth'",
      "import { authDatabase } from 'vite-hub/auth/database'",
      `export default defineAuth({ database: ${call}, emailAndPassword: { enabled: true } })`,
      "",
    ].join("\n"))
  }

  async function contributions(root: string, plugin = hubAuth(undefined, { importBase: "vite-hub/auth" })) {
    const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
    return await collectDatabaseContributions([plugin], { projectRoot: root, root, rootDir: root })
  }

  it("adds the Better Auth tables to the implicit default Database", async () => {
    const root = await createTempProject()
    await writeAuthDatabase(root, "authDatabase()")
    const { tables } = await contributions(root)
    expect(tables).toMatchObject([{
      database: "default",
      definition: { export: "authSqliteSchema", module: "vite-hub/auth/schema" },
      dialect: "sqlite",
      name: "auth",
      plugin: "@vite-hub/auth/vite",
    }])
    const { discoverDatabaseDefinitions } = await import("@vite-hub/database/config")
    expect(discoverDatabaseDefinitions(root, { contributions: { tables } }).map(definition => definition.name)).toEqual(["default"])
  })

  it("uses the Postgres tables for a Postgres Database", async () => {
    const root = await createTempProject()
    await writeAuthDatabase(root, "authDatabase('accounts')")
    await mkdir(join(root, "server", "databases", "accounts"), { recursive: true })
    await writeFile(join(root, "server", "databases", "accounts", "index.ts"), "import { defineDatabase } from '@vite-hub/database'\nexport default defineDatabase({ name: 'accounts', dialect: 'postgresql', schema: {} })\n")
    expect((await contributions(root)).tables).toMatchObject([{ database: "accounts", definition: { export: "authPostgresSchema" }, dialect: "postgresql" }])
  })

  it("uses the dialect of a sibling plugin's Database Definition", async () => {
    const root = await createTempProject()
    await writeAuthDatabase(root, "authDatabase('accounts')")
    const definition = join(root, "accounts.ts")
    await writeFile(definition, "export default defineDatabase({ name: 'accounts', dialect: 'postgresql', schema: {} })\n")
    const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
    const { discoverDatabaseDefinitions, resolveDBViteConfig } = await import("@vite-hub/database/config")
    const collected = await collectDatabaseContributions([
      hubAuth(),
      { name: "accounts-owner", vitehub: { databases: [{ name: "accounts", definition }] } },
    ], { projectRoot: root, root, rootDir: root })
    expect(collected.tables).toMatchObject([{ database: "accounts", dialect: "postgresql", definition: { export: "authPostgresSchema" } }])
    expect(discoverDatabaseDefinitions(root, { contributions: collected }).map(entry => entry.name)).toEqual(["accounts"])
    expect(() => resolveDBViteConfig(undefined, root, { contributions: collected })).not.toThrow()
  })

  it("uses the dialect contributed for the implicit default Database", async () => {
    const root = await createTempProject()
    await writeAuthDatabase(root, "authDatabase()")
    const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
    const { resolveDBViteConfig } = await import("@vite-hub/database/config")
    const collected = await collectDatabaseContributions([
      hubAuth(),
      { name: "postgres-owner", vitehub: { databases: [{ name: "postgres-data", dialect: "postgresql" }] } },
    ], { projectRoot: root, root, rootDir: root })
    expect(collected.tables).toMatchObject([{ database: "default", dialect: "postgresql", definition: { export: "authPostgresSchema" } }])
    expect(() => resolveDBViteConfig(undefined, root, { contributions: collected })).not.toThrow()
  })

  it("adds no tables without authDatabase()", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    expect((await contributions(root)).tables).toEqual([])
    expect((await contributions(root, hubAuth(false))).tables).toEqual([])
  })
})
