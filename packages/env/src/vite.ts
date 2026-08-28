import { stat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import {
  createViteHubEnvImportAliases,
  resolveViteHubProjectRoot,
  VITEHUB_ENV_PUBLIC_ID,
  VITEHUB_ENV_SERVER_ID,
  viteHubEnvAmbientTypesPath,
  viteHubEnvPublicModulePath,
  viteHubEnvPublicModuleTypesPath,
  viteHubEnvServerModulePath,
  viteHubEnvServerModuleTypesPath,
} from "@vite-hub/internal/build/vite"
import { loadEnv } from "vite"

import { formatDiagnostics } from "./core/diagnostics.ts"
import { env, isDefaultStringEnvVariable } from "./core/declarations.ts"
import { createRuntimeRegistry, createSourceContext, resolveBuildConfig, resolveEnvEntries, validateEnvConfigShape } from "./core/resolve.ts"
import { parseSchema } from "./schema.ts"

export { createRuntimeRegistry as createRuntimeEnvRegistry } from "./core/resolve.ts"

import type {
  EnvIntegrationOptions,
  EnvRuntimeConfigOptions,
  EnvRuntimeImportSpecifiers,
  EnvRuntimeRegistry,
  EnvRuntimeRegistryValue,
  EnvViteConfigOptions,
  EnvViteUserConfig,
} from "./types.ts"
import type { Plugin, UserConfig } from "vite"

export const ENV_VITE_PLUGIN_NAME = "@vite-hub/env/vite"
export const ENV_PUBLIC_ID: typeof VITEHUB_ENV_PUBLIC_ID = VITEHUB_ENV_PUBLIC_ID
export const ENV_SERVER_ID: typeof VITEHUB_ENV_SERVER_ID = VITEHUB_ENV_SERVER_ID

const RESOLVED_PUBLIC_ID = `\0${ENV_PUBLIC_ID}`
const RESOLVED_SERVER_ID = `\0${ENV_SERVER_ID}`
const defaultRuntimeImports = {
  secret: "@vite-hub/env/secret",
  server: "@vite-hub/env/server",
}

export { env }

export interface EnvVitePluginAPI {
  createServerEnvRegistry: (declarations: EnvRuntimeConfigOptions | undefined) => EnvRuntimeRegistry
  getPublicEnv: () => Record<string, unknown>
  getServerEnvRegistry: () => EnvRuntimeRegistry
  onServerEnvRegistry: (handler: (registry: EnvRuntimeRegistry, config: UserConfig) => void) => void
  prepareTypes: (config: EnvViteConfigOptions | undefined, viteRoot: string) => Promise<void>
  resolveProjectRoot: (viteRoot: string) => string
}

export type EnvVitePlugin = Plugin & { api: EnvVitePluginAPI }

export interface EnvGeneratedPathOptions {
  projectRoot?: string
  relativeTo?: string
}

export function createEnvImportAliases(options: EnvGeneratedPathOptions = {}): Record<string, string> {
  return createViteHubEnvImportAliases(resolveEnvProjectRoot(options))
}

export function createEnvTypeScriptPaths(options: EnvGeneratedPathOptions = {}): Record<string, string[]> {
  const root = resolveEnvProjectRoot(options)
  const toTypeScriptPath = (path: string) => stripModuleExtension(options.relativeTo ? relative(resolve(options.relativeTo), path) : path)
  return {
    [ENV_PUBLIC_ID]: [toTypeScriptPath(viteHubEnvPublicModulePath(root))],
    [ENV_SERVER_ID]: [toTypeScriptPath(viteHubEnvServerModulePath(root))],
  }
}

export function hubEnv(options: EnvIntegrationOptions = {}): EnvVitePlugin {
  let buildPublicConfig: Record<string, unknown> = {}
  let providerModules: Record<string, string> = {}
  let serverRegistry: EnvRuntimeRegistry = {}
  let diagnosticsText: string | undefined
  const serverRegistryHandlers = new Set<(registry: EnvRuntimeRegistry, config: UserConfig) => void>()
  const getPublicEnv = () => buildPublicConfig
  const getServerEnvRegistry = () => serverRegistry
  const createServerEnvRegistry = (declarations: EnvRuntimeConfigOptions | undefined) => createRuntimeRegistry(declarations, { prefix: options.prefix })
  const resolveProjectRoot = (viteRoot: string) => resolveViteHubProjectRoot(resolve(viteRoot), { projectRoot: options.projectRoot })
  const runtimeImports = resolveRuntimeImports(options.runtimeImports)
  const prepareTypes = async (config: EnvViteConfigOptions | undefined, viteRoot: string) => {
    const root = resolveProjectRoot(viteRoot)
    const packageRoot = await resolvePackageRoot(viteRoot, root)
    const registry = createRuntimeRegistry(config?.server, { prefix: options.prefix })
    assertConfiguredProviders(registry, resolveProviderModules(options.providers, root))
    await prepareEnvGeneratedTypes(root, packageRoot, config?.public, registry, runtimeImports)
  }

  return {
    name: ENV_VITE_PLUGIN_NAME,
    api: {
      createServerEnvRegistry,
      getPublicEnv,
      getServerEnvRegistry,
      onServerEnvRegistry: handler => serverRegistryHandlers.add(handler),
      prepareTypes,
      resolveProjectRoot,
    },
    async config(config, env) {
      const envConfig = (config as UserConfig & EnvViteUserConfig).env
      validateEnvConfigShape(envConfig, "vite")
      const root = resolveProjectRoot(config.root || process.cwd())
      providerModules = resolveProviderModules(options.providers, root)
      if (!envConfig) {
        serverRegistry = {}
        for (const handler of serverRegistryHandlers) handler(serverRegistry, config)
        return
      }

      const loadedEnv = loadEnv(env.mode, root, "")
      const context = createSourceContext({
        env: { ...loadedEnv, ...process.env },
        mode: "build",
        rootDir: root,
      })

      const publicResult = await resolveEnvEntries(envConfig.public, {
        context,
        exposure: "build public",
        prefix: options.prefix,
        section: "env.public",
        timing: "Vite config/dev/build",
      })
      const defineResult = await resolveBuildConfig(envConfig.define, {
        context,
        exposure: "compile-time replacement",
        prefix: options.prefix,
        section: "env.define",
        timing: "Vite transform/build",
      })

      buildPublicConfig = Object.fromEntries(publicResult.entries.map(entry => [entry.key, entry.value]))
      serverRegistry = createServerEnvRegistry(envConfig.server)
      assertConfiguredProviders(serverRegistry, providerModules)
      for (const handler of serverRegistryHandlers) handler(serverRegistry, config)
      diagnosticsText = formatDiagnostics([...publicResult.diagnostics, ...defineResult.diagnostics], options.diagnostics)

      return {
        define: {
          ...Object.fromEntries(Object.entries(defineResult.values).map(([key, value]) => [key, JSON.stringify(value)])),
          ...config.define,
        },
      }
    },
    async configResolved(config) {
      if (diagnosticsText) {
        config.logger.info(diagnosticsText)
      }
      const projectRoot = resolveProjectRoot(config.root)
      const packageRoot = await resolvePackageRoot(config.root, projectRoot)
      await refreshEnvGeneratedFiles(projectRoot, packageRoot, buildPublicConfig, serverRegistry, runtimeImports, providerModules)
    },
    load(id) {
      if (id === RESOLVED_PUBLIC_ID) {
        return createPublicEnvModule(buildPublicConfig)
      }
      if (id === RESOLVED_SERVER_ID) {
        return createServerEnvModule(serverRegistry, runtimeImports, providerModules)
      }
    },
    resolveId: {
      order: "pre",
      handler(id) {
        if (id === ENV_PUBLIC_ID) {
          return RESOLVED_PUBLIC_ID
        }
        if (id === ENV_SERVER_ID) {
          return RESOLVED_SERVER_ID
        }
      },
    },
    transform(code) {
      if (!code.includes("/* @vitehub-env */") || !code.includes(ENV_SERVER_ID)) return
      return code.replace(
        /\/\* @vite-ignore \*\/\s*\/\* @vitehub-env \*\/\s*[\w$]+/g,
        JSON.stringify(ENV_SERVER_ID),
      )
    },
  }
}

async function prepareEnvGeneratedTypes(
  root: string,
  packageRoot: string | undefined,
  publicConfig: EnvViteConfigOptions["public"],
  serverRegistry: EnvRuntimeRegistry,
  runtimeImports: Required<EnvRuntimeImportSpecifiers>,
): Promise<void> {
  const publicTypes = createPreparedPublicTypeEntries(publicConfig)
  await Promise.all([
    ...(packageRoot && packageRoot !== root
      ? [
          writeFileIfChanged(viteHubEnvPublicModuleTypesPath(packageRoot), createPublicEnvModuleTypes(publicTypes)),
          writeFileIfChanged(viteHubEnvServerModuleTypesPath(packageRoot), createServerEnvModuleTypes(serverRegistry, runtimeImports)),
          writeFileIfChanged(viteHubEnvAmbientTypesPath(packageRoot), createAmbientTypesReference(packageRoot, root)),
        ]
      : []),
    writeFileIfChanged(viteHubEnvAmbientTypesPath(root), createViteTypes(publicTypes, serverRegistry, runtimeImports)),
    writeFileIfChanged(viteHubEnvPublicModuleTypesPath(root), createPublicEnvModuleTypes(publicTypes)),
    writeFileIfChanged(viteHubEnvServerModuleTypesPath(root), createServerEnvModuleTypes(serverRegistry, runtimeImports)),
  ])
}

function resolveEnvProjectRoot(options: EnvGeneratedPathOptions): string {
  return resolveViteHubProjectRoot(process.cwd(), { projectRoot: options.projectRoot })
}

function stripModuleExtension(path: string): string {
  return path.replace(/\.mjs$/, "")
}

function resolveRuntimeImports(imports: EnvRuntimeImportSpecifiers | undefined): Required<EnvRuntimeImportSpecifiers> {
  return {
    secret: imports?.secret ?? defaultRuntimeImports.secret,
    server: imports?.server ?? defaultRuntimeImports.server,
  }
}

function resolveProviderModules(providers: Record<string, string> | undefined, root: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, specifier] of Object.entries(providers || {})) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new TypeError("[vitehub] Env provider names must start with a letter and contain only letters, numbers, underscores, or hyphens.")
    }
    if (typeof specifier !== "string" || !specifier.trim()) {
      throw new TypeError(`[vitehub] Env provider ${JSON.stringify(name)} requires a non-empty module specifier.`)
    }
    const normalized = specifier.trim()
    output[name] = normalized.startsWith(".") ? resolve(root, normalized) : normalized
  }
  return output
}

