import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import { createRuntimeEnvRegistry } from "@vite-hub/env/vite"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNoExternalMerger, isServerEnvironment, resolveViteHubGeneratedRoot, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { extractMarkdownTemplateImportSpecifiers } from "@vite-hub/markdown-template/internal/vite"

import type { EnvRuntimeConfigOptions, EnvRuntimeRegistry } from "@vite-hub/env"
import type { Plugin } from "vite"

export const EMAIL_DEFINITION_ID = "#vitehub/email/definition"
export const EMAIL_VITE_PLUGIN_NAME = "@vite-hub/email/vite"

const resolvedEmailDefinitionId = `\0${EMAIL_DEFINITION_ID}`
const mergeNoExternal = createNoExternalMerger("@vite-hub/email")
const resolvePackageImport = createRequire(import.meta.url).resolve
const unemailDriverPattern = /^unemail\/driver\/[a-z0-9][a-z0-9-]*$/

export type UnemailDriverSpecifier = `unemail/driver/${string}`

interface GeneratedEmailDefinition {
  driver: UnemailDriverSpecifier
  handler: string
  name: "default"
  options: EnvRuntimeRegistry
}

export interface EmailVitePluginOptions {
  driver: UnemailDriverSpecifier
  options?: EnvRuntimeConfigOptions
}

export interface EmailVitePluginAPI {
  getDefinition: () => GeneratedEmailDefinition | undefined
  prepareTypes: (options: { materialize?: boolean, projectRoot: string, serverDirs?: string[] }) => Promise<void>
}

export type EmailVitePlugin = Plugin & { api: EmailVitePluginAPI }

interface InternalEmailVitePluginOptions {
  hosting?: string
  runtimeEnvImport?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRuntimeEnvEntry(value: unknown): value is { default?: unknown, secret: boolean, source: unknown } {
  return isRecord(value) && isRecord(value.source) && typeof value.secret === "boolean"
}

function rejectSecretDefaults(value: unknown, path = "email.options"): void {
  if (isRuntimeEnvEntry(value)) {
    if (value.secret && typeof value.default !== "undefined") {
      throw new TypeError(`[vitehub] Secret Email declaration ${path} cannot have a default because defaults are included in build output.`)
    }
    return
  }
  if (!isRecord(value) || value.kind === "literal") return
  for (const [key, child] of Object.entries(value)) {
    rejectSecretDefaults(child, `${path}.${key}`)
  }
}

function renderResolvedOptions(value: unknown, reference: string): string {
  if (isRuntimeEnvEntry(value)) return value.secret ? `${reference}?.unseal()` : reference
  if (!isRecord(value) || value.kind === "literal") return reference
  return `{ ${Object.entries(value).map(([key, child]) =>
    `${JSON.stringify(key)}: ${renderResolvedOptions(child, `${reference}[${JSON.stringify(key)}]`)}`
  ).join(", ")} }`
}

function resolveDriverImport(driver: string): string {
  if (!unemailDriverPattern.test(driver)) {
    throw new TypeError("[vitehub] Email driver must be an unemail/driver/* package subpath.")
  }
  try {
    return resolvePackageImport(driver)
  }
  catch (error) {
    throw new Error(`[vitehub] Could not resolve Email driver ${JSON.stringify(driver)} from Unemail.`, { cause: error })
  }
}

function configuredDefinition(options: EmailVitePluginOptions): Omit<GeneratedEmailDefinition, "handler"> {
  const runtimeOptions = createRuntimeEnvRegistry(options.options, { path: "email.options" })
  rejectSecretDefaults(runtimeOptions)
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
    "export default definition",
    "",
  ].join("\n")
}

function renderConfiguredEmailDefinitionModule(
  definition: GeneratedEmailDefinition,
  driverImport: string,
  runtimeEnvImport: string,
  cloudflare: boolean,
  cloudflareEmail: boolean,
): string {
  return [
    `import createDriver from ${JSON.stringify(driverImport)}`,
    `import { resolveServerEnv } from ${JSON.stringify(runtimeEnvImport)}`,
    ...(cloudflare ? ["import { env as vitehubEmailEnv } from \"cloudflare:workers\""] : []),
    ...(cloudflareEmail ? ["import { EmailMessage } from \"cloudflare:email\""] : []),
    "",
    `const registry = ${JSON.stringify(definition.options, null, 2)}`,
    "export const definition = {",
    "  driver: () => {",
    `    const options = resolveServerEnv(registry${cloudflare ? ", { env: vitehubEmailEnv }" : ""})`,
    `    return createDriver(${cloudflareEmail
      ? `{ ...${renderResolvedOptions(definition.options, "options")}, binding: vitehubEmailEnv.EMAIL, EmailMessage }`
      : renderResolvedOptions(definition.options, "options")})`,
    "  },",
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
    throw new TypeError(`[vitehub] Invalid Email template ${JSON.stringify(id)}.`)
  }
  return name
}

async function listEmailTemplates(root: string, directory = root): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...await listEmailTemplates(root, path))
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path)
  }
  return files
}

function templateName(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, "/").replace(/\.md$/, "")
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

async function collectEmailTemplateDependencies(files: string[], dependencies: Set<string>): Promise<void> {
  const visit = async (file: string) => {
    const template = await readFile(file, "utf8")
    for (const specifier of extractMarkdownTemplateImportSpecifiers(template)) {
      const dependency = resolve(dirname(file), specifier)
      if (dependencies.has(dependency)) continue
      dependencies.add(dependency)
      await visit(dependency)
    }
  }
  for (const file of files) await visit(file)
}

