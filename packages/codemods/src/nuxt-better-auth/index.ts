import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { detectStyle, findProperty, keyName, line, quoteString } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { addViteHubOptions, ConfigEditor, createLineResolver, findViteHubOption, removeModuleEntry, useViteHubModule } from "../shared/config-editor.ts"
import { detectNuxtModule } from "../shared/detect.ts"
import { findModuleEntry, findNuxtConfigName, literalValue, objectProperty, readNuxtConfig, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { codemodError, isCodemodError } from "../error-diagnostics.ts"
import { clientFollowUpsFor, rewriteServerFile } from "./call-sites.ts"
import { moveClientDefinition, moveServerDefinition } from "./definitions.ts"
import { editPage, pageMeta, pageRoute, pathMatches, ruleFor } from "./pages.ts"

import type { Node, ObjectExpression } from "@babel/types"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"
import type { AuthRouteRule } from "./pages.ts"

const moduleName = "@nuxtjs/better-auth"
/** The Better Auth range that ViteHub Auth supports. */
const betterAuthRange = "^1.7.15"
const scripts = "{ts,mts,js,mjs}"
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/dist/**", "**/.vitehub/**"]
const guide = "https://vitehub.dev/docs/auth/protect-pages"

/** Module options and what ViteHub does with each. `redirects.login` and `redirects.guest` move. */
const optionFollowUps: Record<string, string> = {
  "redirects.authenticated": "ViteHub does not navigate after signIn() or signUp(). Call navigateTo() after the call returns without an error.",
  "redirects.logout": "Pass the page to signOut({ redirectTo }) from useUserSession().",
  "redirects.sessionExpired": "ViteHub does not navigate when a session ends. A guarded page sends the visitor to the login page on the next navigation.",
  "preserveRedirect": "The ViteHub page guard always adds ?redirect=<the page> to the login page.",
  "redirectQueryKey": "The ViteHub page guard always uses ?redirect=.",
  "hubSecondaryStorage": "Set secondaryStorage in server/auth.ts, or keep sessions in the Database.",
  "schema": "ViteHub Auth contributes the Better Auth tables to the Database itself. Check the table names of the next migration with vitehub database generate.",
  "clientOnly": "ViteHub Auth runs the Auth server in the app. For an external Better Auth server, use createAuthClient() from vite-hub/auth/vue with its baseURL.",
  "serverConfig": "ViteHub Auth reads server/auth.ts. Move the config there.",
  "clientConfig": "ViteHub Auth reads app/auth.client.ts. Move the client config there.",
  "serverPluginSources": "List the plugins in server/auth.ts.",
  "clientPluginSources": "List the client plugins in app/auth.client.ts.",
}

interface LayerConfig {
  dir: string
  config: NuxtConfigFile
  listsModule: boolean
}

interface ConfigPlan {
  layer: LayerConfig
  removals: Node[]
}

/** Walk local layers without guessing at configs that cannot be inspected. */
async function readLayers(cwd: string, root: NuxtConfigFile, strict = true): Promise<LayerConfig[]> {
  const layers: LayerConfig[] = [{ dir: ".", config: root, listsModule: Boolean(findModuleEntry(root, moduleName)) }]
  const seen = new Set(["."])
  const automatic = (await glob(["layers/*"], { cwd, onlyDirectories: true })).sort().map(dir => dir.replace(/\/$/, ""))
  async function add(dir: string) {
    if (seen.has(dir)) return
    seen.add(dir)
    try {
      const config = await readNuxtConfig(join(cwd, dir))
      layers.push({ dir, config, listsModule: Boolean(findModuleEntry(config, moduleName)) })
    }
    catch (error) {
      if (!isCodemodError(error)) throw error
      if (strict) throw codemodError(`${dir}: The codemod could not read this layer config: ${error.message}`)
    }
  }
  for (const dir of automatic) {
    if (findNuxtConfigName(join(cwd, dir))) await add(dir)
  }
  for (const layer of layers) {
    const property = findProperty(layer.config.root, "extends")
    if (!property) continue
    const value = unwrapExpression(property.value)
    for (const entry of value.type === "ArrayExpression" ? value.elements : [value]) {
      const source = entry?.type === "ArrayExpression" ? entry.elements[0] : entry
      const options = entry?.type === "ArrayExpression" ? entry.elements[1] : undefined
      if (strict && options) {
        const object = staticOptionsObject(options)
        if (!object || findProperty(object, "overrides")) {
          throw codemodError(`${posix.join(layer.dir, layer.config.fileName)}:${line(options)}: The codemod cannot verify Auth with extends overrides or computed layer options. Migrate Auth by hand.`)
        }
      }
      const path = source && literalValue(source)
      const dir = typeof path === "string" && path.startsWith(".") ? posix.join(layer.dir, path) : undefined
      if (!dir || dir === ".." || dir.startsWith("../") || !findNuxtConfigName(join(cwd, dir))) {
        if (strict) throw codemodError(`${posix.join(layer.dir, layer.config.fileName)}:${line(property)}: The codemod cannot verify the Auth configuration of this extends entry. Migrate Auth by hand.`)
        continue
      }
      await add(dir)
    }
  }
  return layers
}

/** The module options of one config: the `auth` key and the inline options of its `modules` entry. */
function moduleOptions(layer: LayerConfig): Array<{ object: ObjectExpression, property?: Node }> {
  const options: Array<{ object: ObjectExpression, property?: Node }> = []
  const inline = findModuleEntry(layer.config, moduleName)?.inlineOptions
  const inlineObject = inline && staticOptionsObject(inline)
  if (inline && !inlineObject) throw codemodError(`${layer.dir}/${layer.config.fileName}: Use literal module options before migrating Auth.`)
  if (inlineObject) options.push({ object: inlineObject })
  const property = findProperty(layer.config.root, "auth")
  const object = property && staticOptionsObject(property.value)
  if (property && object) options.push({ object, property })
  else if (property) throw codemodError(`${layer.config.fileName} sets auth options that cannot be read completely. Use an object literal with explicit, unique property names, then run the codemod again.`)
  return options
}

/** Reads `routeRules` and `nitro.routeRules` entries with `auth`, and plans their removal. */
function readRouteRules(layer: LayerConfig, plan: ConfigPlan): AuthRouteRule[] {
  const { config } = layer
  const style = detectStyle(config.code, config.program)
  const file = posix.join(layer.dir, config.fileName)
  const rules: AuthRouteRule[] = []
  const nitro = objectProperty(config.root, "nitro")
  const unsupported = (message: string, node: Node) => codemodError(`${file}:${line(node)}: ${message} Migrate this rule by hand before removing ${moduleName}.`)
  if (!staticOptionsObject(config.root)) throw codemodError(`${file}: Use explicit Nuxt config keys so the codemod can check the Auth policy.`)
  const nitroProperty = findProperty(config.root, "nitro")
  if (nitroProperty && !staticOptionsObject(nitroProperty.value)) throw unsupported("The Nitro options are not a static object.", nitroProperty)
  for (const owner of [config.root, nitro]) {
    const routeRulesProperty = owner && findProperty(owner, "routeRules")
    if (!routeRulesProperty) continue
    const routeRules = staticOptionsObject(routeRulesProperty.value)
    if (!routeRules) throw unsupported("The routeRules are not a static object.", routeRulesProperty)
    let removed = 0
    const removals: Node[] = []
    for (const entry of routeRules.properties) {
      if (entry.type !== "ObjectProperty") continue
      const pattern = keyName(entry.key, entry.computed)
      const rule = staticOptionsObject(entry.value)
      if (!rule) throw unsupported("The route rule is not a static object.", entry)
      const auth = findProperty(rule, "auth")
      if (!auth) continue
      if (!pattern || !/^\/(?:[\w.-]+(?:\/[\w.-]+)*(?:\/\*\*)?)?$/.test(pattern) || pattern.split("/").some(part => part === "." || part === "..")) {
        throw unsupported(`Found an unsupported auth path: ${pattern}.`, entry)
      }
      const { meta, user, dropped } = pageMeta(config.code, auth.value, style)
      if (!meta || dropped.length) throw unsupported(`Found an unsupported auth rule for ${pattern}.`, auth)
      const value = staticOptionsObject(auth.value)
      const redirect = value && findProperty(value, "redirectTo")
      const redirectTo = redirect && literalValue(redirect.value)
      if (redirect && typeof redirectTo !== "string") {
        throw unsupported(`Use a literal redirectTo for ${pattern}.`, redirect)
      }
      if (rule.properties.length === 1) {
        removals.push(entry)
        removed++
      }
      else removals.push(auth)
      const server = pattern === "/api" || pattern.startsWith("/api/")
      const literal = literalValue(auth.value)
      const isPublic = literal === false
      if (server && !user && !isPublic) {
        throw unsupported(`ViteHub cannot move the guest-only API rule for ${pattern}.`, auth)
      }
      if (server && redirect) throw unsupported(`The API rule for ${pattern} sets a redirect.`, auth)
      const mode = quoteString(user ? "user" : "guest", style)
      const pageValue = typeof redirectTo === "string"
        ? `{ only: ${mode}, redirectTo: ${quoteString(redirectTo, style)} }`
        : typeof literal === "boolean" ? String(literal) : mode
      rules.push({ pattern, meta: pageValue, user: user === true, server, isPublic, file, line: line(auth) })
    }
    if (removed && removed === routeRules.properties.length) plan.removals.push(routeRulesProperty)
    else plan.removals.push(...removals)
  }
  return rules
}

/** True when the app has a ViteHub Database, or a NuxtHub one that the nuxthub codemod moves. */
function hasDatabase(config: NuxtConfigFile): boolean {
  const option = findViteHubOption(config, "database")
  if (option) return literalValue(option.value) !== false
  const hub = objectProperty(config.root, "hub")
  const db = hub && (findProperty(hub, "db") ?? findProperty(hub, "database"))
  return Boolean(db && literalValue(db.value) !== false)
}

async function readText(cwd: string, file: string): Promise<string> {
  return readFile(join(cwd, file), "utf8")
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const rootConfig = await readNuxtConfig(cwd)
  const followUps: FollowUp[] = []
  const edits: FileEdit[] = []
  const notes: string[] = []
  const layers = await readLayers(cwd, rootConfig)
  const plans = new Map<LayerConfig, ConfigPlan>(layers.map(layer => [layer, { layer, removals: [] }]))

  // Module options.
  const redirects: { signIn?: string, afterSignIn?: string } = {}
  for (const layer of layers) {
    const file = posix.join(layer.dir, layer.config.fileName)
    for (const property of layer.config.root.properties) {
      if (property.type !== "ObjectProperty") continue
      const key = keyName(property.key, property.computed)
      if (key?.startsWith("$") && key !== "$meta") {
        throw codemodError(`${file}:${line(property)}: Nuxt environment override ${key} can change the Auth policy. Migrate Auth by hand for each environment.`)
      }
    }
    if (["srcDir", "serverDir", "dir", "hooks"].some(key => findProperty(layer.config.root, key))) {
      throw codemodError(`${file}: The codemod cannot verify Auth discovery with custom Nuxt directories or hooks. Migrate the Auth config by hand.`)
    }
    const vitehub = findProperty(layer.config.root, "vitehub")
    if (vitehub && !staticOptionsObject(vitehub.value)) throw codemodError(`${file}: Use a static vitehub options object so the codemod can check whether Auth is enabled.`)
    const auth = findViteHubOption(layer.config, "auth")
    if (auth && literalValue(auth.value) !== true) {
      if (staticOptionsObject(auth.value)) throw codemodError(`${file}:${line(auth)}: The vitehub.auth options object is no longer supported. Merge its settings into server/auth.ts by hand.`)
      throw codemodError(`${file}:${line(auth)}: Auth is disabled or computed in vitehub.auth. Enable it explicitly before migrating.`)
    }
    for (const { object, property } of moduleOptions(layer)) {
      if (property) plans.get(layer)!.removals.push(property)
      for (const option of object.properties) {
        if (option.type !== "ObjectProperty") continue
        const key = keyName(option.key, option.computed)
        const nested = key === "redirects" ? staticOptionsObject(option.value) : undefined
        if (["serverConfig", "clientConfig", "clientOnly", "serverPluginSources", "clientPluginSources"].includes(key ?? "") || (key === "redirects" && !nested)) {
          throw codemodError(`${file}:${line(option)}: Move the source Auth option ${key} by hand before migrating.`)
        }
        for (const [name, value] of nested ? nested.properties.flatMap(child => child.type === "ObjectProperty" ? [[`redirects.${keyName(child.key, child.computed)}`, child] as const] : []) : [[key ?? "", option] as const]) {
          const literal = literalValue(value.value)
          if (name === "redirects.login" || name === "redirects.guest") {
            if (typeof literal !== "string" || !/^\/(?![/\\])/.test(literal)) {
              throw codemodError(`${file}:${line(value)}: auth.${name} must be a literal app path, such as '/sign-in'. Migrate the redirect by hand.`)
            }
            // The app wins over its layers.
            redirects[name === "redirects.login" ? "signIn" : "afterSignIn"] ??= literal
            continue
          }
          const message = optionFollowUps[name]
          followUps.push({ file, line: line(value), message: message ? `${name}: ${message}` : `${name} is not a ViteHub Auth option. Check it by hand.` })
        }
      }
    }
  }

  // Route rules.
  const rules = layers.flatMap(layer => readRouteRules(layer, plans.get(layer)!))
  for (const [index, rule] of rules.entries()) {
    for (const other of rules.slice(index + 1)) {
      const [broad, narrow] = pathMatches(rule.pattern, other.pattern.replace(/\/\*\*$/, "")) ? [rule, other] : [other, rule]
      if (!pathMatches(broad.pattern, narrow.pattern.replace(/\/\*\*$/, ""))) continue
      if (broad.server && broad.user && broad.pattern.endsWith("/**") && narrow.isPublic && !narrow.pattern.endsWith("/**")) continue
      throw codemodError(`${rule.file}:${rule.line}: Auth rules ${rule.pattern} and ${other.pattern} overlap. Migrate their combined policy by hand.`)
    }
  }
  const pageRules = rules.filter(rule => !rule.server)
  const accessRoutes = rules.filter(rule => rule.server && rule.user && !pathMatches("/api/auth/**", rule.pattern)).map(rule => rule.pattern)
  const publicRoutes = rules.filter(rule => rule.server && rule.isPublic && accessRoutes.some(route => pathMatches(route, rule.pattern))).map(rule => rule.pattern)
  if (accessRoutes.some(route => pathMatches(route, "/api/auth"))) publicRoutes.push("/api/auth/**")

  // Pages.
  const style = detectStyle(rootConfig.code, rootConfig.program)
  const typescript = existsSync(join(cwd, "tsconfig.json"))
  const matched = new Set<AuthRouteRule>()
  const pageFiles: string[] = []
  for (const layer of layers) {
    for (const pages of ["app/pages", "pages"]) {
      const directory = posix.join(layer.dir, pages)
      if (!existsSync(join(cwd, directory))) continue
      for (const relative of (await glob(["**/*.vue"], { cwd: join(cwd, directory), ignore: ignored })).sort()) {
        const file = posix.join(directory, relative)
        const route = pageRoute(relative)
        if (pageRules.length && /[:*]/.test(route)) throw codemodError(`${file}: The codemod cannot prove that a dynamic page has one auth policy. Migrate its route rules by hand.`)
        const rule = ruleFor(pageRules, route)
        if (rule) matched.add(rule)
        pageFiles.push(file)
        const before = await readText(cwd, file)
        const page = editPage(file, before, rule, style, typescript)
        if (page.followUps.length) throw codemodError(page.followUps.map(entry => `${entry.file}${entry.line ? `:${entry.line}` : ""}: ${entry.message}`).join("\n"))
        if (page.after !== undefined) edits.push({ path: file, before, after: page.after })
      }
    }
  }
  for (const rule of pageRules) {
    if (!matched.has(rule)) throw codemodError(`${rule.file}:${rule.line}: The auth rule of ${rule.pattern} matches no page file. Migrate it by hand. See ${guide}.`)
  }

  // Auth Definitions.
  const database = hasDatabase(rootConfig)
  const targetScripts = "{ts,mts,cts,js,mjs,cjs}"
  for (const layer of layers) {
    const patterns = [`server/auth.${targetScripts}`]
    if (layer.dir === ".") patterns.push(`server.auth.${targetScripts}`, `app/auth.client.${targetScripts}`)
    const [existing] = await glob(patterns, { cwd: join(cwd, layer.dir) })
    if (existing) throw codemodError(`${posix.join(layer.dir, existing)}: An Auth Definition already exists. Merge the configs by hand.`)
  }
  let serverFile: string | undefined
  let servers = 0
  let clients = 0
  for (const layer of layers) {
    const configs = await glob([`server/auth.config.${scripts}`], { cwd: join(cwd, layer.dir) })
    const [server] = configs
    if (server) {
      const file = posix.join(layer.dir, server)
      const target = posix.join(layer.dir, "server/auth.ts")
      if (serverFile || configs.length > 1) throw codemodError(`${file}: Multiple source server configs can change which Auth Definition is loaded. Keep only the effective config before migrating.`)
      serverFile = file
      const before = await readText(cwd, file)
      const moved = moveServerDefinition({ file, code: before, database, accessRoutes, publicRoutes, ...redirects })
      followUps.push(...moved.followUps)
      if (moved.moved) {
        servers++
        edits.push({ path: file, before, after: null }, { path: target, before: undefined, after: moved.code ?? null })
      }
    }
    for (const candidate of ["app/auth.config", "auth.config"]) {
      const configs = await glob([`${candidate}.${scripts}`], { cwd: join(cwd, layer.dir) })
      const [client] = configs
      if (!client) continue
      const file = posix.join(layer.dir, client)
      if (clients++ || configs.length > 1) throw codemodError(`${file}: Multiple source client configs can change which Auth Client Definition is loaded. Keep only the effective config before migrating.`)
      const target = posix.join(layer.dir, posix.dirname(client), "auth.client.ts")
      const before = await readText(cwd, file)
      const moved = moveClientDefinition(file, before)
      if (!moved.moved || moved.followUps.length) throw codemodError(`${file}: ${moved.followUps.map(entry => entry.message).join(" ")}`)
      if (moved.code && (layer.dir !== "." || candidate !== "app/auth.config")) throw codemodError(`${file}: ViteHub loads only the app's app/auth.client.ts. Move the client config and adjust its imports by hand.`)
      if (moved.moved) {
        edits.push({ path: file, before, after: null })
        if (moved.code) edits.push({ path: target, before: undefined, after: moved.code })
      }
    }
  }
  if (!servers) throw codemodError(`No server/auth.config.ts with defineServerAuth() could be moved, so nothing was migrated. Create server/auth.ts with defineAuth() from vite-hub/auth, then run the codemod again.${followUps.length ? `\n${followUps.map(entry => `  ${entry.file}${entry.line ? `:${entry.line}` : ""} ${entry.message}`).join("\n")}` : ""}`)

  // Server helpers and client composables.
  const edited = new Map(edits.map(edit => [edit.path, edit]))
  for (const layer of layers) {
    const base = join(cwd, layer.dir)
    for (const relative of (await glob([`server/**/*.${scripts}`], { cwd: base, ignore: [...ignored, "server/auth.config.*", "server/auth.ts"] })).sort()) {
      const file = posix.join(layer.dir, relative)
      const before = await readText(cwd, file)
      const result = rewriteServerFile(file, before)
      followUps.push(...result.followUps)
      if (result.after !== undefined) edits.push({ path: file, before, after: result.after })
    }
    const appFiles = await glob([`**/*.{vue,${scripts.slice(1, -1)}}`], { cwd: base, ignore: [...ignored, "server/**", "layers/**", "nuxt.config.*", "**/auth.config.*", "**/*.d.ts", "test/**", "tests/**"] })
    for (const relative of appFiles.sort()) {
      const file = posix.join(layer.dir, relative)
      const code = edited.get(file)?.after ?? await readText(cwd, file)
      if (typeof code === "string") followUps.push(...clientFollowUpsFor(file, code))
    }
  }

  // nuxt.config of the app and its layers.
  let host: string | undefined
  let hostNote: string | undefined
  for (const layer of layers) {
    const { config } = layer
    const plan = plans.get(layer)!
    const editor = new ConfigEditor(config)
    for (const node of plan.removals) editor.removeItem(node)
    const removed = new Set<Node>(plan.removals)
    if (layer.dir === ".") {
      const rootEntries = useViteHubModule(editor, config, layer.listsModule ? moduleName : undefined)
      const added = addViteHubOptions(editor, config, { options: [], rootEntries, removedRootProperties: removed })
      host = added.host
      hostNote = added.hostNote
    }
    else if (layer.listsModule) removeModuleEntry(editor, config, moduleName)
    editor.removeUnusedBindings()
    // A removed root property between two blank lines leaves one of them.
    const output = editor.output.toString()
    const after = config.code.includes("\n\n\n") ? output : output.replace(/\n{3,}/g, "\n\n")
    if (after !== config.code) edits.unshift({ path: posix.join(layer.dir, config.fileName), before: config.code, after })
    if (layer.dir === "." && hostNote) followUps.unshift({ file: config.fileName, line: createLineResolver(after)(["vitehub", "host"]), message: hostNote })
  }

  // Secrets and URLs in env files. The codemod never reads or prints a value.
  for (const file of (await glob([".env", ".env.*"], { cwd, dot: true })).sort()) {
    const lines = (await readText(cwd, file)).split("\n")
    lines.forEach((text, index) => {
      if (/^\s*(?:export\s+)?NUXT_BETTER_AUTH_SECRET\s*=/.test(text)) followUps.push({ file, line: index + 1, message: "ViteHub Auth does not read NUXT_BETTER_AUTH_SECRET. Rename it to BETTER_AUTH_SECRET to keep the same secret, so sessions stay valid." })
      if (/^\s*(?:export\s+)?NUXT_PUBLIC_SITE_URL\s*=/.test(text)) followUps.push({ file, line: index + 1, message: "ViteHub Auth uses the request origin as baseURL. Set baseURL in server/auth.ts only if the app needs a fixed URL, such as for OAuth callbacks behind a proxy." })
    })
  }

  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: [moduleName], add: ["vite-hub", "@vite-hub/auth"], within: { "better-auth": betterAuthRange } })
  if (packageResult.edit) edits.push(packageResult.edit)
  notes.push(
    "ViteHub Auth mounts Better Auth at /api/auth, as the module did, and uses the same session cookie, so signed-in users stay signed in when the secret stays the same.",
    "The module derived its secret from NUXT_APP_SECRET when no Better Auth secret was set. ViteHub derives it from VITEHUB_SECRET. Set BETTER_AUTH_SECRET to the old value, or users sign in again.",
    `Route rules with auth became definePageMeta({ auth }) on each page. The page guard is for navigation only: protect API routes with access.routes or requireAuth(event). See ${guide}.`,
  )
  if (database) notes.push("Auth keeps users in the app Database with authDatabase(). Run `vitehub database generate`: when the Better Auth tables exist, ViteHub reads them from the latest migration snapshot and adds only what is missing.")
  return {
    summary: `moved ${servers} Auth config${servers === 1 ? "" : "s"} to server/auth.ts and ${pageRules.length} auth route rule${pageRules.length === 1 ? "" : "s"} to page meta${host ? `, host "${host}"` : ""}.`,
    edits,
    followUps,
    notes,
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install vite-hub and @vite-hub/auth and remove ${moduleName}.`,
      "Run `npx nuxi prepare`, then type-check the app.",
      "Sign up, sign in, and open a guarded page to check the migration.",
    ],
  }
}

/** Detects the module in the app config, a local layer config, or package.json. */
async function detect({ cwd }: CodemodContext) {
  const found = await detectNuxtModule(cwd, moduleName)
  if (found) return found
  try {
    const config = await readNuxtConfig(cwd)
    for (const layer of await readLayers(cwd, config, false)) {
      if (layer.listsModule) return { reason: `${posix.join(layer.dir, layer.config.fileName)} lists ${moduleName} in modules` }
    }
  }
  catch (error) {
    if (!isCodemodError(error)) throw error
  }
  return undefined
}

export const nuxtBetterAuth: Codemod = {
  name: "nuxt-better-auth",
  description: "Move a Nuxt app from @nuxtjs/better-auth to ViteHub Auth through vite-hub/nuxt.",
  usage: "[dir]",
  detect,
  run: migrate,
}