function assertConfiguredProviders(registry: EnvRuntimeRegistry, providers: Record<string, string>): void {
  const visit = (value: EnvRuntimeRegistryValue, path: string) => {
    if (!isRecord(value)) return
    if (isProviderEntry(value)) {
      if (!Object.hasOwn(providers, value.source.provider)) {
        throw new TypeError(`[vitehub] ${path} references Env provider ${JSON.stringify(value.source.provider)}, but hubEnv({ providers }) does not configure it.`)
      }
      return
    }
    if (isLiteralEntry(value) || isEnvEntry(value)) return
    for (const [key, child] of Object.entries(value)) visit(child as EnvRuntimeRegistryValue, `${path}.${key}`)
  }
  for (const [key, value] of Object.entries(registry)) visit(value, `env.server.${key}`)
}

async function refreshEnvGeneratedFiles(
  root: string,
  packageRoot: string | undefined,
  publicConfig: Record<string, unknown>,
  serverRegistry: EnvRuntimeRegistry,
  runtimeImports: Required<EnvRuntimeImportSpecifiers>,
  providerModules: Record<string, string>,
): Promise<void> {
  const publicTypes = createPublicTypeEntries(publicConfig)
  await Promise.all([
    ...(packageRoot && packageRoot !== root
      ? [
          ...packageEnvModuleWrites(packageRoot, publicConfig, serverRegistry, runtimeImports, providerModules),
          writeFileIfChanged(
            viteHubEnvAmbientTypesPath(packageRoot),
            createAmbientTypesReference(packageRoot, root),
          ),
        ]
      : []),
    writeFileIfChanged(viteHubEnvAmbientTypesPath(root), createViteTypes(publicTypes, serverRegistry, runtimeImports)),
    writeFileIfChanged(viteHubEnvPublicModulePath(root), createPublicEnvModule(publicConfig)),
    writeFileIfChanged(viteHubEnvPublicModuleTypesPath(root), createPublicEnvModuleTypes(publicTypes)),
    writeFileIfChanged(
      viteHubEnvServerModulePath(root),
      createServerEnvModule(serverRegistry, runtimeImports, providerModules, viteHubEnvServerModulePath(root)),
    ),
    writeFileIfChanged(viteHubEnvServerModuleTypesPath(root), createServerEnvModuleTypes(serverRegistry, runtimeImports)),
  ])
}

