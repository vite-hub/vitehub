import * as v from "valibot"
import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createRuntimeEnvRegistry } from "@vite-hub/env/vite"
import { resolveViteHubBundleDefines, bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNoExternalAddition, isServerEnvironment, resolveViteHubGeneratedRoot, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { renderViteHubNitroDevHandler } from "@vite-hub/internal/dev-endpoint"

import type { EnvRuntimeConfigOptions, EnvRuntimeRegistry } from "@vite-hub/env"
import type { ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { Plugin, ResolvedConfig } from "vite"
import { emailDevRuntimeRoute } from "./dev.ts"
import { emailErrorDiagnostics } from "./error-diagnostics.ts"
import { discoverEmailTemplates } from "./templates.ts"
import { disposeEmailOutbox } from "./runtime/outbox.ts"
import { registerEmailDevEndpoint } from "./vite-dev.ts"

import type { EmailTemplate } from "./templates.ts"

export { emailConsoleSection } from "./console.ts"

export const EMAIL_DEFINITION_ID = "#vitehub/email/definition"
export const EMAIL_VITE_PLUGIN_NAME = "@vite-hub/email/vite"

const resolvedEmailDefinitionId = `\0${EMAIL_DEFINITION_ID}`
const noExternalAddition = createNoExternalAddition("@vite-hub/email")
const resolvePackageImport = createRequire(import.meta.url).resolve
const normalizeTemplateModulePath = (id: string) => {
  const path = id.split(/[?#]/, 1)[0]
  if (!path.startsWith("/@fs/")) return path
  const file = path.slice(5)
  // Vite keeps a leading slash for POSIX paths, but prefixes Windows drive
  // paths with one as well; remove that extra separator before comparison.
  const normalized = (/^\/?[A-Za-z]:[\\/]/.test(file) ? file.replace(/^\//, "") : file).replaceAll("\\", "/")
  // Drive-letter paths are already absolute after removing Vite's prefix;
  // adding a leading slash would turn `C:/...` into a root-relative path.
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/") ? normalized : `/${normalized}`
}
const normalizeWatchedPath = (file: string) => file.replaceAll("\\", "/")
export type EmailProvider = "cloudflare-email" | "resend"

interface GeneratedEmailDefinition {
  driver: EmailProvider
  handler: string
  name: "default"
  options: EnvRuntimeRegistry
}

/** Development outbox options. The outbox is active only in `vite dev`. */
export interface EmailOutboxOptions {
  /**
   * `true` sends each captured message through the configured provider. `false` only captures the message and
   * returns an `outbox-<n>` id with `driver: "outbox"`.
   * @default true
   */
  deliver?: boolean
  /**
   * Number of messages to keep in memory. The oldest message is removed first. The value must be an integer from 1
   * to 1000.
   * @default 50
   */
  limit?: number
}

export interface EmailVitePluginOptions {
  driver: EmailProvider
  options?: EnvRuntimeConfigOptions
  /**
   * Development outbox. In `vite dev`, `email.send()` records each message. `false` disables the outbox. Build output
   * never contains the outbox.
   * @default { deliver: true, limit: 50 }
   */
  outbox?: false | EmailOutboxOptions
}

export interface EmailVitePluginAPI {
  getDefinition: () => GeneratedEmailDefinition | undefined
  prepareTypes: (options: { materialize?: boolean, projectRoot: string, serverDirs?: string[] }) => Promise<Record<string, string>>
}

export type EmailVitePlugin = Plugin & {
  api: EmailVitePluginAPI
  vitehub: NonNullable<ViteHubProviderImportContributor["vitehub"]> & ViteHubCliPluginMetadata
}

export function hubEmailOptionalPeerResolver(): Plugin & { api: { prepareTypes: (projectRoot: string) => Promise<void> } } {
  const prepareTypes = async (projectRoot: string) => {
    await rm(resolve(projectRoot, ".vitehub", "types", "email.d.ts"), { force: true })
  }
  return {
    name: "@vite-hub/email/optional-peer-resolver",
    api: { prepareTypes },
    async configResolved(config) {
      if (config.plugins.some(plugin => plugin.name === EMAIL_VITE_PLUGIN_NAME)) return
      const projectRoot = resolveViteHubProjectRoot(config.root)
      await prepareTypes(projectRoot)
    },
  }
}

interface InternalEmailVitePluginOptions {
  hosting?: string
  /** Import path prefix for generated runtime imports, for example `vite-hub/_internal/email`. */
  importBase?: string
  runtimeEnvImport?: string
  workflowProvider?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRuntimeEnvEntry(value: unknown): value is { default?: unknown, secret: boolean, source: Record<string, unknown> } {
  return isRecord(value) && isRecord(value.source) && (value.secret === true || value.secret === false)
}

function validateEmailRuntimeOptions(value: unknown, path = "email.options"): void {
  if (isRuntimeEnvEntry(value)) {
    if (value.source.kind === "provider") {
      throw emailErrorDiagnostics.EMAIL_SYNC_OPTION_REQUIRED({ path })
    }
    if (value.secret && value.default !== undefined) {
      throw emailErrorDiagnostics.EMAIL_SECRET_DEFAULT({ path })
    }
    return
  }
  if (!isRecord(value) || value.kind === "literal") return
  for (const [key, child] of Object.entries(value)) {
    validateEmailRuntimeOptions(child, `${path}.${key}`)
  }
}

function renderResolvedOptions(value: unknown, reference: string): string {
  if (isRuntimeEnvEntry(value)) return value.secret ? `${reference}?.unseal()` : reference
  if (!isRecord(value) || value.kind === "literal") return reference
  return `{ ${Object.entries(value).map(([key, child]) =>
    `[${JSON.stringify(key)}]: ${renderResolvedOptions(child, `${reference}[${JSON.stringify(key)}]`)}`
  ).join(", ")} }`
}

function resolveDriverImport(driver: string): string {
  if (driver !== "resend" && driver !== "cloudflare-email") {
    throw emailErrorDiagnostics.EMAIL_UNKNOWN_DRIVER()
  }
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  return fileURLToPath(new URL(`./drivers/${driver}.${extension}`, import.meta.url))
}

function resolveOutboxImport(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  return fileURLToPath(new URL(`./runtime/outbox.${extension}`, import.meta.url))
}

/** Checked development outbox options. `undefined` means the outbox is disabled. */
interface ResolvedEmailOutboxOptions {
  deliver: boolean
  limit: number
}

function resolveOutboxOptions(value: unknown): ResolvedEmailOutboxOptions | undefined {
  if (value === false) return
  if (value !== undefined && !isRecord(value)) {
    throw emailErrorDiagnostics.EMAIL_INVALID_OUTBOX({ problem: "type" })
  }
  const deliver = value?.deliver ?? true
  const limit = value?.limit ?? 50
  if (!v.is(v.boolean(), deliver)) {
    throw emailErrorDiagnostics.EMAIL_INVALID_OUTBOX({ problem: "deliver" })
  }
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)), limit)) {
    throw emailErrorDiagnostics.EMAIL_INVALID_OUTBOX({ problem: "limit" })
  }
  return { deliver, limit }
}

const generatedNitroDevHandler = ".vitehub/nitro/email/dev-handler.ts"

/**
 * Adds the development-only Nitro handler that runs `vitehub email outbox` operations in the Nitro runtime.
 * Build output never contains this handler.
 */
async function addNitroEmailDevHandler(value: unknown, root: string, importBase: string, outbox: boolean, runtimeId: string): Promise<Record<string, unknown>> {
  const handler = resolve(root, generatedNitroDevHandler)
  await mkdir(dirname(handler), { recursive: true })
  await writeFile(handler, renderViteHubNitroDevHandler({
    export: outbox ? "handleEmailDevRequest" : "handleDisabledEmailDevRequest",
    module: `${importBase}/runtime/console`,
    context: outbox ? { runtimeId } : undefined,
  }), "utf8")
  const kit = createNitroServerKit(isRecord(value) ? { ...value } : {})
  kit.addHandler({ handler, route: emailDevRuntimeRoute })
  return kit.config
}

function configuredDefinition(options: EmailVitePluginOptions): Omit<GeneratedEmailDefinition, "handler"> {
  const runtimeOptions = createRuntimeEnvRegistry(options.options, { path: "email.options" })
  validateEmailRuntimeOptions(runtimeOptions)
  return {
    driver: options.driver,
    name: "default",
    options: runtimeOptions,
  }
}

function renderEmailDefinitionModule(
  definition: GeneratedEmailDefinition,
): string {
  return [
    `import definition from ${JSON.stringify(definition.handler)}`,
    "export { definition }",
    `export { outboxRuntimeId } from ${JSON.stringify(definition.handler)}`,
    "export default definition",
    "",
  ].join("\n")
}

/** Development outbox that wraps the provider driver. Only `vite dev` passes it. */
interface GeneratedEmailOutbox extends ResolvedEmailOutboxOptions {
  import: string
  runtimeId: string
}

function renderConfiguredEmailDefinitionModule(
  definition: GeneratedEmailDefinition,
  driverImport: string,
  runtimeEnvImport: string,
  cloudflare: boolean,
  cloudflareEmail: boolean,
  outbox?: GeneratedEmailOutbox,
): string {
  return [
    `import createDriver from ${JSON.stringify(driverImport)}`,
    `import { resolveServerEnv } from ${JSON.stringify(runtimeEnvImport)}`,
    ...(outbox ? [`import { createEmailDevOutboxDriver } from ${JSON.stringify(outbox.import)}`] : []),
    ...(cloudflare ? ["import { env as vitehubEmailEnv } from \"cloudflare:workers\""] : []),
    ...(cloudflareEmail ? ["import { EmailMessage } from \"cloudflare:email\""] : []),
    "",
    `const registry = JSON.parse(${JSON.stringify(JSON.stringify(definition.options))})`,
    "const createProviderDriver = () => {",
    `  const options = resolveServerEnv(registry${cloudflare ? ", { env: vitehubEmailEnv }" : ""})`,
    `  return createDriver(${cloudflareEmail
      ? `{ ...${renderResolvedOptions(definition.options, "options")}, binding: vitehubEmailEnv.EMAIL, EmailMessage }`
      : renderResolvedOptions(definition.options, "options")})`,
    "}",
    `export const outboxRuntimeId = ${JSON.stringify(outbox?.runtimeId ?? "disabled")}`,
    "export const definition = {",
    outbox
      ? `  driver: () => createEmailDevOutboxDriver({ deliver: ${outbox.deliver}, driver: createProviderDriver, limit: ${outbox.limit}, provider: ${JSON.stringify(definition.driver)}, runtimeId: ${JSON.stringify(outbox.runtimeId)} }),`
      : "  driver: createProviderDriver,",
    "}",
    "export default definition",
    "",
  ].join("\n")
}

function resolveHosting(options: InternalEmailVitePluginOptions, config: Record<string, unknown>): string | undefined {
  const nitro = isRecord(config.nitro) ? config.nitro : {}
  const preset = typeof nitro.preset === "string" ? nitro.preset : undefined
  return preset ?? options.hosting ?? process.env.NITRO_PRESET ?? process.env.SERVER_PRESET ?? process.env.VITEHUB_HOSTING
}

function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}

function configureNitroCloudflareWorkers(config: Record<string, unknown>, email: boolean): void {
  const nitro = isRecord(config.nitro) ? config.nitro : {}
  const rollupConfig = isRecord(nitro.rollupConfig) ? nitro.rollupConfig : {}
  const cloudflare = isRecord(nitro.cloudflare) ? nitro.cloudflare : {}
  const wrangler = isRecord(cloudflare.wrangler) ? cloudflare.wrangler : {}
  const sendEmail = Array.isArray(wrangler.send_email) ? [...wrangler.send_email] : []
  if (email && !sendEmail.some(binding => isRecord(binding) && binding.name === "EMAIL")) sendEmail.push({ name: "EMAIL" })
  config.nitro = {
    ...nitro,
    cloudflare: {
      ...cloudflare,
      nodeCompat: true,
      wrangler: {
        ...wrangler,
        ...(sendEmail.length ? { send_email: sendEmail } : {}),
      },
    },
    rollupConfig: {
      ...rollupConfig,
      external: email
        ? mergeNitroExternal(mergeNitroExternal(rollupConfig.external, "cloudflare:workers"), "cloudflare:email")
        : mergeNitroExternal(rollupConfig.external, "cloudflare:workers"),
    },
  }
}

const emailTemplatePrefix = "#vitehub/emails/"

function emailTemplateName(id: string): string | undefined {
  if (!id.startsWith(emailTemplatePrefix)) return
  const name = id.slice(emailTemplatePrefix.length)
  const segments = name.split("/")
  if (!name || name.includes("\\") || name.includes("?") || name.includes("#") || name.endsWith(".md") || segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw emailErrorDiagnostics.EMAIL_INVALID_TEMPLATE({ id })
  }
  return name
}

export function resolveEmailTemplateModulePath(root: string, id: string): string | undefined {
  const name = emailTemplateName(id)
  return name ? resolve(root, `${encodeURIComponent(name)}.mjs`) : undefined
}

function exactIdPattern(id: string): RegExp {
  return new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function renderEmailTemplateTypes(names: string[]): string {
  return names.map(name => [
    `declare module ${JSON.stringify(`${emailTemplatePrefix}${name}`)} {`,
    "  const render: (data?: Record<string, unknown>) => Promise<string>",
    "  export default render",
    "}",
  ].join("\n")).join("\n\n") + (names.length ? "\n" : "")
}

async function materializeEmailTemplates(templates: EmailTemplate[], outputRoot: string, rootDir: string): Promise<void> {
  const stagingRoot = `${outputRoot}.staging`
  const backupRoot = `${outputRoot}.backup`
  await rm(stagingRoot, { force: true, recursive: true })
  await rm(backupRoot, { force: true, recursive: true })
  await mkdir(stagingRoot, { recursive: true })
  for (const { file, name } of templates) {
    const target = resolve(stagingRoot, `${encodeURIComponent(name)}.mjs`)
    const entry = `${target}.entry.mjs`
    await writeFileIfChanged(entry, `export { default } from ${JSON.stringify(`/@fs/${file}?markdown-template`)}\n`)
    try {
      await bundleEsmEntry(entry, target, { format: "esm", platform: "node", rootDir })
    }
    finally {
      await rm(entry, { force: true })
    }
  }
  let replaced = false
  try {
    await rename(outputRoot, backupRoot)
    replaced = true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  try {
    await rename(stagingRoot, outputRoot)
  }
  catch (error) {
    if (replaced) await rename(backupRoot, outputRoot)
    throw error
  }
  await rm(backupRoot, { force: true, recursive: true })
}

export function hubEmail(options: EmailVitePluginOptions): EmailVitePlugin {
  if (!options || typeof options !== "object") {
    throw emailErrorDiagnostics.EMAIL_UNKNOWN_DRIVER()
  }
  const internalOptions = options as EmailVitePluginOptions & InternalEmailVitePluginOptions
  const configured = configuredDefinition(options)
  const driverImport = resolveDriverImport(configured.driver)
  const outbox = resolveOutboxOptions(options.outbox)
  const outboxRuntimeId = randomUUID()
  const importBase = internalOptions.importBase ?? "@vite-hub/email"
  let command: "build" | "serve" | undefined
  let resolvedConfig: ResolvedConfig | undefined
  const runtimeEnvImport = internalOptions.runtimeEnvImport
    ?? resolve(dirname(resolvePackageImport("@vite-hub/env/package.json")), "dist/server.js")
  let cloudflare = false
  let vercel = false
  const cloudflareEmail = configured.driver === "cloudflare-email"
  let definition: GeneratedEmailDefinition | undefined
  let serverDirs: string[] | undefined
  let templatesRoots = [resolve(process.cwd(), "server", "emails")]
  let materializedRoot = resolve(process.cwd(), ".vitehub", "email", "templates")
  let projectRoot = process.cwd()
  let buildStarted = false
  let materialized = false
  let materializationRequested = false
  let providerImportAliases: Promise<Record<string, string>> | undefined
  let watchFiles = new Set<string>()

  const updateTemplateRoots = (nextProjectRoot: string, nextServerDirs = serverDirs) => {
    const nextTemplatesRoots = (nextServerDirs ?? [resolve(nextProjectRoot, "server")]).map(directory => resolve(directory, "emails"))
    if (nextProjectRoot !== projectRoot || nextTemplatesRoots.join("\0") !== templatesRoots.join("\0")) materialized = false
    projectRoot = nextProjectRoot
    templatesRoots = nextTemplatesRoots
    materializedRoot = resolve(projectRoot, ".vitehub", "email", "templates")
  }

  const prepareTypes = async (options: { materialize?: boolean, projectRoot: string, serverDirs?: string[] }) => {
    if (options.materialize) materializationRequested = true
    updateTemplateRoots(options.projectRoot, options.serverDirs)
    const templates = await discoverEmailTemplates(templatesRoots)
    const files = templates.map(template => template.file)
    const names = templates.map(template => template.name)
    await writeFileIfChanged(resolve(options.projectRoot, ".vitehub", "types", "email.d.ts"), renderEmailTemplateTypes(names))
    const nextWatchFiles = new Set([...watchFiles, ...files])
    watchFiles = nextWatchFiles
    if (options.materialize) {
      await materializeEmailTemplates(templates, materializedRoot, options.projectRoot)
      materialized = true
    }
    return Object.fromEntries(names
      .toSorted((left, right) => right.length - left.length || left.localeCompare(right))
      .map(name => [name, resolveEmailTemplateModulePath(materializedRoot, `${emailTemplatePrefix}${name}`)!]))
  }
  const prepareTypesOnce = async () => {
    await prepareTypes({ materialize: (materializationRequested || cloudflare || vercel) && !materialized, projectRoot, serverDirs })
  }

  return {
    name: EMAIL_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getDefinition: () => definition,
      prepareTypes,
    },
    vitehub: {
      cli: async () => {
        const { createEmailCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        return createEmailCliContributor({ templateRoots: () => templatesRoots })
      },
      providerOutput: {
        getImportAliases(): Promise<Record<string, string>> {
          providerImportAliases ??= prepareTypes({ materialize: true, projectRoot, serverDirs }).then(templates => ({
            ...(definition ? { [EMAIL_DEFINITION_ID]: definition.handler } : {}),
            ...Object.fromEntries(Object.entries(templates).map(([name, replacement]) => [`${emailTemplatePrefix}${name}`, replacement])),
          })).finally(() => {
            providerImportAliases = undefined
          })
          return providerImportAliases
        },
      },
    },
    async config(config, env) {
      // Nuxt replays this hook with the host command. Tests and older callers can omit `env`, which means build.
      command = env?.command
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const configRecord = config as Record<string, unknown>
      const hosting = getHostingProvider(resolveHosting(internalOptions, configRecord))
      cloudflare = hosting === "cloudflare"
      if (cloudflareEmail && !cloudflare) {
        throw emailErrorDiagnostics.EMAIL_HOST_UNSUPPORTED()
      }
      vercel = hosting === "vercel"
        || internalOptions.workflowProvider === "vercel"
        || (isRecord(configRecord.workflow) && configRecord.workflow.provider === "vercel")
      updateTemplateRoots(resolveViteHubProjectRoot(config.root ?? process.cwd()))
      if (cloudflare) configureNitroCloudflareWorkers(config as Record<string, unknown>, cloudflareEmail)
      if (command === "serve") {
        configRecord.nitro = await addNitroEmailDevHandler(configRecord.nitro, projectRoot, importBase, outbox !== undefined, outboxRuntimeId)
      }
      const emailTemplatePaths = cloudflare || vercel
        ? await prepareTypes({ materialize: true, projectRoot, serverDirs })
        : {}
      return {
        ...(cloudflare || vercel
          ? { resolve: { alias: [
              { find: EMAIL_DEFINITION_ID, replacement: resolve(resolveViteHubGeneratedRoot(config), "email/definition.mjs") },
              ...Object.entries(emailTemplatePaths).map(([name, replacement]) => ({
                find: exactIdPattern(`${emailTemplatePrefix}${name}`),
                replacement,
              })),
            ] } }
          : {}),
        ssr: { noExternal: noExternalAddition(config.ssr?.noExternal) },
      }
    },
    async configResolved(config) {
      resolvedConfig = config
      updateTemplateRoots(resolveViteHubProjectRoot(config.root))
      await prepareTypesOnce()
      definition = {
        ...configured,
        handler: resolve(resolveViteHubGeneratedRoot(config), "email/definition.mjs"),
      }
      const entry = definition.handler.replace(/\.mjs$/, ".entry.mjs")
      // The outbox is added only for `vite dev`. A build never imports the outbox module.
      const devOutbox = command === "serve" && outbox ? { ...outbox, import: resolveOutboxImport(), runtimeId: outboxRuntimeId } : undefined
      await writeFileIfChanged(entry, renderConfiguredEmailDefinitionModule(definition, driverImport, runtimeEnvImport, cloudflare, cloudflare && cloudflareEmail, devOutbox))
      try {
        await bundleEsmEntry(entry, definition.handler, {
          define: resolveViteHubBundleDefines(config),
          external: cloudflare ? ["node:*", "cloudflare:workers", ...(cloudflareEmail ? ["cloudflare:email"] : [])] : undefined,
          format: "esm",
          minifyWhitespace: true,
          platform: cloudflare ? "neutral" : "node",
          rootDir: config.root,
        })
      }
      finally {
        await rm(entry, { force: true })
      }
    },
    async buildStart() {
      await prepareTypes({ materialize: (materializationRequested || cloudflare || vercel) && (buildStarted || !materialized), projectRoot, serverDirs })
      buildStarted = true
      for (const templatesRoot of templatesRoots) this.addWatchFile(templatesRoot)
      for (const file of watchFiles) this.addWatchFile(file)
    },
    closeBundle() {
      disposeEmailOutbox(outboxRuntimeId)
    },
    configureServer(server) {
      registerEmailDevEndpoint(server, {
        nitroBaseURL: () => {
          // SAFETY: Vite keeps unknown user config keys on the resolved config. Nitro reads the same `nitro` key.
          const baseURL = (resolvedConfig as (ResolvedConfig & { nitro?: { baseURL?: unknown } }) | undefined)?.nitro?.baseURL
          return v.is(v.string(), baseURL) ? baseURL : process.env.NITRO_APP_BASE_URL
        },
      })
      server.watcher.add(templatesRoots)
      server.watcher.add([...watchFiles])
      let refreshPending = false
      let refreshPromise: Promise<void> | undefined
      const refresh = async () => {
        let refreshed = false
        do {
          refreshPending = false
          try {
            await prepareTypes({ materialize: materializationRequested || cloudflare || vercel, projectRoot, serverDirs })
            refreshed = true
          }
          catch (error) {
            refreshed = false
            server.config.logger.error(String(error))
          }
          finally {
            server.watcher.add([...watchFiles])
          }
        } while (refreshPending)
        if (refreshed) {
          for (const module of server.moduleGraph.idToModuleMap.values()) {
            if (module.id) {
              const modulePath = module.id.split("?", 1)[0]
              const queriedSource = normalizeTemplateModulePath(module.id)
              if (isInside(materializedRoot, modulePath) || watchFiles.has(queriedSource) || watchFiles.has(modulePath) || [...watchFiles].some(file => normalizeWatchedPath(file) === normalizeWatchedPath(queriedSource) || normalizeWatchedPath(file) === normalizeWatchedPath(modulePath))) {
                server.moduleGraph.invalidateModule(module)
              }
            }
          }
          server.ws.send({ type: "full-reload" })
        }
      }
      const refreshForFile = (file: string) => {
        if (!templatesRoots.some(root => isInside(root, file)) && !watchFiles.has(file)) return
        refreshPending = true
        refreshPromise ??= refresh().finally(() => {
          refreshPromise = undefined
        })
      }
      server.watcher.on("add", refreshForFile)
      server.watcher.on("change", refreshForFile)
      server.watcher.on("unlink", refreshForFile)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: noExternalAddition(config.resolve?.noExternal) },
      }
    },
    resolveId(id) {
      if (id === EMAIL_DEFINITION_ID) return resolvedEmailDefinitionId
      const name = emailTemplateName(id)
      if (name) return (async () => {
        for (const templatesRoot of templatesRoots) {
          const file = resolve(templatesRoot, `${name}.md`)
          try {
            if ((await stat(file)).isFile()) return `/@fs/${file}?markdown-template`
          }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
      })()
    },
    load(id) {
      if (id === resolvedEmailDefinitionId && definition) {
        return renderEmailDefinitionModule(definition)
      }
      if (id.endsWith("?markdown-template")) {
        const file = normalizeTemplateModulePath(id)
        if (![...watchFiles].some(watched => normalizeWatchedPath(watched) === normalizeWatchedPath(file))) return
        return import("node:fs/promises").then(({ readFile }) => readFile(file, "utf8")).then(template =>
          `import { renderMarkdownTemplate } from ${JSON.stringify(resolvePackageImport("@vite-hub/markdown-template"))}\nconst template = ${JSON.stringify(template)}\nexport default (data) => renderMarkdownTemplate(template, { data })\n`,
        )
      }
    },
  }
}