async function materializeEmailTemplates(templatesRoot: string, outputRoot: string, rootDir: string): Promise<void> {
  const stagingRoot = `${outputRoot}.staging`
  const backupRoot = `${outputRoot}.backup`
  await rm(stagingRoot, { force: true, recursive: true })
  await rm(backupRoot, { force: true, recursive: true })
  await mkdir(stagingRoot, { recursive: true })
  for (const file of await listEmailTemplates(templatesRoot)) {
    const target = resolve(stagingRoot, `${templateName(templatesRoot, file)}.mjs`)
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
    throw new TypeError("[vitehub] Email requires an unemail/driver/* driver.")
  }
  const internalOptions = options as EmailVitePluginOptions & InternalEmailVitePluginOptions
  const configured = configuredDefinition(options)
  const driverImport = resolveDriverImport(configured.driver)
  const runtimeEnvImport = internalOptions.runtimeEnvImport
    ?? resolve(dirname(resolvePackageImport("@vite-hub/env/package.json")), "dist/server.js")
  let cloudflare = false
  let vercel = false
  const cloudflareEmail = configured.driver === "unemail/driver/cloudflare-email"
  let definition: GeneratedEmailDefinition | undefined
  let serverDirs: string[] | undefined
  let templatesRoot = resolve(process.cwd(), "server", "emails")
  let materializedRoot = resolve(process.cwd(), ".vitehub", "email", "templates")
  let projectRoot = process.cwd()
  let buildStarted = false
  let materialized = false
  let materializationRequested = false
  let watchFiles = new Set<string>()

  const prepareTypes = async (options: { materialize?: boolean, projectRoot: string, serverDirs?: string[] }) => {
    if (options.materialize) materializationRequested = true
    const nextTemplatesRoot = resolve(options.serverDirs?.[0] ?? resolve(options.projectRoot, "server"), "emails")
    if (nextTemplatesRoot !== templatesRoot || options.projectRoot !== projectRoot) materialized = false
    projectRoot = options.projectRoot
    templatesRoot = nextTemplatesRoot
    materializedRoot = resolve(options.projectRoot, ".vitehub", "email", "templates")
    const files = await listEmailTemplates(templatesRoot)
    const names = files.map(file => templateName(templatesRoot, file))
    await writeFileIfChanged(resolve(options.projectRoot, ".vitehub", "types", "email.d.ts"), renderEmailTemplateTypes(names))
    if (options.materialize) {
      const nextWatchFiles = new Set(files)
      try {
        await collectEmailTemplateDependencies(files, nextWatchFiles)
        await materializeEmailTemplates(templatesRoot, materializedRoot, options.projectRoot)
      }
      finally {
        watchFiles = nextWatchFiles
      }
      materialized = true
    }
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
    config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const hosting = getHostingProvider(resolveHosting(internalOptions, config as Record<string, unknown>))
      cloudflare = hosting === "cloudflare"
      vercel = hosting === "vercel"
      const nextProjectRoot = resolveViteHubProjectRoot(config.root ?? process.cwd())
      const nextTemplatesRoot = resolve(serverDirs?.[0] ?? resolve(nextProjectRoot, "server"), "emails")
      if (nextProjectRoot !== projectRoot || nextTemplatesRoot !== templatesRoot) materialized = false
      projectRoot = nextProjectRoot
      templatesRoot = nextTemplatesRoot
      materializedRoot = resolve(projectRoot, ".vitehub", "email", "templates")
      if (cloudflare) configureNitroCloudflareWorkers(config as Record<string, unknown>, cloudflareEmail)
      return {
        ...(cloudflare || vercel ? { resolve: { alias: { "#vitehub/emails": materializedRoot } } } : {}),
        ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) },
      }
    },
    async configResolved(config) {
      const nextProjectRoot = resolveViteHubProjectRoot(config.root)
      const nextTemplatesRoot = resolve(serverDirs?.[0] ?? resolve(nextProjectRoot, "server"), "emails")
      if (nextProjectRoot !== projectRoot || nextTemplatesRoot !== templatesRoot) materialized = false
      projectRoot = nextProjectRoot
      templatesRoot = nextTemplatesRoot
      await prepareTypesOnce()
      definition = {
        ...configured,
        handler: resolve(resolveViteHubGeneratedRoot(config), "email/definition.mjs"),
      }
      const entry = definition.handler.replace(/\.mjs$/, ".entry.mjs")
      await writeFileIfChanged(entry, renderConfiguredEmailDefinitionModule(definition, driverImport, runtimeEnvImport, cloudflare, cloudflare && cloudflareEmail))
      try {
        await bundleEsmEntry(entry, definition.handler, {
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
      this.addWatchFile(templatesRoot)
      for (const file of watchFiles) this.addWatchFile(file)
    },
    configureServer(server) {
      server.watcher.add(templatesRoot)
      server.watcher.add([...watchFiles])
      let refreshPending = false
      let refreshPromise: Promise<void> | undefined
      const refresh = async () => {
        let refreshed = false
        do {
          refreshPending = false
          try {
            await prepareTypes({ materialize: materializationRequested || cloudflare || vercel, projectRoot, serverDirs })
            server.watcher.add([...watchFiles])
            refreshed = true
          }
          catch (error) {
            refreshed = false
            server.config.logger.error(String(error))
          }
        } while (refreshPending)
        if (refreshed) server.ws.send({ type: "full-reload" })
      }
      const refreshForFile = (file: string) => {
        if (!isInside(templatesRoot, file) && !watchFiles.has(file)) return
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
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    resolveId(id) {
      if (id === EMAIL_DEFINITION_ID) return resolvedEmailDefinitionId
      const name = emailTemplateName(id)
      if (name) return `/@fs/${resolve(templatesRoot, `${name}.md`)}?markdown-template`
    },
    load(id) {
      if (id === resolvedEmailDefinitionId && definition) {
        return renderEmailDefinitionModule(definition)
      }
    },
  }
}