function createAmbientTypesReference(packageRoot: string, projectRoot: string): string {
  const target = relative(dirname(viteHubEnvAmbientTypesPath(packageRoot)), viteHubEnvAmbientTypesPath(projectRoot)).replace(/\\/g, "/")
  const specifier = target.startsWith(".") ? target : `./${target}`
  return `/// <reference path=${JSON.stringify(specifier)} />\n`
}

function packageEnvModuleWrites(
  root: string,
  publicConfig: Record<string, unknown>,
  serverRegistry: EnvRuntimeRegistry,
  runtimeImports: Required<EnvRuntimeImportSpecifiers>,
  providerModules: Record<string, string>,
): Promise<void>[] {
  const publicTypes = createPublicTypeEntries(publicConfig)
  return [
    writeFileIfChanged(viteHubEnvPublicModulePath(root), createPublicEnvModule(publicConfig)),
    writeFileIfChanged(viteHubEnvPublicModuleTypesPath(root), createPublicEnvModuleTypes(publicTypes)),
    writeFileIfChanged(
      viteHubEnvServerModulePath(root),
      createServerEnvModule(serverRegistry, runtimeImports, providerModules, viteHubEnvServerModulePath(root)),
    ),
    writeFileIfChanged(viteHubEnvServerModuleTypesPath(root), createServerEnvModuleTypes(serverRegistry, runtimeImports)),
  ]
}

