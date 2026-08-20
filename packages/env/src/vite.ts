import { rm, stat } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

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
import { env } from "./core/declarations.ts"
import { createRuntimeRegistry, createSourceContext, resolveBuildConfig, resolveEnvEntries, validateEnvConfigShape } from "./core/resolve.ts"

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
  let serverRegistry: EnvRuntimeRegistry = {}
  let diagnosticsText: string | undefined
  const serverRegistryHandlers = new Set<(registry: EnvRuntimeRegistry, config: UserConfig) => void>()
  const getPublicEnv = () => buildPublicConfig
  const getServerEnvRegistry = () => serverRegistry
  const createServerEnvRegistry = (declarations: EnvRuntimeConfigOptions | undefined) => createRuntimeRegistry(declarations, { prefix: options.prefix })
  const resolveProjectRoot = (viteRoot: string) => resolveViteHubProjectRoot(resolve(viteRoot), { projectRoot: options.projectRoot })
  const runtimeImports = resolveRuntimeImports(options.runtimeImports)

  return {
    name: ENV_VITE_PLUGIN_NAME,
    api: {
      createServerEnvRegistry,
      getPublicEnv,
      getServerEnvRegistry,
      onServerEnvRegistry: handler => serverRegistryHandlers.add(handler),
      resolveProjectRoot,
    },
    async config(config, env) {
      const envConfig = (config as UserConfig & EnvViteUserConfig).env
      validateEnvConfigShape(envConfig, "vite")
      if (!envConfig) {
        return
      }

      const root = resolveProjectRoot(config.root || process.cwd())
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
      await refreshEnvGeneratedFiles(projectRoot, packageRoot, buildPublicConfig, serverRegistry, runtimeImports)
    },
    load(id) {
      if (id === RESOLVED_PUBLIC_ID) {
        return createPublicEnvModule(buildPublicConfig)
      }
      if (id === RESOLVED_SERVER_ID) {
        return createServerEnvModule(serverRegistry, runtimeImports)
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

function legacyEnvAmbientTypesPaths(root: string) {
  return [
    resolve(root, ".vitehub", "env", "vite.d.ts"),
  ]
}

async function refreshEnvGeneratedFiles(
  root: string,
  packageRoot: string | undefined,
  publicConfig: Record<string, unknown>,
  serverRegistry: EnvRuntimeRegistry,
  runtimeImports: Required<EnvRuntimeImportSpecifiers>,
): Promise<void> {
  await Promise.all([
    ...(packageRoot && packageRoot !== root
      ? [
          ...packageEnvModuleWrites(packageRoot, publicConfig, serverRegistry, runtimeImports),
          writeFileIfChanged(
            viteHubEnvAmbientTypesPath(packageRoot),
            createAmbientTypesReference(packageRoot, root),
          ),
        ]
      : []),
    writeFileIfChanged(viteHubEnvAmbientTypesPath(root), createViteTypes(publicConfig, serverRegistry, runtimeImports)),
    writeFileIfChanged(viteHubEnvPublicModulePath(root), createPublicEnvModule(publicConfig)),
    writeFileIfChanged(viteHubEnvPublicModuleTypesPath(root), createPublicEnvModuleTypes(publicConfig)),
    writeFileIfChanged(viteHubEnvServerModulePath(root), createServerEnvModule(serverRegistry, runtimeImports)),
    writeFileIfChanged(viteHubEnvServerModuleTypesPath(root), createServerEnvModuleTypes(serverRegistry, runtimeImports)),
    ...legacyEnvAmbientTypesPaths(root).map(path => rm(path, { force: true })),
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
): Promise<void>[] {
  return [
    writeFileIfChanged(viteHubEnvPublicModulePath(root), createPublicEnvModule(publicConfig)),
    writeFileIfChanged(viteHubEnvPublicModuleTypesPath(root), createPublicEnvModuleTypes(publicConfig)),
    writeFileIfChanged(viteHubEnvServerModulePath(root), createServerEnvModule(serverRegistry, runtimeImports)),
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

function createPublicEnvModuleTypes(publicConfig: Record<string, unknown>): string {
  return [
    "export interface PublicEnv {",
    ...createPublicTypeFields(publicConfig, 2),
    "}",
    "export const publicEnv: PublicEnv",
    "export function usePublicEnv(): PublicEnv",
    "",
  ].join("\n")
}

function createServerEnvModule(serverRegistry: EnvRuntimeRegistry, runtimeImports: Required<EnvRuntimeImportSpecifiers>): string {
  return [
    `import { resolveServerEnv } from ${JSON.stringify(runtimeImports.server)};`,
    `const registry = ${JSON.stringify(serverRegistry, null, 2)};`,
    "export function useServerEnv(event) { return resolveServerEnv(registry, event); }",
    "export async function runWithServerEnv(event, callback) { return await callback(useServerEnv(event)); }",
    "",
  ].join("\n")
}

function createServerEnvModuleTypes(serverRegistry: EnvRuntimeRegistry, runtimeImports: Required<EnvRuntimeImportSpecifiers>): string {
  return [
    `import type { SecretEnv } from ${JSON.stringify(runtimeImports.secret)}`,
    "",
    "export interface ServerEnv {",
    ...createServerTypeFields(serverRegistry, 2),
    "}",
    "export function useServerEnv(event?: unknown): ServerEnv",
    "export function runWithServerEnv<T>(event: unknown, callback: (env: ServerEnv) => T | Promise<T>): Promise<T>",
    "",
  ].join("\n")
}

function createViteTypes(
  publicConfig: Record<string, unknown>,
  serverRegistry: EnvRuntimeRegistry,
  runtimeImports: Required<EnvRuntimeImportSpecifiers>,
): string {
  return [
    "declare module \"#vitehub/env/public\" {",
    "  export interface PublicEnv {",
    ...createPublicTypeFields(publicConfig, 4),
    "  }",
    "  export const publicEnv: PublicEnv",
    "  export function usePublicEnv(): PublicEnv",
    "}",
    "declare module \"#vitehub/env/server\" {",
    "  export interface ServerEnv {",
    ...createServerTypeFields(serverRegistry, 4, `import(${JSON.stringify(runtimeImports.secret)}).SecretEnv`),
    "  }",
    "  export function useServerEnv(event?: unknown): ServerEnv",
    "  export function runWithServerEnv<T>(event: unknown, callback: (env: ServerEnv) => T | Promise<T>): Promise<T>",
    "}",
    "",
  ].join("\n")
}

function createPublicTypeFields(publicConfig: Record<string, unknown>, indent: number): string[] {
  const prefix = " ".repeat(indent)
  return Object.entries(publicConfig).map(([key, value]) => `${prefix}${JSON.stringify(key)}: ${typeof value}`)
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
  if (isEnvEntry(value)) return value.secret ? `${secretType}<string>` : "string"

  const fields = createServerTypeFields(value as EnvRuntimeRegistry, indent + 2, secretType)
  if (!fields.length) return "Record<string, never>"
  const prefix = " ".repeat(indent)
  return `{\n${fields.join("\n")}\n${prefix}}`
}

function isOptionalServerValue(value: EnvRuntimeRegistryValue): boolean {
  return isEnvEntry(value) && !value.required && typeof value.default === "undefined"
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
    && typeof record.required === "boolean"
    && typeof record.secret === "boolean"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

declare module "vite" {
  interface UserConfig {
    env?: EnvViteConfigOptions
  }
}
