import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { detectStyle, findProperty, keyName, line, quoteString } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { addViteHubOptions, ConfigEditor, createLineResolver, findViteHubOption, removeModuleEntry, useViteHubModule } from "../shared/config-editor.ts"
import { detectNuxtModule } from "../shared/detect.ts"
import { localLayerDirectories } from "../shared/layers.ts"
import { findModuleEntry, findNuxtConfigName, literalValue, objectProperty, readNuxtConfig, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { codemodError, isCodemodError } from "../error-diagnostics.ts"
import { clientFollowUpsFor, rewriteServerFile } from "./call-sites.ts"
import { moveClientDefinition, moveServerDefinition } from "./definitions.ts"
import { editPage, pageMeta, pageRoute, ruleFor } from "./pages.ts"

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

/** Every local layer with a nuxt.config. The app root comes first. */
async function readLayers(cwd: string, root: NuxtConfigFile, followUps: FollowUp[]): Promise<LayerConfig[]> {
  const layers: LayerConfig[] = [{ dir: ".", config: root, listsModule: Boolean(findModuleEntry(root, moduleName)) }]
  for (const dir of await localLayerDirectories(cwd, root)) {
    if (dir === "." || !findNuxtConfigName(join(cwd, dir))) continue
    try {
      const config = await readNuxtConfig(join(cwd, dir))
      layers.push({ dir, config, listsModule: Boolean(findModuleEntry(config, moduleName)) })
    }
    catch (error) {
      if (!isCodemodError(error)) throw error
      followUps.push({ file: posix.join(dir, "nuxt.config.ts"), message: `The codemod could not read this layer config, so it did not migrate it: ${error.message}` })
    }
  }
  return layers
}

/** The module options of one config: the `auth` key and the inline options of its `modules` entry. */
function moduleOptions(layer: LayerConfig): Array<{ object: ObjectExpression, property?: Node }> {
  const options: Array<{ object: ObjectExpression, property?: Node }> = []
  const inline = findModuleEntry(layer.config, moduleName)?.inlineOptions
  const inlineObject = inline && staticOptionsObject(inline)
  if (inlineObject) options.push({ object: inlineObject })
  // Another module may own a root `auth` key. Read it only where the module is in use.
  const property = (layer.listsModule || layer.dir === ".") ? findProperty(layer.config.root, "auth") : undefined
  const object = property && staticOptionsObject(property.value)
  if (property && object) options.push({ object, property })
  else if (property) throw codemodError(`${layer.config.fileName} sets auth options that cannot be read completely. Use an object literal with explicit, unique property names, then run the codemod again.`)
  return options
}

/** Reads `routeRules` and `nitro.routeRules` entries with `auth`, and plans their removal. */
function readRouteRules(layer: LayerConfig, plan: ConfigPlan, followUps: FollowUp[]): AuthRouteRule[] {
  const { config } = layer
  const style = detectStyle(config.code, config.program)
  const file = posix.join(layer.dir, config.fileName)
  const rules: AuthRouteRule[] = []
  const nitro = objectProperty(config.root, "nitro")
  for (const owner of [config.root, nitro]) {
    const routeRulesProperty = owner && findProperty(owner, "routeRules")
    const routeRules = routeRulesProperty && unwrapExpression(routeRulesProperty.value)
    if (!routeRulesProperty || routeRules?.type !== "ObjectExpression") continue
    let removed = 0
    const removals: Node[] = []
    for (const entry of routeRules.properties) {
      if (entry.type !== "ObjectProperty") continue
      const pattern = keyName(entry.key, entry.computed)
      const rule = unwrapExpression(entry.value)
      const auth = rule.type === "ObjectExpression" ? findProperty(rule, "auth") : undefined
      if (!pattern || !auth || rule.type !== "ObjectExpression") continue
      const { meta, user, dropped } = pageMeta(config.code, auth.value, style)
      if (!meta) {
        followUps.push({ file, line: line(auth), message: `The auth rule of ${pattern} is computed, so the codemod left it. ViteHub reads no auth route rules. Move it to definePageMeta({ auth }) by hand. See ${guide}.` })
        continue
      }
      if (rule.properties.length === 1) {
        removals.push(entry)
        removed++
      }
      else removals.push(auth)
      if (dropped.length) followUps.push({ file, line: line(auth), message: `The auth rule of ${pattern} also matched ${dropped.join(", ")}. ViteHub guards pages by session only, so check that rule in the page, or in access.routes with authorize in server/auth.ts.` })
      if (pattern === "/api" || pattern.startsWith("/api/")) {
        if (!user) followUps.push({ file, line: line(auth), message: `The auth rule of ${pattern} let only signed-out visitors in. ViteHub has no such server guard. Check it in the handler.` })
        rules.push({ pattern, meta, user: user === true, server: true })
        continue
      }
      if (pattern === "/**" && user) followUps.push({ file, line: line(auth), message: `The auth rule of ${pattern} also guarded /api routes. The codemod moved it to the pages only. Add access.routes: ["/api/**"] and access.public: ["/api/auth/**"] in server/auth.ts to keep the API private.` })
      rules.push({ pattern, meta, user: user === true, server: false })
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
  const layers = await readLayers(cwd, rootConfig, followUps)
  const plans = new Map<LayerConfig, ConfigPlan>(layers.map(layer => [layer, { layer, removals: [] }]))

  // Module options.
  const redirects: Record<string, string> = {}
  for (const layer of layers) {
    const file = posix.join(layer.dir, layer.config.fileName)
    for (const { object, property } of moduleOptions(layer)) {
      if (property) plans.get(layer)!.removals.push(property)
      for (const option of object.properties) {
        if (option.type !== "ObjectProperty") continue
        const key = keyName(option.key, option.computed)
        const nested = key === "redirects" ? staticOptionsObject(option.value) : undefined
        for (const [name, value] of nested ? nested.properties.flatMap(child => child.type === "ObjectProperty" ? [[`redirects.${keyName(child.key, child.computed)}`, child] as const] : []) : [[key ?? "", option] as const]) {
          const literal = literalValue(value.value)
          if ((name === "redirects.login" || name === "redirects.guest") && typeof literal === "string") {
            // The app wins over its layers.
            redirects[name.slice("redirects.".length)] ??= literal
            continue
          }
          const message = optionFollowUps[name]
          followUps.push({ file, line: line(value), message: message ? `${name}: ${message}` : `${name} is not a ViteHub Auth option. Check it by hand.` })
        }
      }
    }
  }

  // Route rules.
  const rules = layers.flatMap(layer => readRouteRules(layer, plans.get(layer)!, followUps))
  const pageRules = rules.filter(rule => !rule.server)
  const accessRoutes = rules.filter(rule => rule.server && rule.user).map(rule => rule.pattern)

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
        const rule = ruleFor(pageRules, pageRoute(relative))
        if (rule) matched.add(rule)
        pageFiles.push(file)
        const before = await readText(cwd, file)
        const page = editPage(file, before, rule, style, typescript)
        followUps.push(...page.followUps)
        if (page.after !== undefined) edits.push({ path: file, before, after: page.after })
      }
    }
  }
  for (const rule of pageRules) {
    if (!matched.has(rule)) followUps.push({ file: rootConfig.fileName, message: `The auth rule of ${rule.pattern} matches no page file, so the codemod moved it nowhere. Add definePageMeta({ auth: ${rule.meta} }) to the page that serves it. See ${guide}.` })
  }

  // Auth Definitions.
  const database = hasDatabase(rootConfig)
  let routesPlaced = !accessRoutes.length
  let servers = 0
  for (const layer of layers) {
    const configs = await glob([`server/auth.config.${scripts}`], { cwd: join(cwd, layer.dir) })
    const [server] = configs
    if (server) {
      const file = posix.join(layer.dir, server)
      const target = posix.join(layer.dir, "server/auth.ts")
      if (existsSync(join(cwd, target))) {
        followUps.push({ file, message: `${target} exists already, so the codemod did not move this config. Merge it into ${target} by hand.` })
      }
      else {
        const before = await readText(cwd, file)
        const moved = moveServerDefinition({ file, code: before, database, accessRoutes: routesPlaced ? [] : accessRoutes })
        followUps.push(...moved.followUps)
        if (moved.moved) {
          routesPlaced = true
          servers++
          edits.push({ path: file, before, after: null }, { path: target, before: undefined, after: moved.code ?? null })
        }
      }
    }
    for (const candidate of ["app/auth.config", "auth.config"]) {
      const [client] = await glob([`${candidate}.${scripts}`], { cwd: join(cwd, layer.dir) })
      if (!client) continue
      const file = posix.join(layer.dir, client)
      const target = posix.join(layer.dir, posix.dirname(client), "auth.client.ts")
      if (existsSync(join(cwd, target))) {
        followUps.push({ file, message: `${target} exists already, so the codemod did not move this config. Merge it into ${target} by hand.` })
        break
      }
      const before = await readText(cwd, file)
      const moved = moveClientDefinition(file, before)
      followUps.push(...moved.followUps)
      if (moved.moved) {
        edits.push({ path: file, before, after: null })
        if (moved.code) edits.push({ path: target, before: undefined, after: moved.code })
      }
      break
    }
  }
  if (!servers) throw codemodError(`No server/auth.config.ts with defineServerAuth() could be moved, so nothing was migrated. Create server/auth.ts with defineAuth() from vite-hub/auth, then run the codemod again.${followUps.length ? `\n${followUps.map(entry => `  ${entry.file}${entry.line ? `:${entry.line}` : ""} ${entry.message}`).join("\n")}` : ""}`)
  if (!routesPlaced) followUps.push({ file: rootConfig.fileName, message: `Route rules guarded these server paths: ${accessRoutes.join(", ")}. Add them to access.routes in server/auth.ts by hand.` })

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
      const options = []
      if (Object.keys(redirects).length) {
        if (findViteHubOption(config, "auth")) followUps.push({ file: config.fileName, message: `vitehub.auth exists already. Add redirects: ${JSON.stringify(redirects)} to it by hand.` })
        else options.push({ key: "auth", label: "the Auth options", value: (indent: string) => `{\n${indent}${editor.style.indent}redirects: { ${Object.entries(redirects).map(([key, value]) => `${key}: ${quoteString(value, editor.style)}`).join(", ")} },\n${indent}}` })
      }
      const added = addViteHubOptions(editor, config, { options, rootEntries, removedRootProperties: removed })
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
    for (const dir of await localLayerDirectories(cwd, config)) {
      if (dir === "." || !findNuxtConfigName(join(cwd, dir))) continue
      const layer = await readNuxtConfig(join(cwd, dir)).catch(() => undefined)
      if (layer && findModuleEntry(layer, moduleName)) return { reason: `${posix.join(dir, layer.fileName)} lists ${moduleName} in modules` }
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