async function resolvePackageRoot(viteRoot: string, projectRoot: string): Promise<string | undefined> {
  const stop = resolve(projectRoot)
  let current = resolve(viteRoot)

  while (true) {
    if (await hasPackageManifest(current)) return current
    if (current === stop) return undefined

    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function hasPackageManifest(root: string): Promise<boolean> {
  try {
    return (await stat(resolve(root, "package.json"))).isFile()
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function createPublicEnvModule(publicConfig: Record<string, unknown>): string {
  return [
    `const publicEnv = ${JSON.stringify(publicConfig, null, 2)};`,
    "export function usePublicEnv() { return publicEnv; }",
    "export { publicEnv };",
    "",
  ].join("\n")
}

function createPublicEnvModuleTypes(publicTypes: Record<string, string>): string {
  return [
    "export interface PublicEnv {",
    ...createPublicTypeFields(publicTypes, 2),
    "}",
    "export const publicEnv: PublicEnv",
    "export function usePublicEnv(): PublicEnv",
    "",
  ].join("\n")
}

function createServerEnvModule(
  serverRegistry: EnvRuntimeRegistry,
  runtimeImports: Required<EnvRuntimeImportSpecifiers>,
  providerModules: Record<string, string>,
  outputPath?: string,
): string {
  const referenced = referencedProviderNames(serverRegistry)
  const providers = Object.entries(providerModules).filter(([name]) => referenced.has(name))
  return [
    `import { inspectServerEnv as inspectRegistry, loadServerEnv as loadRegistry, resolveServerEnv } from ${JSON.stringify(runtimeImports.server)};`,
    ...providers.map(([, specifier], index) => `import envProvider${index} from ${JSON.stringify(providerImportSpecifier(specifier, outputPath))};`),
    `const registry = ${JSON.stringify(serverRegistry, null, 2)};`,
    `const providers = Object.fromEntries([${providers.map(([name], index) => `[${JSON.stringify(name)}, envProvider${index}]`).join(", ")}]);`,
    "export function useServerEnv(event) { return resolveServerEnv(registry, event); }",
    "export async function loadServerEnv(event, options) { return await loadRegistry(registry, event, { ...options, providers }); }",
    "export async function inspectServerEnv(event, options) { return await inspectRegistry(registry, event, { ...options, providers }); }",
    "export async function runWithServerEnv(event, callback, options) { return await callback(await loadServerEnv(event, options)); }",
    "",
  ].join("\n")
}

function providerImportSpecifier(specifier: string, outputPath: string | undefined): string {
  const windowsAbsolute = win32.isAbsolute(specifier)
  if (!isAbsolute(specifier) && !windowsAbsolute) return specifier
  if (!outputPath) return specifier.replace(/\\/g, "/")
  const outputIsWindows = win32.isAbsolute(outputPath)
  if (windowsAbsolute !== outputIsWindows) return absoluteProviderImportSpecifier(specifier)
  const target = windowsAbsolute
    ? win32.relative(win32.dirname(outputPath), specifier)
    : relative(dirname(outputPath), specifier)
  if (isAbsolute(target) || win32.isAbsolute(target)) return absoluteProviderImportSpecifier(target)
  const encodedTarget = encodeModulePath(target.replace(/\\/g, "/"))
  return encodedTarget.startsWith(".") ? encodedTarget : `./${encodedTarget}`
}

function absoluteProviderImportSpecifier(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const encoded = encodeModulePath(normalized)
  return /^[A-Za-z]:\//.test(normalized) ? `/${encoded}` : encoded
}

function encodeModulePath(path: string): string {
  return path.split("/").map(segment => /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)).join("/")
}

function referencedProviderNames(registry: EnvRuntimeRegistry): Set<string> {
  const names = new Set<string>()
  const visit = (value: EnvRuntimeRegistryValue) => {
    if (!isRecord(value)) return
    if (isProviderEntry(value)) {
      names.add(value.source.provider)
      return
    }
    if (isLiteralEntry(value) || isEnvEntry(value)) return
    for (const child of Object.values(value)) visit(child as EnvRuntimeRegistryValue)
  }
  for (const value of Object.values(registry)) visit(value)
  return names
}

function createServerEnvModuleTypes(serverRegistry: EnvRuntimeRegistry, runtimeImports: Required<EnvRuntimeImportSpecifiers>): string {
  return [
    `import type { SecretEnv } from ${JSON.stringify(runtimeImports.secret)}`,
    "",
    ...createServerEnvInspectionTypes(0),
    "export interface ServerEnv {",
    ...createServerTypeFields(serverRegistry, 2),
    "}",
    "export function useServerEnv(event?: unknown): ServerEnv",
    ...createReadonlyServerEnvTypes(0),
    "export function loadServerEnv(event?: unknown, options?: { signal?: AbortSignal }): Promise<ReadonlyServerEnv>",
    "export function inspectServerEnv(event?: unknown, options?: { signal?: AbortSignal }): Promise<ServerEnvInspection>",
    "export function runWithServerEnv<T>(event: unknown, callback: (env: ReadonlyServerEnv) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>",
    "",
  ].join("\n")
}

function createViteTypes(
  publicTypes: Record<string, string>,
  serverRegistry: EnvRuntimeRegistry,
  runtimeImports: Required<EnvRuntimeImportSpecifiers>,
): string {
  return [
    "declare module \"#vitehub/env/public\" {",
    "  export interface PublicEnv {",
    ...createPublicTypeFields(publicTypes, 4),
    "  }",
    "  export const publicEnv: PublicEnv",
    "  export function usePublicEnv(): PublicEnv",
    "}",
    "declare module \"#vitehub/env/server\" {",
    ...createServerEnvInspectionTypes(2),
    "  export interface ServerEnv {",
    ...createServerTypeFields(serverRegistry, 4, `import(${JSON.stringify(runtimeImports.secret)}).SecretEnv`),
    "  }",
    "  export function useServerEnv(event?: unknown): ServerEnv",
    ...createReadonlyServerEnvTypes(2),
    "  export function loadServerEnv(event?: unknown, options?: { signal?: AbortSignal }): Promise<ReadonlyServerEnv>",
    "  export function inspectServerEnv(event?: unknown, options?: { signal?: AbortSignal }): Promise<ServerEnvInspection>",
    "  export function runWithServerEnv<T>(event: unknown, callback: (env: ReadonlyServerEnv) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>",
    "}",
    "",
  ].join("\n")
}

function createServerEnvInspectionTypes(indent: number): string[] {
  const prefix = " ".repeat(indent)
  return [
    `${prefix}export interface ServerEnvInspectionEntry {`,
    `${prefix}  masked: boolean`,
    `${prefix}  path?: string`,
    `${prefix}  source: "env" | "literal" | "provider"`,
    `${prefix}  status: "available" | "defaulted" | "error" | "invalid" | "missing"`,
    `${prefix}}`,
    `${prefix}export interface ServerEnvInspection {`,
    `${prefix}  entries: readonly ServerEnvInspectionEntry[]`,
    `${prefix}}`,
  ]
}

function createReadonlyServerEnvTypes(indent: number): string[] {
  const prefix = " ".repeat(indent)
  return [
    `${prefix}export type ReadonlyServerEnv = DeepReadonly<ServerEnv>`,
    `${prefix}type DeepReadonly<T> = T extends (...args: infer TArguments) => infer TResult`,
    `${prefix}  ? (...args: TArguments) => TResult`,
    `${prefix}  : T extends object`,
    `${prefix}    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }`,
    `${prefix}    : T`,
  ]
}

function createPublicTypeEntries(publicConfig: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(publicConfig).map(([key, value]) => [key, typeof value]))
}

function createPreparedPublicTypeEntries(publicConfig: EnvViteConfigOptions["public"]): Record<string, string> {
  return Object.fromEntries(Object.entries(publicConfig ?? {}).map(([key, declaration]) => {
    const parsedDefault = typeof declaration.default === "undefined"
      ? undefined
      : parseSchema(declaration.schema, declaration.default, `env.public.${key}`)
    return [
      key,
      `${declaration.type
        ?? (isDefaultStringEnvVariable(declaration) ? "string" : undefined)
        ?? (parsedDefault === null ? "null" : typeof parsedDefault === "undefined" ? "unknown" : typeof parsedDefault)}${!declaration.required && typeof declaration.default === "undefined" ? " | undefined" : ""}`,
    ]
  }))
}

function createPublicTypeFields(publicTypes: Record<string, string>, indent: number): string[] {
  const prefix = " ".repeat(indent)
  return Object.entries(publicTypes).map(([key, type]) => `${prefix}${JSON.stringify(key)}: ${type}`)
}

function createServerTypeFields(registry: EnvRuntimeRegistry, indent: number, secretType = "SecretEnv"): string[] {
  const prefix = " ".repeat(indent)
  return Object.entries(registry).map(([key, value]) => {
    const optional = isOptionalServerValue(value) ? "?" : ""
    return `${prefix}${JSON.stringify(key)}${optional}: ${serverTypeFor(value, indent, secretType)}`
  })
}

function serverTypeFor(value: EnvRuntimeRegistryValue, indent: number, secretType: string): string {
  if (isLiteralEntry(value)) return literalType(value.value)
  if (isEnvEntry(value) || isProviderEntry(value)) return value.secret ? `${secretType}<string>` : "string"

  const fields = createServerTypeFields(value as EnvRuntimeRegistry, indent + 2, secretType)
  if (!fields.length) return "Record<string, never>"
  const prefix = " ".repeat(indent)
  return `{\n${fields.join("\n")}\n${prefix}}`
}

function isOptionalServerValue(value: EnvRuntimeRegistryValue): boolean {
  return (isEnvEntry(value) || isProviderEntry(value)) && !value.required && typeof value.default === "undefined"
}

function literalType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) {
    const items = value.map(item => literalType(item)).join(", ")
    return `readonly [${items}]`
  }
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value)
    default:
      return "unknown"
  }
}

function isLiteralEntry(value: EnvRuntimeRegistryValue): value is Extract<EnvRuntimeRegistryValue, { kind: "literal" }> {
  if (!isRecord(value)) return false
  const record = value as Record<string, unknown>
  return record.kind === "literal"
}

function isEnvEntry(value: EnvRuntimeRegistryValue): value is Extract<EnvRuntimeRegistryValue, { source: unknown }> {
  if (!isRecord(value)) return false
  const record = value as Record<string, unknown>
  return isRecord(record.source)
    && record.source.kind === "env"
    && typeof record.required === "boolean"
    && typeof record.secret === "boolean"
}

function isProviderEntry(value: EnvRuntimeRegistryValue): value is EnvRuntimeRegistryValue & {
  default?: unknown
  required: boolean
  secret: boolean
  source: { kind: "provider", provider: string }
} {
  if (!isRecord(value)) return false
  const record = value as Record<string, unknown>
  return isRecord(record.source)
    && record.source.kind === "provider"
    && typeof record.source.provider === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

declare module "vite" {
  interface UserConfig {
    env?: EnvViteConfigOptions
  }
}
